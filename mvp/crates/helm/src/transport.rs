//! The one thing that touches the attach fd and bridge's stdio: spawns
//! bridge, speaks its untouched one-line-in/one-line-out control protocol,
//! and decodes attach-fd lines into (subject, payload) pairs. Holds no
//! domain state — same contract as tower frontend's core/transport.ts,
//! adapted from a WebSocket to bridge's attach fd.

use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
    attach: BufReader<tokio::net::UnixStream>,
    /// Every real request (say, cancel) still goes over NATS — the attach fd
    /// only ever carries events out, never requests in (conv.v2's own
    /// `.requests` subject is what a servicer subscribes to). helm dials NATS
    /// itself for this, same as any other client; it is not routed through
    /// bridge's stdio or its attach fd.
    nats: async_nats::Client,
}

impl Session {
    /// Spawn `bridge_path` with a fresh attach fd dup'd in as fd 3
    /// (`BRIDGE_ATTACH_FD`), alongside its ordinary stdio control pipes, and
    /// dial the NATS url a say/cancel will need. `nats_url` defaults to
    /// bridge's own default (`nats://127.0.0.1:4222`) when None.
    pub async fn spawn(bridge_path: &str, nats_url: Option<&str>) -> anyhow::Result<Self> {
        let (parent_end, child_end) = StdUnixStream::pair()?;
        let child_raw = child_end.as_raw_fd();

        let mut cmd = Command::new(bridge_path);
        cmd.env("BRIDGE_ATTACH_FD", "3");
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::inherit());

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
        let attach = BufReader::new(tokio::net::UnixStream::from_std(parent_end)?);

        let nats_url = nats_url
            .map(str::to_string)
            .unwrap_or_else(|| "nats://127.0.0.1:4222".into());
        let nats = async_nats::connect(&nats_url).await?;

        Ok(Self {
            child,
            control_out,
            control_in,
            attach,
            nats,
        })
    }

    /// Send one control line, read its one reply line — bridge's existing
    /// stdio contract, untouched by helm's presence.
    pub async fn control(&mut self, line: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        let mut bytes = serde_json::to_vec(line)?;
        bytes.push(b'\n');
        self.control_out.write_all(&bytes).await?;
        let mut reply = String::new();
        self.control_in.read_line(&mut reply).await?;
        Ok(serde_json::from_str(reply.trim_end())?)
    }

    /// The conversation this session's spawn control line minted.
    pub async fn spawn_conversation(&mut self) -> anyhow::Result<wire::ConversationId> {
        let reply = self.control(&serde_json::json!({ "spawn": {} })).await?;
        let id = reply["conversationId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("spawn reply carried no conversationId: {reply}"))?;
        Ok(wire::ConversationId(id.to_string()))
    }

    /// Say into the conversation this session spawned: a real `conv.v2
    /// requests.say`, id-correlated, exactly what any client (tower
    /// included) sends. `tip: None` claims "empty so far" — correct only
    /// while helm has spawned a fresh conversation and never yet revised
    /// its own premise; a real editor concern will need to track the true
    /// tip once one exists.
    pub async fn say(&self, conv: &wire::ConversationId, text: &str) -> anyhow::Result<wire::SayOutcome> {
        let subject = format!("conv.v2.{}.requests.say", conv.0);
        let cmd = wire::SayCommand {
            conv: conv.clone(),
            text: text.to_string(),
            tip: None,
            attachments: Vec::new(),
        };
        let payload = wire::encode_say(&cmd, &wire::now_iso());
        let reply = self.nats.request(subject, payload.into()).await?;
        Ok(wire::parse_say_reply(&reply.payload))
    }

    /// Answer a pending approval: a real `approval.v1.{id}.requests` answer,
    /// first valid answer wins — losing the race comes back as
    /// `rejected: already_settled` and is information, not an error. The
    /// settlement arrives back over the attach fd as an ordinary lifecycle
    /// event, same as tower sees it.
    pub async fn answer(&self, approval_id: &str, approved: bool) -> anyhow::Result<wire::AnswerOutcome> {
        let subject = format!("approval.v1.{approval_id}.requests");
        let payload = wire::encode_answer(approved, &wire::now_iso());
        let reply = self.nats.request(subject, payload.into()).await?;
        Ok(wire::parse_answer_reply(&reply.payload))
    }

    /// One event off the attach fd, or `None` once it closes (bridge exited).
    pub async fn next_event(&mut self) -> anyhow::Result<Option<AttachEvent>> {
        let mut line = String::new();
        let n = self.attach.read_line(&mut line).await?;
        if n == 0 {
            return Ok(None);
        }
        let envelope: serde_json::Value = serde_json::from_str(line.trim_end())?;
        let subject = envelope["subject"].as_str().unwrap_or_default().to_string();
        let payload = serde_json::to_vec(&envelope["payload"])?;
        Ok(Some(AttachEvent { subject, payload }))
    }
}
