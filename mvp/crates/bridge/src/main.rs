//! bridge: the agent host. Conversations are tasks, not processes; nothing
//! on the wire knows the difference (the concern specs are conversation-
//! centric by design). v0 control is stdio, deliberately not a wire concern:
//! creation stays local until practice teaches the spawn request's shape.
//!
//!   $ echo '{"spawn": {"cwd": "/path/to/project"}}' | bridge
//!   {"conversationId":"…"}
//!   $ echo '{"adopt": {"conversationId": "…", "cwd": "/path/to/project"}}' | bridge
//!   {"conversationId":"…","adoptedMessages":12}
//!   $ echo '{"skills": {"dir": "/path/to/skills"}}' | bridge
//!   {"skillsDir":"/path/to/skills"}
//!   $ echo '{"revise": {"conversationId": "…", "messageId": "…", "content": [...] }}' | bridge
//!   {"conversationId":"…","revisedMessage":"…"}
//!
//! `adopt` revives a conversation whose holder died: the record outlives
//! the servicer, so a fresh instance replays the committed messages from
//! the capture stream, seeds its tree, and serves on. The recovery
//! reconciliation, live: recovered behind the published record, reconcile
//! up to it. No validity precondition - a record ending broken (a dangling
//! tool_use) is served as it is, and the next turn's outcome says so.
//!
//! Each spawn services `conv.v2.{id}.requests.>` and produces the v2 event
//! subjects until the process ends. No persistence: v0 conversations die
//! with the host (a deliberate cut, not a gap).
//!
//! The process is one agent instance in a world (agent-spec): `ready` on
//! boot, a `pulse` every PULSE_INTERVAL_S, `attached` per spawn. The world
//! is deployer-chosen (`BRIDGE_WORLD`, default `local`); the instance id is
//! generated per process, so a restart is a new instance in the same world.
//! No `detached` in v0: conversations die with the host, and a kill is a
//! crash from the wire's view (a crash publishes nothing; the pulse going
//! silent is what observers fold).

mod agent;
mod anthropic;
mod approval;
mod decisions;
mod delete;
mod editfile;
mod exec;
mod find;
mod history;
mod historytools;
mod imaging;
mod matcher;
mod memory;
mod memtools;
mod mutate;
mod objects;
mod permissions;
mod pipe;
mod read;
mod readfile;
mod refs;
mod skills;
mod slice;
mod stream;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use anyhow::Context;
use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use wire::now_iso;

const PULSE_INTERVAL_S: i64 = 30;

/// Every conversation this instance serves, keyed to its own live cwd cell
/// (shared with its `AgentConfig.cwd`) — what `chdir` writes into to move
/// one conversation's directory. Never touched by the instance-wide `cwd`
/// line, which is the bridge process's own directory, nothing more.
type ServedCwds = Arc<RwLock<HashMap<String, Arc<RwLock<std::path::PathBuf>>>>>;

/// Expand a leading `~` or `~/...` to `$HOME`. A control line is JSON over
/// stdio, never a shell, so this is the only place a `~`-prefixed path is
/// ever resolved — anywhere else, it stays a literal tilde character.
fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = bridge::home::home_dir() {
            return std::path::PathBuf::from(home).join(rest);
        }
    } else if path == "~"
        && let Some(home) = bridge::home::home_dir()
    {
        return std::path::PathBuf::from(home);
    }
    std::path::PathBuf::from(path)
}

/// Replay a conversation's committed messages from the capture stream, in
/// stream order (= commit order), with every revision folded in —
/// conversation-spec: "the state of a message is its latest revision"
/// (last-write-wins per id; every prior revision, like every message,
/// remains in the record, but replay only ever hands the servicer the
/// current state). Telemetry, deltas and tip movements stay observation,
/// not replayed.
async fn replay_conversation(
    client: &async_nats::Client,
    stream_name: &str,
    conv: &str,
    attach: &Option<bridge::attach::AttachHandle>,
) -> anyhow::Result<Vec<decisions::Message>> {
    let js = async_nats::jetstream::new(client.clone());
    let stream = js.get_stream(stream_name).await.map_err(|e| {
        anyhow::anyhow!("capture stream {stream_name:?} unavailable: {e} (adopt needs the capture)")
    })?;
    let consumer = stream
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            filter_subject: format!("conv.v2.{conv}.changes.>"),
            deliver_policy: async_nats::jetstream::consumer::DeliverPolicy::All,
            ..Default::default()
        })
        .await?;
    // num_pending at creation is the full backlog: read exactly that many.
    let pending = consumer.cached_info().num_pending as usize;
    let mut messages = Vec::with_capacity(pending);
    if pending == 0 {
        return Ok(messages);
    }
    let mut revisions: std::collections::HashMap<String, Vec<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut batch = consumer.fetch().max_messages(pending).messages().await?;
    while let Some(msg) = batch.next().await {
        let msg = msg.map_err(|e| anyhow::anyhow!("replay read failed: {e}"))?;
        // History reaches an attached client as the same envelopes the live
        // tee sends — the record replayed, not a second history protocol.
        // The client's fold rebuilds the conversation exactly as the
        // servicer's own replay below does (last-write-wins per id).
        bridge::attach::tee(attach, &msg.subject, &msg.payload).await;
        // Tolerance: frames that don't parse as a conv change are skipped
        // (the filter admits query/tip_moved too now; only message and
        // revision matter here).
        let Some(wire::WireEvent::Conv(event)) = wire::parse_wire(&msg.subject, &msg.payload)
        else {
            continue;
        };
        match event.kind {
            wire::EventKind::Change(wire::ConvChange::Message(m)) => {
                messages.push(decisions::Message {
                    id: m.id.0,
                    role: m.role,
                    content: m.content,
                });
            }
            // Revisions can arrive before or after the message they correct
            // (a fix minted later in stream order) and the record keeps every
            // one — only the last written per id is the current state, so a
            // later revision in stream order always overwrites an earlier one
            // here, and the fold below applies whichever is held once the
            // whole backlog is read.
            wire::EventKind::Change(wire::ConvChange::Revision(r)) => {
                revisions.insert(r.message_id.0, r.content);
            }
            _ => {}
        }
    }
    for message in &mut messages {
        if let Some(content) = revisions.remove(&message.id) {
            message.content = content;
        }
    }
    Ok(messages)
}

async fn publish_agent(
    client: &async_nats::Client,
    world: &str,
    leaf: &str,
    payload: serde_json::Value,
) {
    let subject = format!("agent.v1.{world}.telemetry.{leaf}");
    let bytes = serde_json::to_vec(&payload).expect("json! of plain values cannot fail");
    // The pulse fires every PULSE_INTERVAL_S; logging it is pure noise. The
    // facts worth seeing are ready/attached/detached.
    if leaf != "pulse" {
        eprintln!("{} bridge: → {subject} ({} B)", now_iso(), bytes.len());
    }
    if let Err(e) = client.publish(subject, bytes.into()).await {
        eprintln!("bridge: agent telemetry publish failed: {e}");
    }
}

/// Serve a conversation: subscribe (the fact before the claim - a
/// conversation that cannot hear requests is not spawned in any meaningful
/// sense, so the claim and the reply both wait for this fact), spawn the
/// agent loop on the seeded tree, and publish `attached` so observers see
/// the conversation exist before its first message. Shared by spawn (a fresh
/// tree) and adopt (a replayed record), and by the future warden before a
/// third caller copies the wiring.
///
/// Returns the conversation id on success (the caller writes the stdout
/// reply); None means the subscription could not be made - the error line is
/// already written, so the caller moves on.
async fn serve_conversation(
    client: &async_nats::Client,
    world: &str,
    instance: &str,
    served: &ServedCwds,
    config: agent::AgentConfig,
    conversation: decisions::Conversation,
) -> Option<String> {
    let conv = config.conv.0.clone();
    let requests = match agent::subscribe(client, &config.conv).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("bridge: subscribe failed for {conv}: {e}");
            println!("{}", serde_json::json!({ "error": "subscribe failed" }));
            return None;
        }
    };
    // tip: where the conversation stands right now, so an observer other
    // than this servicer (towerd, a client, another agent) can learn it
    // without replaying the change stream first — the gap that made a
    // migrated-in conversation unaddressable except by its own servicer.
    // Read before the move: `conversation` is owned by the spawned task.
    let tip = conversation.tip().map(str::to_owned);
    // Read before the move: `config` is owned by the spawned task. Registers
    // this conversation's live cwd cell under its id so a `chdir` line (this
    // conversation) or the instance-wide `cwd` line (every served
    // conversation) can reach it later.
    let cwd_cell = Arc::clone(&config.cwd);
    let cwd = cwd_cell.read().unwrap().to_string_lossy().to_string();
    served.write().unwrap().insert(conv.clone(), cwd_cell);
    tokio::spawn(agent::run(client.clone(), requests, config, conversation));
    // The attachment is what makes the conversation exist for observers
    // before its first message. cwd is causal (an input to how the
    // conversation unfolds), and is always known now (resolved at spawn/adopt
    // time, never dependent on the instance's current directory).
    let attached = serde_json::json!({
        "ts": now_iso(),
        "instanceId": instance,
        "conversationId": conv,
        "tip": tip,
        "cwd": cwd,
    });
    publish_agent(client, world, "attached", attached).await;
    Some(conv)
}

/// The host's shared config and live cells. Every control line — from `-c` or
/// live stdin — reads through this; the cells are what a `skills`, `system`,
/// or `context` line repoints without a restart.
struct Host {
    client: async_nats::Client,
    world: String,
    instance: String,
    default_model: Arc<RwLock<String>>,
    auth: anthropic::Auth,
    /// The shared, keepalive-configured HTTP client (anthropic.rs's
    /// `build_http_client`) every conversation's messages-API calls share.
    http: reqwest::Client,
    skills_root: Arc<RwLock<std::path::PathBuf>>,
    system: Arc<RwLock<Option<String>>>,
    context: Arc<RwLock<Option<String>>>,
    attach_bucket: String,
    thinking_budget: Option<i64>,
    refs: refs::RefStore,
    memory: memory::MemoryStore,
    history: history::HistoryStore,
    // Resolved once at startup, informational only — what `settings` reports
    // for each store's file, since the stores themselves don't carry their
    // own path.
    refs_path: std::path::PathBuf,
    memory_path: std::path::PathBuf,
    history_path: std::path::PathBuf,
    // The local TUI's direct channel, if this instance was spawned with one
    // (BRIDGE_ATTACH_FD_DOWN/_UP). None for every tower-spawned instance
    // today; NATS stays the only channel regardless of this field's value.
    attach: Option<bridge::attach::AttachHandle>,
    /// Every conversation this instance serves, each keyed to its own live
    /// cwd cell (shared with its `AgentConfig.cwd`) — what `chdir` looks up
    /// to move ONE conversation's directory and republish its `attached`
    /// (the cwd is causal; agent-spec scenario a4). The instance-wide `cwd`
    /// line never reaches in here: it moves the process's own default,
    /// nothing already being served.
    served: ServedCwds,
    /// The instance's own default cwd — an in-memory value, seeded from the
    /// process's directory at boot but never read back from the OS again:
    /// what a spawn/adopt with no `cwd` of its own takes. The instance-wide
    /// `cwd` line writes here, and only here — it never calls
    /// `set_current_dir`, so the bridge process's real working directory is
    /// simply never touched by any control line.
    default_cwd: Arc<RwLock<std::path::PathBuf>>,
    /// The path-scoped permission matrix (permissions.rs): one scoped blob,
    /// live-repointable by a `permissions` control line, same discipline as
    /// `skills_root`. Strict-default until a line sets it: every gated
    /// operation asks, identical to bridge's behavior before this existed.
    permissions: Arc<RwLock<permissions::PermissionSet>>,
}

/// Resolve a spawn/adopt/chdir's own `cwd` field against expand_tilde and
/// the filesystem: `None` (or an absent field) falls back to `default` —
/// the instance's own default cwd cell, an in-memory value, NEVER the
/// bridge process's actual OS directory. Nothing in bridge ever calls
/// `set_current_dir`: cwd is purely a per-conversation value now, and
/// mutating the real process directory would be observable, global, racy
/// state no purely in-memory design needs. A named path that does not
/// exist or is not a directory is an error, not a silent fallback — unlike
/// `skills`'s tolerant repoint, a conversation's cwd gates every
/// path-touching tool for its whole life, so a typo caught now is cheaper
/// than one caught by a confusing permission denial later.
fn resolve_cwd(
    raw: Option<&str>,
    default: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    match raw {
        Some(raw) => validate_dir(&expand_tilde(raw)),
        None => Ok(default.to_path_buf()),
    }
}

/// The actual filesystem check behind a named cwd: canonicalize, then
/// confirm it's a directory. Shared by `resolve_cwd`'s named-path arm and
/// `apply_chdir`, which has no default to fall back to (its `cwd` is
/// required, checked by the caller before either ever runs).
fn validate_dir(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|e| format!("cwd {} does not exist or is unreadable: {e}", path.display()))
        .and_then(|p| {
            if p.is_dir() {
                Ok(p)
            } else {
                Err(format!("cwd {} is not a directory", p.display()))
            }
        })
}

/// Why a `chdir` line didn't move anything: distinct from a spawn/adopt's
/// own cwd error only in that "no such conversation" is possible here (a
/// spawn/adopt has no conversation yet to fail to find).
#[derive(Debug, PartialEq, Eq)]
enum ChdirError {
    NotFound,
    Invalid(String),
}

/// Move ONE served conversation's cwd cell — pure over `served`, no NATS:
/// publishing `attached` on success is the caller's job once this returns
/// Ok. Never mutates the cell on an invalid path; an unknown conversation id
/// is `NotFound` regardless of whether the path itself would have resolved.
fn apply_chdir(
    served: &ServedCwds,
    conv: &str,
    raw_cwd: &str,
) -> Result<std::path::PathBuf, ChdirError> {
    let cell = served
        .read()
        .unwrap()
        .get(conv)
        .map(Arc::clone)
        .ok_or(ChdirError::NotFound)?;
    let resolved = validate_dir(&expand_tilde(raw_cwd)).map_err(ChdirError::Invalid)?;
    *cell.write().unwrap() = resolved.clone();
    Ok(resolved)
}

impl Host {
    /// Build the config for a new or adopted conversation from the live
    /// cells. `cwd` is this conversation's own working directory — captured
    /// once here, independent of bridge's shared instance-wide cwd
    /// thereafter (a later `cwd` control line moves the instance's default
    /// for conversations not yet spawned; it never yanks a running
    /// conversation's directory around, the way `attached`'s cwd used to).
    fn config(
        &self,
        conv: &str,
        model: Arc<RwLock<String>>,
        cwd: Arc<RwLock<std::path::PathBuf>>,
    ) -> agent::AgentConfig {
        agent::AgentConfig {
            conv: wire::ConversationId(conv.to_string()),
            model,
            system: Arc::clone(&self.system),
            context: Arc::clone(&self.context),
            auth: self.auth.clone(),
            http: self.http.clone(),
            skills_root: Arc::clone(&self.skills_root),
            refs: Arc::clone(&self.refs),
            memory: Arc::clone(&self.memory),
            history: Arc::clone(&self.history),
            thinking_budget: self.thinking_budget,
            attach: self.attach.clone(),
            cwd,
            permissions: Arc::clone(&self.permissions),
        }
    }

    /// Carry out one control line, writing its single response to stdout.
    async fn handle(&self, value: serde_json::Value) {
        if let Some(spawn) = value.get("spawn") {
            let conv = uuid::Uuid::new_v4().to_string();
            // A named model pins its own cell; none shares the live default,
            // so a later `model` line reaches this conversation's next turn.
            let model = match spawn.get("model").and_then(serde_json::Value::as_str) {
                Some(m) => Arc::new(RwLock::new(m.to_string())),
                None => Arc::clone(&self.default_model),
            };
            // This conversation's own cwd (agent-spec's `service` carries
            // one per conversation) — absent, it falls back to the instance's
            // current directory, same as before this existed.
            let default_cwd = self.default_cwd.read().unwrap().clone();
            let cwd = match resolve_cwd(
                spawn.get("cwd").and_then(serde_json::Value::as_str),
                &default_cwd,
            ) {
                Ok(p) => p,
                Err(e) => {
                    println!("{}", serde_json::json!({ "error": e }));
                    return;
                }
            };
            let config = self.config(&conv, model, Arc::new(RwLock::new(cwd)));
            let Some(conv) = serve_conversation(
                &self.client,
                &self.world,
                &self.instance,
                &self.served,
                config,
                decisions::Conversation::default(),
            )
            .await
            else {
                return;
            };
            println!("{}", serde_json::json!({ "conversationId": conv }));
        } else if let Some(adopt) = value.get("adopt") {
            let Some(conv) = adopt
                .get("conversationId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
            else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "adopt needs conversationId" })
                );
                return;
            };
            let stream_name =
                std::env::var("BRIDGE_STREAM").unwrap_or_else(|_| "conv-approval".into());
            let messages =
                match replay_conversation(&self.client, &stream_name, &conv, &self.attach).await {
                    Ok(m) => m,
                    Err(e) => {
                        eprintln!("bridge: adopt failed for {conv}: {e:#}");
                        println!("{}", serde_json::json!({ "error": "replay failed" }));
                        return;
                    }
                };
            let adopted = messages.len();
            let default_cwd = self.default_cwd.read().unwrap().clone();
            let cwd = match resolve_cwd(
                adopt.get("cwd").and_then(serde_json::Value::as_str),
                &default_cwd,
            ) {
                Ok(p) => p,
                Err(e) => {
                    println!("{}", serde_json::json!({ "error": e }));
                    return;
                }
            };
            let config = self.config(
                &conv,
                Arc::clone(&self.default_model),
                Arc::new(RwLock::new(cwd)),
            );
            let Some(conv) = serve_conversation(
                &self.client,
                &self.world,
                &self.instance,
                &self.served,
                config,
                decisions::Conversation::adopt(messages),
            )
            .await
            else {
                return;
            };
            println!(
                "{}",
                serde_json::json!({ "conversationId": conv, "adoptedMessages": adopted })
            );
        } else if let Some(skills) = value.get("skills") {
            // Repoint the skills directory live. The change reaches every
            // running conversation on its next say (as a delta) and new spawns
            // whole; nothing already committed is touched.
            let Some(dir) = skills.get("dir").and_then(serde_json::Value::as_str) else {
                println!("{}", serde_json::json!({ "error": "skills needs dir" }));
                return;
            };
            // A control line is JSON over stdio, never a shell — nothing else
            // will ever expand a leading `~`, so this is the one place it can
            // happen; without it, a `~/...` path silently sets an unreadable
            // directory with no clue why.
            let path = expand_tilde(dir);
            *self.skills_root.write().unwrap() = path.clone();
            eprintln!("bridge: skills dir → {}", path.display());
            // Setting the config is never rejected — the directory might not
            // exist yet, or might arrive before it does — but a missing or
            // non-directory path is silent otherwise, so it's surfaced as a
            // warning alongside the (always successful) set.
            let mut response = serde_json::json!({ "skillsDir": path.to_string_lossy() });
            match std::fs::metadata(&path) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => {
                    let warning = format!("{} exists but is not a directory", path.display());
                    eprintln!("bridge: skills dir warning: {warning}");
                    response["warning"] = serde_json::json!(warning);
                }
                Err(e) => {
                    let warning =
                        format!("{} does not exist or is unreadable: {e}", path.display());
                    eprintln!("bridge: skills dir warning: {warning}");
                    response["warning"] = serde_json::json!(warning);
                }
            }
            println!("{response}");
        } else if let Some(system) = value.get("system") {
            // The API system prompt, read fresh each turn; never persisted.
            let Some(text) = system.as_str() else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "system needs a string" })
                );
                return;
            };
            *self.system.write().unwrap() = Some(text.to_string());
            eprintln!("bridge: system prompt set ({} chars)", text.len());
            println!("{}", serde_json::json!({ "system": "set" }));
        } else if let Some(perms) = value.get("permissions") {
            // One scoped blob, sent whole, replacing whatever was there —
            // no partial edits, the sender already holds the full list.
            // Existing conversations' AgentConfig shares this same Arc, so
            // a repoint reaches every running conversation's next check.
            match serde_json::from_value::<permissions::PermissionSet>(perms.clone()) {
                Ok(set) => {
                    *self.permissions.write().unwrap() = set;
                    eprintln!("bridge: permissions repointed");
                    println!("{}", serde_json::json!({ "permissions": "ok" }));
                }
                Err(e) => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("invalid permissions: {e}") })
                    );
                }
            }
        } else if let Some(model) = value.get("model") {
            // The live default cell: new spawns that name no model take it,
            // and every running conversation sharing it picks the change up
            // on its next say. A spawn that named its own model stays pinned.
            let Some(text) = model.as_str() else {
                println!("{}", serde_json::json!({ "error": "model needs a string" }));
                return;
            };
            *self.default_model.write().unwrap() = text.to_string();
            eprintln!("bridge: default model set ({text})");
            println!("{}", serde_json::json!({ "model": text }));
        } else if let Some(cwd) = value.get("cwd") {
            // The instance's own default cwd — an in-memory cell, nothing
            // more: what a spawn/adopt with no `cwd` of its own resolves
            // against next. Never the bridge process's actual OS directory
            // (no `set_current_dir` here, ever) and never reaches into a
            // conversation already being served; that is `chdir`'s job,
            // scoped to one conversationId, never this one's.
            let Some(path) = cwd.as_str() else {
                println!("{}", serde_json::json!({ "error": "cwd needs a string" }));
                return;
            };
            match validate_dir(&expand_tilde(path)) {
                Ok(resolved) => {
                    let now = resolved.to_string_lossy().to_string();
                    *self.default_cwd.write().unwrap() = resolved;
                    eprintln!("bridge: default cwd → {now}");
                    println!("{}", serde_json::json!({ "cwd": now }));
                }
                Err(e) => {
                    println!("{}", serde_json::json!({ "error": e }));
                }
            }
        } else if let Some(chdir) = value.get("chdir") {
            // Move ONE conversation's cwd (agent-spec's `chdir` request,
            // scoped to a conversationId) without touching the instance
            // default or any other conversation this instance serves.
            let Some(conv) = chdir
                .get("conversationId")
                .and_then(serde_json::Value::as_str)
            else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "chdir needs conversationId" })
                );
                return;
            };
            let Some(path) = chdir.get("cwd").and_then(serde_json::Value::as_str) else {
                println!("{}", serde_json::json!({ "error": "chdir needs cwd" }));
                return;
            };
            match apply_chdir(&self.served, conv, path) {
                Ok(resolved) => {
                    let now = resolved.to_string_lossy().to_string();
                    eprintln!("bridge[{conv}]: cwd → {now}");
                    publish_agent(
                        &self.client,
                        &self.world,
                        "attached",
                        serde_json::json!({
                            "ts": now_iso(),
                            "instanceId": self.instance,
                            "conversationId": conv,
                            "cwd": now,
                        }),
                    )
                    .await;
                    println!("{}", serde_json::json!({ "conversationId": conv, "cwd": now }));
                }
                Err(ChdirError::NotFound) => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("not serving conversation {conv}") })
                    );
                }
                Err(ChdirError::Invalid(e)) => {
                    println!("{}", serde_json::json!({ "error": e }));
                }
            }
        } else if let Some(context) = value.get("context") {
            // User context, injected at a conversation's birth and committed.
            let Some(text) = context.as_str() else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "context needs a string" })
                );
                return;
            };
            *self.context.write().unwrap() = Some(text.to_string());
            eprintln!("bridge: context set ({} chars)", text.len());
            println!("{}", serde_json::json!({ "context": "set" }));
        } else if let Some(revise) = value.get("revise") {
            // Correct a committed message's content under its stable id
            // (conversation-spec: revision) — a trim, a resize, or a bug fix
            // in how the content was built the first time. Never mutates the
            // original event: the record is append-only, and replay folds
            // this as the message's new latest state (last-write-wins per
            // id, main.rs's `replay_conversation`).
            let (conv, message_id, content) = (
                revise
                    .get("conversationId")
                    .and_then(serde_json::Value::as_str),
                revise.get("messageId").and_then(serde_json::Value::as_str),
                revise.get("content").and_then(serde_json::Value::as_array),
            );
            let (Some(conv), Some(message_id), Some(content)) = (conv, message_id, content) else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "revise needs conversationId, messageId, content" })
                );
                return;
            };
            let subject = format!("conv.v2.{conv}.changes.revision");
            let payload = serde_json::json!({
                "ts": wire::now_iso(),
                "messageId": message_id,
                "content": content,
            });
            let bytes = serde_json::to_vec(&payload).expect("json of plain values cannot fail");
            eprintln!("bridge: → {subject} ({} B)", bytes.len());
            match self.client.publish(subject, bytes.into()).await {
                Ok(()) => println!(
                    "{}",
                    serde_json::json!({ "conversationId": conv, "revisedMessage": message_id })
                ),
                Err(e) => {
                    eprintln!("bridge: revise publish failed: {e}");
                    println!("{}", serde_json::json!({ "error": "publish failed" }));
                }
            }
        } else if value.get("settings").is_some() {
            // A live snapshot of every control-line-settable cell plus the
            // static config — the read half of skills/system/context, which
            // until now could be set but never queried back.
            let skills_dir = self.skills_root.read().unwrap().clone();
            let skills_dir_exists = std::fs::metadata(&skills_dir).is_ok_and(|m| m.is_dir());
            let system = self.system.read().unwrap().clone();
            let context = self.context.read().unwrap().clone();
            println!(
                "{}",
                serde_json::json!({
                    "settings": {
                        "world": self.world,
                        "instance": self.instance,
                        "cwd": self.default_cwd.read().unwrap().to_string_lossy(),
                        "model": self.default_model.read().unwrap().clone(),
                        "thinkingBudget": self.thinking_budget,
                        "attachBucket": self.attach_bucket,
                        "skillsDir": skills_dir.to_string_lossy(),
                        "skillsDirExists": skills_dir_exists,
                        "system": system,
                        "context": context,
                        "refsDb": self.refs_path.to_string_lossy(),
                        "memoryDb": self.memory_path.to_string_lossy(),
                        "historyDb": self.history_path.to_string_lossy(),
                        "permissions": self.permissions.read().unwrap().resolved(),
                    }
                })
            );
        } else {
            println!("{}", serde_json::json!({ "error": "unsupported" }));
        }
    }
}

/// Parse one control line and hand it to the host. Shared by the -c batch and
/// the live stdin loop, so both surfaces answer identically.
async fn handle_line(host: &Host, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        println!("{}", serde_json::json!({ "error": "unparseable" }));
        return;
    };
    host.handle(value).await;
}

/// The -c batch: `-c <lines>` or `-c=<lines>`, newline-separated control lines
/// run before stdin takes over. None when the flag is absent.
fn c_flag(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-c" {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix("-c=") {
            return Some(v.to_string());
        }
    }
    None
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Which build this is: the cheapest guard against running a stale binary.
    eprintln!(
        "bridge {} ({}) built {}",
        env!("CARGO_PKG_VERSION"),
        env!("BRIDGE_GIT_HASH"),
        env!("BRIDGE_BUILD_TIME"),
    );
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    // ANTHROPIC_API_KEY when set; otherwise the Claude Code OAuth token.
    let auth = anthropic::Auth::resolve()?;
    let default_model = std::env::var("BRIDGE_MODEL").unwrap_or_else(|_| "claude-sonnet-5".into());
    // The world is a durable name for a place, deployer-chosen; the process
    // standing in it is disposable and mints a fresh instance id per boot.
    let world = std::env::var("BRIDGE_WORLD").unwrap_or_else(|_| "local".into());
    let instance = uuid::Uuid::new_v4().to_string();

    // The skills root, shared and mutable so a stdio `skills` control line can
    // repoint it live. No default: until a `skills` line (from -c or live
    // stdin) points it somewhere, the catalogue is empty and the Skill tool is
    // not offered. An empty path scans to an empty catalogue.
    let skills_root = Arc::new(RwLock::new(std::path::PathBuf::new()));
    // The transit object store attachments resolve from; must name the same
    // bucket the tower deployment uploads into.
    let attach_bucket = std::env::var("BRIDGE_ATTACH_BUCKET").unwrap_or_else(|_| "attach".into());
    // Extended thinking: on by default; BRIDGE_THINKING_BUDGET=0 disables.
    let thinking_budget = match std::env::var("BRIDGE_THINKING_BUDGET")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
    {
        Some(0) => None,
        Some(n) => Some(n),
        None => Some(4096),
    };
    // The oversized-tool-output store: content-addressed, ephemeral is fine
    // (unlike conversation state, losing it across a restart is not data
    // loss, only a stale ref id). Defaults under the OS temp dir so no new
    // config is required to get it working.
    let refs_path = std::env::var("BRIDGE_REFS_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("bridge-refs.db"));
    let refs_store = refs::open(&refs_path).map_err(|e| anyhow::anyhow!(e))?;
    let refs_path_for_settings = refs_path.clone();
    // Shared with claude-sdk-cli's own SqliteMemoryEngine — same file, same
    // schema, so a memory either process writes is visible to the other.
    let memory_path = std::env::var("BRIDGE_MEMORY_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            bridge::home::home_dir()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".claude")
                .join("memory.db")
        });
    let memory_store = memory::open(&memory_path).map_err(|e| anyhow::anyhow!(e))?;
    let memory_path_for_settings = memory_path.clone();
    // Shared with claude-sdk-cli's own SqliteHistoryEngine — same file, same
    // schema. Written best-effort on every committed message (agent.rs's
    // Publisher::message), read by SearchHistory/ReadHistory.
    let history_path = std::env::var("BRIDGE_HISTORY_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            bridge::home::home_dir()
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".claude")
                .join("history.db")
        });
    let history_store = history::open(&history_path).map_err(|e| anyhow::anyhow!(e))?;
    let history_path_for_settings = history_path.clone();

    let client = async_nats::connect(&nats_url).await.with_context(|| {
        format!(
            "could not reach NATS at {nats_url} — is it running? (docker compose up -d, or set NATS_URL)"
        )
    })?; // fail-fast

    // The attach pipes are set only by a local TUI's spawn, never by tower.
    // Presence alone is worth a startup line — this is the one place bridge
    // ever says it has a second, non-NATS interface live. Two one-way pipes,
    // not a duplex socket: the down sender tees events and replies; the up
    // recver serves the client's requests, proxied onto NATS here so the
    // client dials no broker.
    let attach = bridge::attach::attach_stream().map(|(down_tx, up_rx)| {
        let handle = std::sync::Arc::new(tokio::sync::Mutex::new(down_tx));
        tokio::spawn(bridge::attach::serve_requests(
            up_rx,
            std::sync::Arc::clone(&handle),
            client.clone(),
            attach_bucket.clone(),
        ));
        handle
    });
    eprintln!(
        "bridge: attach channel {}",
        if attach.is_some() {
            "present (BRIDGE_ATTACH_FD_DOWN/_UP)"
        } else {
            "absent"
        }
    );

    // Ready once subscriptions can be made, then the liveness promise: "you
    // will hear from me again within PULSE_INTERVAL_S seconds". One pulse per
    // instance, never per conversation.
    publish_agent(
        &client,
        &world,
        "ready",
        // version/gitHash/buildTime ride the wire alongside instanceId — the
        // same build banner main() prints locally, but durable and queryable
        // now: "which build served this world" no longer dies with whoever's
        // terminal happened to be open at boot.
        serde_json::json!({
            "ts": now_iso(),
            "instanceId": instance,
            "version": env!("CARGO_PKG_VERSION"),
            "gitHash": env!("BRIDGE_GIT_HASH"),
            "buildTime": env!("BRIDGE_BUILD_TIME"),
        }),
    )
    .await;
    {
        let client = client.clone();
        let world = world.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            let mut tick =
                tokio::time::interval(std::time::Duration::from_secs(PULSE_INTERVAL_S as u64));
            loop {
                tick.tick().await;
                publish_agent(
                    &client,
                    &world,
                    "pulse",
                    serde_json::json!({
                        "ts": now_iso(),
                        "instanceId": instance,
                        "intervalS": PULSE_INTERVAL_S,
                    }),
                )
                .await;
            }
        });
    }

    // Host: the shared config and live cells every control line reads. One
    // grammar, two delivery points — the -c batch, then live stdin.
    let default_model = Arc::new(RwLock::new(default_model));
    let host = Host {
        client: client.clone(),
        world,
        instance,
        default_model,
        refs: refs_store,
        memory: memory_store,
        history: history_store,
        refs_path: refs_path_for_settings,
        memory_path: memory_path_for_settings,
        history_path: history_path_for_settings,
        attach,
        served: Arc::new(RwLock::new(HashMap::new())),
        default_cwd: Arc::new(RwLock::new(
            std::env::current_dir().unwrap_or_default(),
        )),
        auth,
        http: anthropic::build_http_client(),
        skills_root,
        system: Arc::new(RwLock::new(None)),
        context: Arc::new(RwLock::new(None)),
        attach_bucket,
        thinking_budget,
        permissions: Arc::new(RwLock::new(permissions::PermissionSet::strict_default())),
    };

    // -c: a batch of control lines run before stdin takes over. Each writes its
    // response to stdout, so a launcher reads back a spawn's conversationId.
    // A streamed parse, not a newline split: a value is whatever JSON says it
    // is, not whatever fit on one line — a hand-written, pretty-printed
    // `{"permissions": [...]}` spanning several lines is exactly as valid a
    // single value as one crammed onto one line, and splitting on '\n' first
    // would shred it into fragments that are each invalid (or worse, valid
    // but meaningless) on their own.
    let args: Vec<String> = std::env::args().collect();
    if let Some(batch) = c_flag(&args) {
        for parsed in serde_json::Deserializer::from_str(&batch).into_iter::<serde_json::Value>() {
            match parsed {
                Ok(value) => host.handle(value).await,
                Err(e) => println!(
                    "{}",
                    serde_json::json!({ "error": format!("invalid JSON in -c batch: {e}") })
                ),
            }
        }
    }

    // The live stdio control loop: one JSON object per line in, one per line
    // out. Unknown lines are answered; compliance is answering, on every
    // surface.
    let tool_names: Vec<String> = agent::static_tool_schemas()
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_owned))
        .collect();
    eprintln!(
        "bridge: tools: {} (+ Skill once a catalogue is set)",
        tool_names.join(", ")
    );
    eprintln!(
        "bridge: ready (model {}); spawn with {{\"spawn\":{{}}}} (optionally {{\"cwd\":\"...\"}})",
        host.default_model.read().unwrap()
    );
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        handle_line(&host, &line).await;
    }
    // stdin closed: the control channel is the lifetime. Whoever spawned
    // bridge holds its stdin; when they let go, bridge is done.
    eprintln!("bridge: stdin closed, exiting");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ChdirError, ServedCwds, apply_chdir, expand_tilde, resolve_cwd};
    use std::collections::HashMap;
    use std::sync::{Arc, RwLock};

    fn scratch_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bridge-cwd-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        // Canonical, matching what resolve_cwd itself returns (macOS's
        // /tmp is a symlink into /private/tmp) — otherwise every equality
        // assertion below would compare a symlinked path to its target.
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn resolve_cwd_of_none_falls_back_to_the_given_default() {
        let default = scratch_dir();
        assert_eq!(resolve_cwd(None, &default).unwrap(), default);
        std::fs::remove_dir(&default).unwrap();
    }

    #[test]
    fn resolve_cwd_of_an_existing_directory_canonicalizes_it_ignoring_the_default() {
        let dir = scratch_dir();
        let unused_default = std::path::PathBuf::from("/does/not/matter");
        assert_eq!(
            resolve_cwd(Some(dir.to_str().unwrap()), &unused_default).unwrap(),
            dir
        );
        std::fs::remove_dir(&dir).unwrap();
    }

    #[test]
    fn resolve_cwd_of_a_missing_path_errors() {
        let missing =
            std::env::temp_dir().join(format!("bridge-cwd-missing-{}", uuid::Uuid::new_v4()));
        assert!(resolve_cwd(Some(missing.to_str().unwrap()), &std::env::temp_dir()).is_err());
    }

    #[test]
    fn resolve_cwd_of_a_file_not_a_directory_errors() {
        let file = std::env::temp_dir().join(format!("bridge-cwd-file-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"not a directory").unwrap();
        assert!(resolve_cwd(Some(file.to_str().unwrap()), &std::env::temp_dir()).is_err());
        std::fs::remove_file(&file).unwrap();
    }

    fn served_with(conv: &str, cwd: std::path::PathBuf) -> ServedCwds {
        let mut map = HashMap::new();
        map.insert(conv.to_string(), Arc::new(RwLock::new(cwd)));
        Arc::new(RwLock::new(map))
    }

    #[test]
    fn chdir_of_an_unserved_conversation_is_not_found() {
        let served = served_with("a", std::env::temp_dir());
        assert_eq!(
            apply_chdir(&served, "unknown", "/anywhere").unwrap_err(),
            ChdirError::NotFound
        );
    }

    #[test]
    fn chdir_moves_only_the_named_conversations_cell() {
        let dir_a = scratch_dir();
        let dir_b = scratch_dir();
        let dir_new = scratch_dir();
        let served = served_with("a", dir_a.clone());
        served
            .write()
            .unwrap()
            .insert("b".to_string(), Arc::new(RwLock::new(dir_b.clone())));

        let resolved = apply_chdir(&served, "a", dir_new.to_str().unwrap()).unwrap();
        assert_eq!(resolved, dir_new);
        assert_eq!(*served.read().unwrap()["a"].read().unwrap(), dir_new);
        assert_eq!(*served.read().unwrap()["b"].read().unwrap(), dir_b);

        for dir in [dir_a, dir_b, dir_new] {
            std::fs::remove_dir(&dir).unwrap();
        }
    }

    #[test]
    fn chdir_to_an_invalid_path_leaves_the_cell_untouched() {
        let dir_a = scratch_dir();
        let served = served_with("a", dir_a.clone());
        let missing = std::env::temp_dir().join(format!("bridge-cwd-missing-{}", uuid::Uuid::new_v4()));

        let err = apply_chdir(&served, "a", missing.to_str().unwrap()).unwrap_err();
        assert!(matches!(err, ChdirError::Invalid(_)));
        assert_eq!(*served.read().unwrap()["a"].read().unwrap(), dir_a);

        std::fs::remove_dir(&dir_a).unwrap();
    }

    #[test]
    fn expands_a_leading_tilde_slash_to_home() {
        let home = std::env::var("HOME").expect("HOME set in test environment");
        let expanded = expand_tilde("~/repos/skills");
        assert_eq!(
            expanded,
            std::path::PathBuf::from(home).join("repos/skills")
        );
    }

    #[test]
    fn expands_a_bare_tilde_to_home() {
        let home = std::env::var("HOME").expect("HOME set in test environment");
        assert_eq!(expand_tilde("~"), std::path::PathBuf::from(home));
    }

    #[test]
    fn leaves_an_absolute_path_unchanged() {
        assert_eq!(
            expand_tilde("/abs/path"),
            std::path::PathBuf::from("/abs/path")
        );
    }

    #[test]
    fn leaves_a_relative_path_unchanged() {
        assert_eq!(
            expand_tilde("rel/path"),
            std::path::PathBuf::from("rel/path")
        );
    }

    #[test]
    fn does_not_expand_a_tilde_that_is_not_a_path_prefix() {
        // "~foo" (another user's home) is deliberately not handled — only
        // the bare current-user forms (`~`, `~/...`) are.
        assert_eq!(
            expand_tilde("~foo/bar"),
            std::path::PathBuf::from("~foo/bar")
        );
    }
}
