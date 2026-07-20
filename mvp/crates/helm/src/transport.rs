//! The one thing that touches the attach fd and bridge's stdio: spawns
//! bridge, speaks its untouched one-line-in/one-line-out control protocol,
//! decodes attach-fd lines, and sends requests up the same fd as
//! id-correlated envelopes bridge proxies onto NATS. helm dials nothing but
//! its own child's pipes — NATS is bridge's concern alone. Holds no domain
//! state — same contract as tower frontend's core/transport.ts.

use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::process::Stdio;

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::process::{Child, Command};

/// One event as it arrived over the attach fd. `subject` is conv.v2's own
/// leaf (the routing axis spells the type, per the wire spec); `payload` is
/// the raw JSON bytes, undecoded here — `wire::parse_wire(subject, payload)`
/// is the one decode, same as ingest's own edge fold.
pub struct AttachEvent {
    pub subject: String,
    pub payload: Vec<u8>,
}

pub struct Session {
    #[allow(dead_code)] // kept alive for the process's lifetime; not polled directly
    child: Child,
    control_out: tokio::process::ChildStdin,
    control_in: BufReader<tokio::process::ChildStdout>,
    attach_read: BufReader<OwnedReadHalf>,
    attach_write: OwnedWriteHalf,
    /// Events drained while a reply was awaited — an adopt replays history
    /// onto the fd BEFORE its reply, and the pipe's buffer is finite, so
    /// whoever awaits a reply must keep draining or deadlock bridge.
    /// `next_event` serves these first.
    buffered: std::collections::VecDeque<AttachEvent>,
    /// Request-envelope correlation ids, monotonic per session.
    next_id: u64,
}

impl Session {
    /// Spawn `bridge_path` with a fresh attach fd dup'd in as fd 3
    /// (`BRIDGE_ATTACH_FD`), alongside its ordinary stdio control pipes.
    pub async fn spawn(bridge_path: &str) -> anyhow::Result<Self> {
        let (parent_end, child_end) = StdUnixStream::pair()?;
        let child_raw = child_end.as_raw_fd();

        let mut cmd = Command::new(bridge_path);
        cmd.env("BRIDGE_ATTACH_FD", "3");
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        // bridge's stderr must never reach helm's terminal — the alternate
        // screen is helm's alone. The log survives in a file instead.
        let log_path = std::env::var("HELM_BRIDGE_LOG")
            .unwrap_or_else(|_| "/tmp/helm-bridge.log".into());
        let log = std::fs::File::create(&log_path)?;
        cmd.stderr(Stdio::from(log));

        // SAFETY: dup2 only, between fork and exec — see bridge::attach's
        // own doc for the same discipline.
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(child_raw, 3) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = cmd.spawn()?;
        drop(child_end);

        let control_out = child.stdin.take().expect("piped stdin");
        let control_in = BufReader::new(child.stdout.take().expect("piped stdout"));

        parent_end.set_nonblocking(true)?;
        let (read_half, write_half) = tokio::net::UnixStream::from_std(parent_end)?.into_split();

        Ok(Self {
            child,
            control_out,
            control_in,
            attach_read: BufReader::new(read_half),
            attach_write: write_half,
            buffered: std::collections::VecDeque::new(),
            next_id: 0,
        })
    }

    /// Send one control line, read its one reply line — bridge's existing
    /// stdio contract, untouched by helm's presence. The attach fd keeps
    /// draining while the reply is awaited: bridge may tee (an adopt's whole
    /// replayed history) before it answers, and a full pipe with no reader
    /// deadlocks both processes.
    pub async fn control(&mut self, line: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let mut bytes = serde_json::to_vec(line)?;
        bytes.push(b'\n');
        self.control_out.write_all(&bytes).await?;
        let mut reply = String::new();
        // Both accumulators persist across select iterations: read_line is
        // not cancellation-safe, but its partial progress lives in the String
        // it appends to — keeping the Strings keeps the bytes.
        let mut attach_line = String::new();
        loop {
            tokio::select! {
                n = self.control_in.read_line(&mut reply) => {
                    n?;
                    return Ok(serde_json::from_str(reply.trim_end())?);
                }
                n = self.attach_read.read_line(&mut attach_line) => {
                    if n? == 0 {
                        anyhow::bail!("attach fd closed while awaiting a control reply");
                    }
                    if let Parsed::Event(event) = parse_attach_line(&attach_line)? {
                        self.buffered.push_back(event);
                    }
                    attach_line.clear();
                }
            }
        }
    }

    /// The conversation this session's spawn control line minted.
    pub async fn spawn_conversation(&mut self) -> anyhow::Result<wire::ConversationId> {
        let reply = self.control(&serde_json::json!({ "spawn": {} })).await?;
        let id = reply["conversationId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("spawn reply carried no conversationId: {reply}"))?;
        Ok(wire::ConversationId(id.to_string()))
    }

    /// Adopt an existing conversation: bridge replays the record from the
    /// capture stream, serves on from its tip, and — with this session's
    /// attach fd present — tees the replayed frames to us, so the history
    /// arrives through the same fold as live traffic. No client-side store.
    pub async fn adopt_conversation(&mut self, conv: &str) -> anyhow::Result<wire::ConversationId> {
        let reply = self
            .control(&serde_json::json!({ "adopt": { "conversationId": conv } }))
            .await?;
        let id = reply["conversationId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("adopt reply carried no conversationId: {reply}"))?;
        Ok(wire::ConversationId(id.to_string()))
    }

    /// One request envelope up the fd, its correlated reply back down.
    /// Events arriving while the reply is awaited buffer for `next_event` —
    /// the same drain discipline as `control`.
    async fn request(&mut self, mut envelope: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        self.next_id += 1;
        let id = format!("r{}", self.next_id);
        envelope["id"] = serde_json::Value::String(id.clone());
        let mut bytes = serde_json::to_vec(&envelope)?;
        bytes.push(b'\n');
        self.attach_write.write_all(&bytes).await?;

        let mut line = String::new();
        loop {
            let n = self.attach_read.read_line(&mut line).await?;
            if n == 0 {
                anyhow::bail!("attach fd closed while awaiting a reply");
            }
            match parse_attach_line(&line)? {
                Parsed::Event(event) => self.buffered.push_back(event),
                Parsed::Reply { id: reply_id, payload } if reply_id == id => {
                    if let Some(error) = payload["error"].as_str() {
                        anyhow::bail!("{error}");
                    }
                    return Ok(payload);
                }
                Parsed::Reply { .. } => {} // an orphan reply: nothing awaits it
            }
            line.clear();
        }
    }

    /// A proxied NATS request: bridge forwards `payload` to `subject` and
    /// relays the responder's reply. The reply parsers want bytes.
    async fn request_subject(&mut self, subject: String, payload: Vec<u8>) -> anyhow::Result<Vec<u8>> {
        let payload: serde_json::Value = serde_json::from_slice(&payload)?;
        let reply = self
            .request(serde_json::json!({ "subject": subject, "payload": payload }))
            .await?;
        Ok(serde_json::to_vec(&reply)?)
    }

    /// Say into the conversation this session spawned: a real `conv.v2
    /// requests.say`, exactly what any client sends — bridge proxies it onto
    /// the wire. `tip` is the sender's premise — the latest message id this
    /// client holds, `None` claiming "empty so far".
    pub async fn say(
        &mut self,
        conv: &wire::ConversationId,
        text: &str,
        tip: Option<wire::MessageId>,
        attachments: Vec<serde_json::Value>,
    ) -> anyhow::Result<wire::SayOutcome> {
        let subject = format!("conv.v2.{}.requests.say", conv.0);
        let cmd = wire::SayCommand {
            conv: conv.clone(),
            text: text.to_string(),
            tip,
            attachments,
        };
        let payload = wire::encode_say(&cmd, &wire::now_iso());
        let reply = self.request_subject(subject, payload).await?;
        Ok(wire::parse_say_reply(&reply))
    }

    /// Cancel a live query by its id — the id is the cancel's premise.
    /// Acceptance is all a reply means; the outcome lands on the record as
    /// events like everything else.
    pub async fn cancel(
        &mut self,
        conv: &wire::ConversationId,
        query: &str,
    ) -> anyhow::Result<wire::CancelOutcome> {
        let subject = format!("conv.v2.{}.requests.cancel", conv.0);
        let payload = wire::encode_cancel(&wire::QueryId(query.to_string()), &wire::now_iso());
        let reply = self.request_subject(subject, payload).await?;
        Ok(wire::parse_cancel_reply(&reply))
    }

    /// Answer a pending approval: a real `approval.v1.{id}.requests` answer,
    /// first valid answer wins — losing the race comes back as
    /// `rejected: already_settled` and is information, not an error. The
    /// settlement arrives back over the attach fd as an ordinary lifecycle
    /// event, same as tower sees it.
    pub async fn answer(
        &mut self,
        approval_id: &str,
        approved: bool,
    ) -> anyhow::Result<wire::AnswerOutcome> {
        let subject = format!("approval.v1.{approval_id}.requests");
        let payload = wire::encode_answer(approved, &wire::now_iso());
        let reply = self.request_subject(subject, payload).await?;
        Ok(wire::parse_answer_reply(&reply))
    }

    /// Upload raw bytes for an attachment: base64 up the fd, bridge puts them
    /// in the transit object store and mints the reference block back. Only
    /// images come this way — files attach as path metadata in the submit
    /// text (submit.rs, the reference's format), never as bytes.
    pub async fn upload_bytes(
        &mut self,
        name: &str,
        block_type: &str,
        media_type: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<(String, serde_json::Value)> {
        let size = bytes.len();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let block = self
            .request(serde_json::json!({
                "upload": {
                    "blockType": block_type,
                    "mediaType": media_type,
                    "bytes": encoded,
                },
            }))
            .await?;
        Ok((format!("{name} ({size} B)"), block))
    }

    /// One event off the attach fd — anything drained during a reply wait
    /// first — or `None` once it closes (bridge exited).
    pub async fn next_event(&mut self) -> anyhow::Result<Option<AttachEvent>> {
        if let Some(event) = self.buffered.pop_front() {
            return Ok(Some(event));
        }
        let mut line = String::new();
        loop {
            let n = self.attach_read.read_line(&mut line).await?;
            if n == 0 {
                return Ok(None);
            }
            match parse_attach_line(&line)? {
                Parsed::Event(event) => return Ok(Some(event)),
                Parsed::Reply { .. } => line.clear(), // orphan reply: skip
            }
        }
    }
}

/// One framed line off the fd: an event (`{subject, payload}`) or a request
/// reply (`{id, payload}`).
enum Parsed {
    Event(AttachEvent),
    Reply { id: String, payload: serde_json::Value },
}

fn parse_attach_line(line: &str) -> anyhow::Result<Parsed> {
    let envelope: serde_json::Value = serde_json::from_str(line.trim_end())?;
    if let Some(id) = envelope["id"].as_str() {
        return Ok(Parsed::Reply {
            id: id.to_string(),
            payload: envelope["payload"].clone(),
        });
    }
    let subject = envelope["subject"].as_str().unwrap_or_default().to_string();
    let payload = serde_json::to_vec(&envelope["payload"])?;
    Ok(Parsed::Event(AttachEvent { subject, payload }))
}
