//! The TUI attach channel: two inheritable OS pipes alongside stdio, handed
//! to bridge only by whatever process spawned it locally. stdio keeps its
//! existing one-line-in/one-line-out control protocol untouched; this pair
//! carries the conversation's own events and requests instead, so the two
//! framings never share a channel. See docs/planning/tui-architecture.md and
//! the "why not overload stdio" discussion it followed from.
//!
//! One inheritable pipe is one-directional (unlike the Unix socketpair this
//! replaced, which was a single duplex stream), so the channel is two pipes,
//! not one — the same shape stdin/stdout already take. `interprocess`'s
//! `unnamed_pipe` gives an inheritable OS pipe (Unix `pipe()`, Windows
//! `CreatePipe`) behind one API, so this file has no OS-conditional code
//! beyond the `raw` module below: a fixed fd number (`dup2` onto fd 3) has
//! no Windows equivalent (Windows handles aren't small sequential integers,
//! and there is no `fork`+`pre_exec` there), so the child-side raw handle/fd
//! *value* rides an env var instead — the crate's own documented pattern.

use std::process::Command;
use std::sync::Arc;

use base64::Engine;
use interprocess::unnamed_pipe::tokio::{Recver, Sender};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// Env var names bridge and its spawner (helm's `transport::Session::spawn`)
/// both agree on — one source, so the two sides can't drift apart.
pub const ATTACH_FD_DOWN: &str = "BRIDGE_ATTACH_FD_DOWN";
pub const ATTACH_FD_UP: &str = "BRIDGE_ATTACH_FD_UP";

/// Shared handle a Publisher clones cheaply per turn; the mutex serialises
/// concurrent tees and request replies (the down pipe only — the up pipe
/// belongs to serve_requests, so a write can never block behind a read).
pub type AttachHandle = Arc<Mutex<Sender>>;

/// The only OS-conditional code in this file: naming and reconstructing the
/// raw value that survives a spawn — `RawFd` on Unix, `RawHandle` on
/// Windows. Both are plain integers once stringified into an env var.
#[cfg(unix)]
mod raw {
    use std::os::fd::{AsFd, AsRawFd, FromRawFd, OwnedFd};

    pub type Raw = i32;

    pub fn of(end: &impl AsFd) -> Raw {
        end.as_fd().as_raw_fd()
    }

    pub fn owned(value: Raw) -> OwnedFd {
        // SAFETY: `value` names a pipe end this process (or its parent, for
        // the inherited copy) created via `interprocess::unnamed_pipe`; it
        // is open and uniquely ours to take ownership of here.
        unsafe { OwnedFd::from_raw_fd(value) }
    }
}
#[cfg(windows)]
mod raw {
    use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

    pub type Raw = isize;

    pub fn of(end: &impl AsHandle) -> Raw {
        end.as_handle().as_raw_handle() as Raw
    }

    pub fn owned(value: Raw) -> OwnedHandle {
        // SAFETY: see the Unix `owned` above — same guarantee, Windows handle.
        unsafe { OwnedHandle::from_raw_handle(value as RawHandle) }
    }
}

/// A fresh duplex attach channel, not yet handed to any child: two pipes
/// (down: child → parent, up: parent → child) plus the env var values
/// naming the child-side end of each, ready to set on whichever `Command`
/// type the caller spawns with (`std::process` here, `tokio::process` in
/// helm's `transport::Session::spawn` — both need the same pipes, only the
/// spawn call itself differs).
pub struct AttachPipes {
    down_tx: Sender,     // child's end; kept only to drop after spawn
    pub down_rx: Recver, // parent keeps: reads what the child sends down
    pub up_tx: Sender,   // parent keeps: writes reach the child
    up_rx: Recver,       // child's end; kept only to drop after spawn
    pub down_value: String,
    pub up_value: String,
}

pub fn attach_pipes() -> std::io::Result<AttachPipes> {
    let (down_tx, down_rx) = interprocess::unnamed_pipe::tokio::pipe()?; // child writes, parent reads
    let (up_tx, up_rx) = interprocess::unnamed_pipe::tokio::pipe()?; // parent writes, child reads
    let down_value = raw::of(&down_tx).to_string();
    let up_value = raw::of(&up_rx).to_string();
    Ok(AttachPipes {
        down_tx,
        down_rx,
        up_tx,
        up_rx,
        down_value,
        up_value,
    })
}

impl AttachPipes {
    /// The child-side ends are inherited into its own handle table the
    /// instant `Command::spawn` returns; dropping our copies afterward
    /// doesn't touch the child's — same guarantee the old socketpair's
    /// `drop(child_end)` relied on. Call once, right after spawning.
    pub fn forget_child_ends(self) -> (Sender, Recver) {
        drop(self.down_tx);
        drop(self.up_rx);
        (self.up_tx, self.down_rx)
    }
}

/// Spawn `program` with a fresh duplex attach channel alongside whatever
/// stdio wiring `configure` sets up, the child's ends named by
/// `down_var`/`up_var` as env vars carrying the raw inherited value. Returns
/// the spawned child, the parent's sender (writes reach the child) and the
/// parent's recver (reads what the child writes up).
pub fn spawn_with_attach(
    program: &str,
    args: &[&str],
    down_var: &str,
    up_var: &str,
    configure: impl FnOnce(&mut Command),
) -> std::io::Result<(std::process::Child, Sender, Recver)> {
    let pipes = attach_pipes()?;

    let mut cmd = Command::new(program);
    cmd.args(args);
    configure(&mut cmd);
    cmd.env(down_var, &pipes.down_value);
    cmd.env(up_var, &pipes.up_value);

    let child = cmd.spawn()?;
    let (up_tx, down_rx) = pipes.forget_child_ends();
    Ok((child, up_tx, down_rx))
}

/// Bridge's own side: pick up the pipe ends the parent inherited us into, if
/// any. `ATTACH_FD_DOWN`/`ATTACH_FD_UP` name them; absence of either means no
/// local TUI is attached.
pub fn attach_stream() -> Option<(Sender, Recver)> {
    let down: raw::Raw = std::env::var(ATTACH_FD_DOWN).ok()?.parse().ok()?;
    let up: raw::Raw = std::env::var(ATTACH_FD_UP).ok()?.parse().ok()?;
    let tx = Sender::try_from(raw::owned(down)).ok()?;
    let rx = Recver::try_from(raw::owned(up)).ok()?;
    Some((tx, rx))
}

/// The channel is duplex across its two pipes: events and request replies
/// flow down as one JSON line each (events `{subject, payload}`, replies
/// `{id, payload}`), requests flow up as `{id, subject, payload}` — or
/// `{id, upload}` for attachment bytes — and bridge proxies them onto NATS,
/// so an attached client needs no NATS of its own.
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

/// Serve the up pipe: each line is either a NATS request to proxy (`{id,
/// subject, payload}` — say, cancel, answer, anything addressed) or an
/// attachment upload (`{id, upload}` — bytes to the transit object store,
/// the reference block minted back). Bridge is the NATS participant; the
/// attached client never dials the broker. Unintelligible lines with an id
/// are answered (compliance is answering); without one, skipped.
pub async fn serve_requests(
    read: Recver,
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
            "bucket": bucket,
            "mediaType": media_type,
            "size": bytes.len(),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    /// Proves the actual spawn path: a real child exists, and the env vars
    /// it received parse as raw values. The child doesn't touch the pipes
    /// here — a plain shell doing blocking I/O can't: `interprocess`'s tokio
    /// pipes are O_NONBLOCK from creation (both ends, before the fork this
    /// spawn does), and that flag is a property of the shared kernel file
    /// description, so the child's inherited copy is nonblocking too. That's
    /// exactly what a tokio child (the real case: bridge, reconstructing via
    /// `Sender`/`Recver`'s own `TryFrom`, which re-asserts nonblocking and
    /// wraps in `AsyncFd`) wants; it's fatal to a plain blocking `cat`. The
    /// reconstruction contract itself is proved separately, below.
    #[tokio::test]
    async fn spawn_with_attach_hands_the_child_parseable_raw_values() {
        let (child, up_tx, down_rx) = spawn_with_attach(
            "sh",
            &["-c", "echo \"$TEST_ATTACH_DOWN $TEST_ATTACH_UP\""],
            "TEST_ATTACH_DOWN",
            "TEST_ATTACH_UP",
            |cmd| {
                cmd.stdout(std::process::Stdio::piped());
            },
        )
        .expect("spawn with attach pipes");

        let output = child.wait_with_output().expect("child exits");
        assert!(output.status.success());
        let printed = String::from_utf8_lossy(&output.stdout);
        let values: Vec<&str> = printed.trim().split(' ').collect();
        assert_eq!(values.len(), 2, "expected two raw values: {printed:?}");
        for v in values {
            v.parse::<raw::Raw>()
                .unwrap_or_else(|_| panic!("not a parseable raw value: {v:?}"));
        }

        // The parent's own ends are independently live regardless of what
        // the (already-exited) child did with its copies.
        drop(up_tx);
        drop(down_rx);
    }

    /// Proves the reconstruction contract `attach_stream` (bridge, the real
    /// child) and `spawn_with_attach` (the parent) both rely on: a pipe
    /// end's raw value, separated from its original owner exactly as a fork
    /// separates a child's inherited copy from the parent's, reconstructs
    /// via `Sender`/`Recver`'s `TryFrom` into a fully working end.
    #[tokio::test]
    async fn a_pipe_end_survives_a_raw_value_round_trip() {
        let (tx, mut rx) = interprocess::unnamed_pipe::tokio::pipe().expect("unnamed pipe");
        let value = raw::of(&tx);
        // Release our Rust-level ownership WITHOUT closing the fd/handle —
        // standing in for what a real fork+exec does to the parent's copy
        // once the child has its own independent reference.
        std::mem::forget(tx);

        let mut reconstructed =
            Sender::try_from(raw::owned(value)).expect("reconstruct sender from raw value");
        reconstructed
            .write_all(b"hello over the pipe\n")
            .await
            .expect("write");

        let mut buf = [0u8; 64];
        let n = rx.read(&mut buf).await.expect("read");
        assert_eq!(&buf[..n], b"hello over the pipe\n");
    }

    /// Proves the tee's framing without any NATS or bridge process involved —
    /// same discipline as the rest of this repo's tests (only Broker is ever
    /// faked; here there's nothing to fake, just a plain pipe).
    #[tokio::test]
    async fn tee_frames_subject_and_payload_as_one_json_line() {
        let (tx, mut rx) = interprocess::unnamed_pipe::tokio::pipe().expect("unnamed pipe");
        let handle: Option<AttachHandle> = Some(Arc::new(Mutex::new(tx)));

        tee(&handle, "conv.v2.abc.changes.message", br#"{"id":"m1"}"#).await;

        let mut buf = vec![0u8; 256];
        let n = rx.read(&mut buf).await.expect("read");
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
