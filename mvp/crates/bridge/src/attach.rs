//! The TUI attach channel: a second, standing duplex pipe alongside stdio,
//! handed to bridge only by whatever process spawned it locally. stdio keeps
//! its existing one-line-in/one-line-out control protocol untouched; this fd
//! carries the conversation's own events and requests instead, so the two
//! framings never share a channel. See docs/planning/tui-architecture.md and
//! the "why not overload stdio" discussion it followed from.

use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::UnixStream as StdUnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;
use tokio::sync::Mutex;

/// Shared handle a Publisher clones cheaply per turn; the mutex serialises
/// concurrent tees (query and tool-round tasks can both publish).
pub type AttachHandle = Arc<Mutex<UnixStream>>;

/// Spawn `program` with a socketpair's child end dup'd onto `attach_fd` in
/// the child, in addition to whatever stdio wiring `configure` sets up.
/// Returns the spawned child and the parent's end of the pair.
///
/// # Safety of `pre_exec`
/// The closure runs in the forked child between `fork` and `exec`, where only
/// async-signal-safe calls are permitted (POSIX). `dup2` is on that list;
/// nothing else runs in the closure.
pub fn spawn_with_attach(
    program: &str,
    args: &[&str],
    attach_fd: RawFd,
    configure: impl FnOnce(&mut Command),
) -> std::io::Result<(std::process::Child, UnixStream)> {
    let (parent_end, child_end) = StdUnixStream::pair()?;
    let child_raw = child_end.as_raw_fd();

    let mut cmd = Command::new(program);
    cmd.args(args);
    configure(&mut cmd);

    // SAFETY: dup2 only, between fork and exec — see module doc.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(child_raw, attach_fd) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    let child = cmd.spawn()?;
    drop(child_end); // our copy of the child's fd; the child has its own now
    parent_end.set_nonblocking(true)?;
    let parent_end = UnixStream::from_std(parent_end)?;
    Ok((child, parent_end))
}

/// Bridge's own side: pick up the fd the parent dup'd onto us, if any.
/// `BRIDGE_ATTACH_FD` names it; absence means no local TUI is attached.
pub fn attach_stream() -> Option<UnixStream> {
    let fd: RawFd = std::env::var("BRIDGE_ATTACH_FD").ok()?.parse().ok()?;
    // SAFETY: the parent handed us this fd via dup2 in pre_exec before exec —
    // open and connected for this process's whole lifetime.
    let std_stream = unsafe { StdUnixStream::from_raw_fd(fd) };
    std_stream.set_nonblocking(true).ok()?;
    UnixStream::from_std(std_stream).ok()
}

/// Mirror one published event onto the local TUI's attach stream, framed as
/// a newline-delimited `{ subject, payload }` envelope so the fd carries a
/// self-describing line per event, same as bridge's stdio control lines are
/// one-JSON-object-per-line. Best-effort and silent on failure: NATS is the
/// record regardless, so a full pipe or a gone TUI degrades to "no local
/// mirror", never a lost or blocked publish.
pub async fn tee(attach: &Option<AttachHandle>, subject: &str, payload: &[u8]) {
    let Some(attach) = attach else { return };
    let Ok(payload_str) = std::str::from_utf8(payload) else {
        return;
    };
    // payload is already a complete JSON value (Publisher::event's own
    // serde_json::to_vec) — spliced in verbatim rather than round-tripped
    // through Value, so no serde_json feature flag is needed for this.
    let Ok(subject_json) = serde_json::to_string(subject) else {
        return;
    };
    let line = format!("{{\"subject\":{subject_json},\"payload\":{payload_str}}}\n").into_bytes();
    let mut guard = attach.lock().await;
    let _ = guard.write_all(&line).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Proves the whole mechanism end to end before any bridge logic depends
    /// on it: spawn a plain shell that echoes fd 3 back to itself, write into
    /// our end, read the same bytes back. `sh`'s `<&3`/`>&3` reference the fd
    /// already sitting there from pre_exec's dup2 — no shell-side dup needed.
    #[tokio::test]
    async fn round_trips_bytes_over_the_dupped_fd() {
        let (mut child, mut parent_end) =
            spawn_with_attach("sh", &["-c", "cat <&3 >&3"], 3, |_cmd| {}).expect("spawn with attach fd");

        parent_end.write_all(b"hello over fd 3\n").await.expect("write");

        let mut buf = [0u8; 64];
        let n = parent_end.read(&mut buf).await.expect("read");
        assert_eq!(&buf[..n], b"hello over fd 3\n");

        drop(parent_end); // closes our end; cat sees EOF on fd 3 and exits
        let status = child.wait().expect("child exits");
        assert!(status.success());
    }

    /// Proves the tee's framing without any NATS or bridge process involved —
    /// same discipline as the rest of this repo's tests (only Broker is ever
    /// faked; here there's nothing to fake, just a plain pipe).
    #[tokio::test]
    async fn tee_frames_subject_and_payload_as_one_json_line() {
        let (parent_end, child_end) = UnixStream::pair().expect("unix stream pair");
        let handle: Option<AttachHandle> = Some(Arc::new(Mutex::new(child_end)));

        tee(&handle, "conv.v2.abc.changes.message", br#"{"id":"m1"}"#).await;

        let mut parent_end = parent_end;
        let mut buf = vec![0u8; 256];
        let n = parent_end.read(&mut buf).await.expect("read");
        let line = std::str::from_utf8(&buf[..n]).expect("utf8");
        assert!(line.ends_with('\n'));
        let parsed: serde_json::Value = serde_json::from_str(line.trim_end()).expect("one json line");
        assert_eq!(parsed["subject"], "conv.v2.abc.changes.message");
        assert_eq!(parsed["payload"]["id"], "m1");
    }

    /// A None handle is a true no-op — the tower-only path this touches on
    /// every publish must never block or panic.
    #[tokio::test]
    async fn tee_is_a_no_op_with_no_attach_handle() {
        tee(&None, "conv.v2.abc.changes.message", br#"{"id":"m1"}"#).await;
    }
}
