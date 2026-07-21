//! A throwaway probe, not product code: spawns the real `bridge` binary with
//! an attach fd wired up exactly as helm does, sends a spawn control line
//! over the untouched stdio protocol, then a `say` as an id-correlated
//! request envelope UP the attach fd — the probe itself dials no NATS at
//! all; bridge proxies. With an argv conversation id it adopts instead and
//! watches the replayed history arrive.
//!
//! Needs NATS reachable for bridge itself (`docker compose up -d`) and
//! `cargo build -p bridge` already run. Run: cargo run -p bridge --example attach_probe

use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader as TokioBufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bridge_path = format!("{}/../../target/debug/bridge", env!("CARGO_MANIFEST_DIR"));

    let (parent_end, child_end) = StdUnixStream::pair()?;
    let child_raw = child_end.as_raw_fd();

    let mut cmd = Command::new(&bridge_path);
    cmd.env("BRIDGE_ATTACH_FD", "3");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit()); // bridge's own log lines, visible for this probe

    // SAFETY: dup2 only, between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(child_raw, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }

    println!("attach_probe: spawning {bridge_path}");
    let mut child = cmd.spawn()?;
    drop(child_end);

    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stdout = BufReader::new(stdout);

    // The attach reader starts BEFORE any control line: an adopt tees its
    // whole replayed history before it replies, and a full pipe with no
    // reader deadlocks both processes. Split: the write half sends request
    // envelopes up.
    parent_end.set_nonblocking(true)?;
    let (read_half, mut attach_write) = tokio::net::UnixStream::from_std(parent_end)?.into_split();
    let mut attach_reader = TokioBufReader::new(read_half);
    let read_task = tokio::spawn(async move {
        loop {
            let mut line = String::new();
            match attach_reader.read_line(&mut line).await {
                Ok(0) => {
                    println!("attach_probe: attach fd closed");
                    break;
                }
                Ok(_) => println!("attach_probe: <- {}", line.trim_end()),
                Err(e) => {
                    println!("attach_probe: read error: {e}");
                    break;
                }
            }
        }
    });

    // With an argv conversation id: adopt it and watch the replayed history
    // arrive over the attach fd (no say is sent). Without: spawn fresh.
    let adopt_target = std::env::args().nth(1);
    let control = match &adopt_target {
        Some(conv) => format!("{{\"adopt\":{{\"conversationId\":\"{conv}\"}}}}\n"),
        None => "{\"spawn\":{}}\n".to_string(),
    };
    stdin.write_all(control.as_bytes())?;
    let mut reply = String::new();
    stdout.read_line(&mut reply)?;
    println!("attach_probe: control reply: {}", reply.trim_end());
    let reply_value: serde_json::Value = serde_json::from_str(reply.trim_end())?;
    let conv = reply_value["conversationId"]
        .as_str()
        .expect("conversationId in reply")
        .to_string();

    if adopt_target.is_none() {
        // The say goes UP the attach fd as a request envelope — no NATS
        // client in this process; bridge proxies onto the wire. The reply
        // comes back down the same fd, printed by the read task above.
        let say = wire::SayCommand {
            conv: wire::ConversationId(conv.clone()),
            text: "hello from attach_probe".into(),
            tip: None,
            attachments: Vec::new(),
        };
        let payload: serde_json::Value =
            serde_json::from_slice(&wire::encode_say(&say, &wire::now_iso()))?;
        let envelope = serde_json::json!({
            "id": "probe-1",
            "subject": format!("conv.v2.{conv}.requests.say"),
            "payload": payload,
        });
        println!("attach_probe: sending say up the attach fd");
        use tokio::io::AsyncWriteExt;
        let mut line = serde_json::to_vec(&envelope)?;
        line.push(b'\n');
        attach_write.write_all(&line).await?;
    }

    tokio::time::sleep(Duration::from_secs(5)).await;
    read_task.abort();

    child.kill().ok();
    child.wait().ok();
    Ok(())
}
