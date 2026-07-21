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

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::Mutex;

/// Shared handle a Publisher clones cheaply per turn; the mutex serialises
/// concurrent tees and request replies (the write half only — the read half
/// belongs to serve_requests, so a write can never block behind a read).
pub type AttachHandle = Arc<Mutex<OwnedWriteHalf>>;

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

/// The fd is duplex: events and request replies flow down as one JSON line
/// each (events `{subject, payload}`, replies `{id, payload}`), requests
/// flow up as `{id, subject, payload}` — or `{id, upload}` for attachment
/// bytes — and bridge proxies them onto NATS, so an attached client needs
/// no NATS of its own.
///
/// Mirror one published event onto the local TUI's attach stream. Best-effort
/// and silent on failure: NATS is the record regardless, so a full pipe or a
/// gone TUI degrades to "no local mirror", never a lost or blocked publish.
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

async fn reply(out: &AttachHandle, id: &str, payload: serde_json::Value) {
    let line = serde_json::json!({ "id": id, "payload": payload });
    let mut bytes = serde_json::to_vec(&line).expect("json of plain values cannot fail");
    bytes.push(b'\n');
    let mut guard = out.lock().await;
    let _ = guard.write_all(&bytes).await;
}

/// Serve the fd's request direction: each line up is either a NATS request
/// to proxy (`{id, subject, payload}` — say, cancel, answer, anything
/// addressed) or an attachment upload (`{id, upload}` — bytes to the transit
/// object store, the reference block minted back). Bridge is the NATS
/// participant; the attached client never dials the broker. Unintelligible
/// lines with an id are answered (compliance is answering); without one,
/// skipped.
pub async fn serve_requests(
    read: OwnedReadHalf,
    out: AttachHandle,
    client: async_nats::Client,
    attach_bucket: String,
) {
    let mut lines = BufReader::new(read).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(id) = value["id"].as_str().map(str::to_string) else {
            continue;
        };
        if let Some(subject) = value["subject"].as_str().map(str::to_string) {
            let payload = serde_json::to_vec(&value["payload"]).expect("reserialising parsed json");
            match client.request(subject, payload.into()).await {
                Ok(response) => {
                    let payload = serde_json::from_slice::<serde_json::Value>(&response.payload)
                        .unwrap_or_else(|_| serde_json::json!({ "error": "unintelligible reply" }));
                    reply(&out, &id, payload).await;
                }
                Err(e) => reply(&out, &id, serde_json::json!({ "error": e.to_string() })).await,
            }
        } else if value["upload"].is_object() {
            let upload = &value["upload"];
            let outcome = store_upload(&client, &attach_bucket, upload).await;
            match outcome {
                Ok(block) => reply(&out, &id, block).await,
                Err(e) => reply(&out, &id, serde_json::json!({ "error": e.to_string() })).await,
            }
        } else {
            reply(&out, &id, serde_json::json!({ "error": "unsupported" })).await;
        }
    }
    // EOF: the client is gone; stdin's own EOF ends the process.
}

async fn store_upload(
    client: &async_nats::Client,
    bucket: &str,
    upload: &serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let block_type = upload["blockType"].as_str().unwrap_or("image");
    let media_type = upload["mediaType"]
        .as_str()
        .unwrap_or("application/octet-stream");
    let encoded = upload["bytes"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("upload carries no bytes"))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    let object_id = format!("att-{}", uuid::Uuid::new_v4());
    let js = async_nats::jetstream::new(client.clone());
    let store = js
        .get_object_store(bucket)
        .await
        .map_err(|e| anyhow::anyhow!("object store {bucket:?} unavailable: {e}"))?;
    store.put(object_id.as_str(), &mut bytes.as_slice()).await?;
    Ok(serde_json::json!({
        "type": block_type,
        "source": {
            "type": "object",
            "id": object_id,
            "mediaType": media_type,
            "size": bytes.len(),
        },
    }))
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
            spawn_with_attach("sh", &["-c", "cat <&3 >&3"], 3, |_cmd| {})
                .expect("spawn with attach fd");

        parent_end
            .write_all(b"hello over fd 3\n")
            .await
            .expect("write");

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
        let (_read_half, write_half) = child_end.into_split();
        let handle: Option<AttachHandle> = Some(Arc::new(Mutex::new(write_half)));

        tee(&handle, "conv.v2.abc.changes.message", br#"{"id":"m1"}"#).await;

        let mut parent_end = parent_end;
        let mut buf = vec![0u8; 256];
        let n = parent_end.read(&mut buf).await.expect("read");
        let line = std::str::from_utf8(&buf[..n]).expect("utf8");
        assert!(line.ends_with('\n'));
        let parsed: serde_json::Value =
            serde_json::from_str(line.trim_end()).expect("one json line");
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
