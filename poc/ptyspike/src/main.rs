//! POC demo: a real interactive `claude` session, pty-wrapped, mirrored onto
//! NATS/Tower and addressable via `conv.v2.{id}.requests.say`.
//!
//! Scoped deliberately narrow — see docs/spec/{agent,conversation}-spec.md
//! for what's skipped: no precondition/tip enforcement (always accept), no
//! turn/tool/usage telemetry, no `cancel`/`chdir`/`drain`, no `detached` on
//! exit (a crash is lawful per agent-spec — the pulse going silent is what
//! observers fold). Just: does it show up, and can Tower talk into it.
//!
//! Run: `cargo run -p ptyspike -- <cwd-to-run-claude-in>`
//! Wrapper diagnostics go to /tmp/ptyspike.log, not stderr (see `log` below).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::Duration;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use uuid::Uuid;

const LOG_PATH: &str = "/tmp/ptyspike.log";
const PULSE_INTERVAL_S: u64 = 30;

/// Once the pty is in raw mode, stderr shares the same terminal as the
/// wrapped session's own rendering — an unsynchronised eprintln lands
/// wherever the cursor happens to be, visually (not literally) inside the
/// chat box. All wrapper diagnostics after that point go to a file instead.
fn log(msg: impl AsRef<str>) {
    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let _ = writeln!(f, "{}", msg.as_ref());
    }
}

fn now_iso() -> String {
    // Local offset via `date`, deliberately not a chrono dependency for a spike.
    let out = std::process::Command::new("date").arg("-Iseconds").output();
    out.ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "1970-01-01T00:00:00+00:00".to_string())
}

async fn publish_logged(client: &async_nats::Client, subject: String, payload: &serde_json::Value) {
    let bytes = serde_json::to_vec(payload).expect("json of plain values cannot fail");
    match client.publish(subject.clone(), bytes.into()).await {
        Ok(()) => log(format!("[ptyspike] -> {subject} : {payload}")),
        Err(e) => log(format!("[ptyspike] -> {subject} FAILED: {e} (payload: {payload})")),
    }
}


const SESSION_INFO_PATH: &str = "/tmp/ptyspike-session.json";

/// Which transcript file belongs to *this* run is not discoverable by
/// guessing (claude mints its session id internally and never tells us any
/// other way) — it comes only from the target directory's `SessionStart`
/// hook (see hooktest/session-start.sh), which writes {sessionId,
/// transcriptPath} the moment the session starts. Stale info from a
/// previous run is cleared before spawn so a slow hook can't hand back an
/// old session's file.
fn wait_for_session_info() -> anyhow::Result<(String, std::path::PathBuf)> {
    for _ in 0..100 {
        if let Ok(text) = std::fs::read_to_string(SESSION_INFO_PATH)
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
            && let Some(session_id) = value.get("sessionId").and_then(|v| v.as_str())
            && let Some(transcript_path) = value.get("transcriptPath").and_then(|v| v.as_str())
            && !session_id.is_empty()
            && !transcript_path.is_empty()
        {
            return Ok((session_id.to_string(), std::path::PathBuf::from(transcript_path)));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    anyhow::bail!(
        "no SessionStart hook fired within 10s — is {SESSION_INFO_PATH} wired in the target directory's .claude/settings.json?"
    )
}

/// Tail the transcript JSONL, publishing each `user`/`assistant` entry as a
/// `conv.v2.{id}.changes.message`. Everything else (mode switches, system
/// lines, attachments) is unknown-type and skipped, per nats-spec tolerance.
fn tail_transcript(
    handle: tokio::runtime::Handle,
    client: async_nats::Client,
    conversation_id: String,
    path: std::path::PathBuf,
) {
    std::thread::spawn(move || {
        // The transcript file is created lazily, on the session's first
        // message — at spawn time the hook has told us the path but nothing
        // exists there yet. Wait for it rather than failing.
        let mut file = loop {
            match std::fs::File::open(&path) {
                Ok(f) => break f,
                Err(_) => std::thread::sleep(Duration::from_millis(250)),
            }
        };
        log(format!("[ptyspike] transcript file appeared, tailing"));
        let mut carry = String::new();
        loop {
            let mut buf = String::new();
            if let Ok(n) = file.read_to_string(&mut buf)
                && n > 0
            {
                carry.push_str(&buf);
                while let Some(idx) = carry.find('\n') {
                    let line: String = carry.drain(..=idx).collect();
                    let line = line.trim();
                    if !line.is_empty() {
                        handle_transcript_line(&handle, &client, &conversation_id, line);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

fn handle_transcript_line(
    handle: &tokio::runtime::Handle,
    client: &async_nats::Client,
    conversation_id: &str,
    line: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let entry_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if entry_type != "user" && entry_type != "assistant" {
        return; // unknown/uninteresting type — tolerated, skipped.
    }
    let Some(message) = value.get("message") else {
        return;
    };
    let Some(role) = message.get("role").and_then(|r| r.as_str()) else {
        return;
    };
    let Some(id) = value.get("uuid").and_then(|u| u.as_str()) else {
        return;
    };
    let content = match message.get("content") {
        Some(serde_json::Value::String(s)) => {
            serde_json::json!([{ "type": "text", "text": s }])
        }
        Some(other @ serde_json::Value::Array(_)) => other.clone(),
        _ => return,
    };
    // Demo-scoped simplification: one query/turn per session, since the
    // transcript's own promptId/turn boundaries aren't threaded through
    // here. A real implementation mints these from the actual query fold.
    let query_id = value
        .get("sessionId")
        .and_then(|s| s.as_str())
        .unwrap_or("session")
        .to_string();
    let mut payload = serde_json::json!({
        "ts": now_iso(),
        "id": id,
        "queryId": query_id,
        "turnId": query_id,
        "role": role,
        "content": content,
    });
    if role == "user" {
        payload["from"] = serde_json::json!({ "kind": "human" });
    }
    let subject = format!("conv.v2.{conversation_id}.changes.message");
    handle.block_on(publish_logged(client, subject, &payload));
}

async fn run_nats(
    conversation_id: String,
    world: String,
    instance_id: String,
    cwd: String,
    say_tx: mpsc::Sender<Vec<u8>>,
) -> anyhow::Result<async_nats::Client> {
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    let client = async_nats::connect(&nats_url).await?;
    log(format!("[ptyspike] connected to {nats_url}; conversationId={conversation_id} world={world}"));

    publish_logged(
        &client,
        format!("agent.v1.{world}.telemetry.ready"),
        &serde_json::json!({ "ts": now_iso(), "instanceId": instance_id }),
    )
    .await;

    publish_logged(
        &client,
        format!("agent.v1.{world}.telemetry.attached"),
        &serde_json::json!({
            "ts": now_iso(), "instanceId": instance_id,
            "conversationId": conversation_id, "cwd": cwd, "tip": serde_json::Value::Null,
            "intervalS": PULSE_INTERVAL_S,
        }),
    )
    .await;

    {
        let client = client.clone();
        let world = world.clone();
        let instance_id = instance_id.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(PULSE_INTERVAL_S));
            loop {
                interval.tick().await;
                let payload = serde_json::json!({
                    "ts": now_iso(), "instanceId": instance_id, "intervalS": PULSE_INTERVAL_S,
                });
                publish_logged(&client, format!("agent.v1.{world}.telemetry.pulse"), &payload).await;
            }
        });
    }

    {
        let client = client.clone();
        let subject = format!("conv.v2.{conversation_id}.requests.say");
        let subject_clone = subject.clone();
        log(format!("[ptyspike] subscribing to {subject}"));
        tokio::spawn(async move {
            let mut sub = match client.subscribe(subject).await {
                Ok(s) => s,
                Err(e) => {
                    log(format!("[ptyspike] say subscribe failed: {e}"));
                    return;
                }
            };
            use futures::StreamExt;
            while let Some(msg) = sub.next().await {
                let Some(reply) = msg.reply.clone() else {
                    continue;
                };
                let text = serde_json::from_slice::<serde_json::Value>(&msg.payload)
                    .ok()
                    .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string));
                log(format!("[ptyspike] say request received on {subject_clone}"));
                let Some(text) = text else {
                    let rejected = serde_json::json!({ "rejected": true, "reason": "unsupported" });
                    publish_logged(&client, reply.to_string(), &rejected).await;
                    continue;
                };
                log(format!("[ptyspike] injecting say: {text:?}"));
                let _ = say_tx.send(text.into_bytes());
                let _ = say_tx.send(b"\r".to_vec());
                let accepted = serde_json::json!({ "accepted": true, "id": Uuid::new_v4().to_string() });
                publish_logged(&client, reply.to_string(), &accepted).await;
            }
        });
    }

    Ok(client)
}

fn main() -> anyhow::Result<()> {
    let target_dir = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_dir()?)
        .canonicalize()?;

    let conversation_id = Uuid::new_v4().to_string();
    // Same convention as bridge (BRIDGE_WORLD): world names the machine/place
    // conversations are served from, not which tool spawned this process —
    // ptyspike is a second instance in the same world bridge already uses.
    let world = std::env::var("BRIDGE_WORLD").unwrap_or_else(|_| "local".to_string());
    let instance_id = Uuid::new_v4().to_string();
    eprintln!("[ptyspike] conversationId = {conversation_id}");


    let (cols, rows) = crossterm::terminal::size()?;
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    // Clear stale session info before spawn: a slow-to-fire hook from a
    // *previous* run must never be mistaken for this run's session.
    let _ = std::fs::remove_file(SESSION_INFO_PATH);

    let mut cmd = CommandBuilder::new("claude");
    cmd.cwd(&target_dir);
    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    crossterm::terminal::enable_raw_mode()?;
    let _raw_guard = scopeguard(|| {
        let _ = crossterm::terminal::disable_raw_mode();
    });

    let mut pty_reader = pair.master.try_clone_reader()?;
    let mut pty_writer = pair.master.take_writer()?;

    // pty output -> our stdout
    let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pty_reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        let mut stdout = std::io::stdout();
        while let Ok(chunk) = out_rx.recv() {
            let _ = stdout.write_all(&chunk);
            let _ = stdout.flush();
        }
    });

    // our stdin -> pty input
    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>();
    let say_tx = in_tx.clone();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if in_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    std::thread::spawn(move || {
        while let Ok(chunk) = in_rx.recv() {
            if pty_writer.write_all(&chunk).is_err() {
                break;
            }
            let _ = pty_writer.flush();
        }
    });

    // crude resize poll — a real version would take SIGWINCH; fine for a spike.
    let master = pair.master;
    std::thread::spawn(move || {
        let mut last = (cols, rows);
        loop {
            std::thread::sleep(Duration::from_millis(250));
            if let Ok((c, r)) = crossterm::terminal::size()
                && (c, r) != last
            {
                last = (c, r);
                let _ = master.resize(PtySize {
                    rows: r,
                    cols: c,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
        }
    });

    let runtime = tokio::runtime::Runtime::new()?;
    let handle = runtime.handle().clone();
    let client = runtime.block_on(run_nats(
        conversation_id.clone(),
        world,
        instance_id,
        target_dir.to_string_lossy().to_string(),
        say_tx,
    ))?;

    let (session_id, transcript_file) = wait_for_session_info()?;
    log(format!("[ptyspike] session {session_id} -> tailing {transcript_file:?}"));
    tail_transcript(handle, client, conversation_id, transcript_file);

    let status = child.wait()?;
    drop(_raw_guard);
    std::process::exit(status.exit_code() as i32);
}

fn scopeguard<F: FnOnce()>(f: F) -> impl Drop {
    struct Guard<F: FnOnce()>(Option<F>);
    impl<F: FnOnce()> Drop for Guard<F> {
        fn drop(&mut self) {
            if let Some(f) = self.0.take() {
                f();
            }
        }
    }
    Guard(Some(f))
}
