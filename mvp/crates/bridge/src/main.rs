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
//! boot, a `pulse` every PULSE_INTERVAL_S, on agent.v1 (unchanged by the
//! attachment migration — only Attachment moved off that tree). The world
//! is deployer-chosen (`BRIDGE_WORLD`, default `local`); the instance id is
//! generated per process, so a restart is a new instance in the same world.
//!
//! Attachment claims ride the CONVERSATION's own tree now
//! (conversation-spec.md, Attachment; agent-spec.md, Attachment): `attached`
//! exactly once per spawn/adopt, `moved` on `chdir` (never a re-published
//! `attached` — that is now the violation shape), and each servicer watches
//! its own conversations' attachment leaves so a displacement (another
//! instance's `attached` superseding this one) is observed and answered
//! with `detached` — the same act of standing-down the spec describes for a
//! zombie catching up to its own history. Clean exit still publishes
//! nothing in v0 (conversations die with the host); a crash publishes
//! nothing either, and the pulse going silent is what observers fold.

mod agent;
mod anthropic;
mod approval;
mod cwd;
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
#[cfg(test)]
mod testsupport;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, BufReader};
use wire::now_iso;

use crate::anthropic::{DeltaSink, NatsDeltaSink};
use bridge::broker::{Broker, BrokerMessage, BrokerReplay, BrokerSubscription, NatsBroker};
use cwd::{ChdirError, ServedCwds, apply_chdir, resolve_cwd, validate_dir};

const PULSE_INTERVAL_S: i64 = 30;

/// Expand a leading `~` or `~/...` to `$HOME`. A control line is JSON over
/// stdio, never a shell, so this is the only place a `~`-prefixed path is
/// ever resolved — anywhere else, it stays a literal tilde character.
pub(crate) fn expand_tilde(path: &str) -> std::path::PathBuf {
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

/// Fold one replayed frame into the tree's committed messages and the
/// pending revisions map — the per-frame step both the streaming shell
/// (`replay_conversation`) and the literal-batch test (`fold_replay`) share,
/// so a message and a later revision for the same id fold the same way
/// whether they arrive one at a time off the wire or as a seeded slice.
/// Tolerance: a frame that doesn't parse as a conv change is skipped (the
/// filter admits query/tip_moved too now; only message and revision matter
/// here).
fn fold_one(
    msg: &BrokerMessage,
    messages: &mut Vec<decisions::Message>,
    revisions: &mut std::collections::HashMap<String, Vec<serde_json::Value>>,
) {
    let Some(wire::WireEvent::Conv(event)) = wire::parse_wire(&msg.subject, &msg.payload) else {
        return;
    };
    match event.kind {
        wire::EventKind::Change(wire::ConvChange::Message(m)) => {
            messages.push(decisions::Message {
                id: m.id.0,
                role: m.role,
                content: m.content,
            });
        }
        // Revisions can arrive before or after the message they correct (a
        // fix minted later in stream order) and the record keeps every one
        // — only the last written per id is the current state, so a later
        // revision in stream order always overwrites an earlier one here,
        // applied once the whole backlog is read.
        wire::EventKind::Change(wire::ConvChange::Revision(r)) => {
            revisions.insert(r.message_id.0, r.content);
        }
        _ => {}
    }
}

/// Apply every pending revision, last-write-wins per id, once the whole
/// backlog (or the seeded batch, in the test) has been folded through
/// `fold_one` — shared so the streaming shell and the pure batch test
/// finish identically, never each carrying its own copy of this loop.
fn apply_revisions(
    messages: &mut [decisions::Message],
    revisions: &mut std::collections::HashMap<String, Vec<serde_json::Value>>,
) {
    for message in messages {
        if let Some(content) = revisions.remove(&message.id) {
            message.content = content;
        }
    }
}

/// The pure fold over an already-collected batch: proves `fold_one` and
/// `apply_revisions` finish without a broker at all, given a literal slice
/// of frames. Test-only: nothing in the production path collects a batch
/// first any more (see `replay_conversation`), so this never ships in the
/// binary.
#[cfg(test)]
fn fold_replay(raw: &[BrokerMessage]) -> Vec<decisions::Message> {
    let mut messages = Vec::new();
    let mut revisions = std::collections::HashMap::new();
    for msg in raw {
        fold_one(msg, &mut messages, &mut revisions);
    }
    apply_revisions(&mut messages, &mut revisions);
    messages
}

/// Replay a conversation's committed messages from the capture stream, in
/// stream order (= commit order), with every revision folded in —
/// conversation-spec: "the state of a message is its latest revision"
/// (last-write-wins per id; every prior revision, like every message,
/// remains in the record, but replay only ever hands the servicer the
/// current state). Telemetry, deltas and tip movements stay observation,
/// not replayed.
///
/// Frame by frame on this side — teed and folded as each arrives, rather
/// than collected into a `Vec` here first — so this shell doesn't hold a
/// second full copy of the backlog on top of whatever the client already
/// buffers. That said: `Broker::replay`'s own `fetch().max_messages(pending)`
/// call still asks the async-nats client for the whole pending count as one
/// batch, exactly as the pre-refactor code did — genuine paging (bounding
/// memory against an arbitrarily large backlog, independent of the client's
/// own buffering) was never implemented here and is deferred as an
/// improvement outside this behaviour-preserving refactor.
///
/// A mid-replay read failure the client actually surfaces fails loudly
/// (`?` below) rather than reading as a clean end. Scoped: a fetch that
/// simply expires short of the pending count with no error at all is a
/// separate, real hole (see `BrokerReplay`'s own doc) — deferred, not closed
/// here.
async fn replay_conversation<B: Broker>(
    broker: &B,
    stream_name: &str,
    conv: &str,
    attach: &Option<bridge::attach::AttachHandle>,
) -> anyhow::Result<Vec<decisions::Message>> {
    let mut replay = broker
        .replay(stream_name.to_string(), format!("conv.v2.{conv}.changes.>"))
        .await
        .context("adopt needs the capture")?;
    let mut messages = Vec::new();
    let mut revisions = std::collections::HashMap::new();
    while let Some(msg) = replay.next().await {
        let msg = msg?;
        // History reaches an attached client as the same envelopes the live
        // tee sends — the record replayed, not a second history protocol.
        // The client's fold rebuilds the conversation exactly as fold_one
        // below does (last-write-wins per id).
        bridge::attach::tee(attach, &msg.subject, &msg.payload).await;
        fold_one(&msg, &mut messages, &mut revisions);
    }
    apply_revisions(&mut messages, &mut revisions);
    Ok(messages)
}

async fn publish_agent<B: Broker>(broker: &B, world: &str, leaf: &str, payload: serde_json::Value) {
    let subject = format!("agent.v1.{world}.telemetry.{leaf}");
    let bytes = serde_json::to_vec(&payload).expect("json! of plain values cannot fail");
    // The pulse fires every PULSE_INTERVAL_S; logging it is pure noise. The
    // facts worth seeing are ready/attached/detached.
    if leaf != "pulse" {
        eprintln!("{} bridge: → {subject} ({} B)", now_iso(), bytes.len());
    }
    if let Err(e) = broker.publish(subject, bytes).await {
        eprintln!(
            "bridge: agent telemetry publish failed: {:#}",
            anyhow::Error::new(e)
        );
    }
}

/// The attachment claim, on the conversation's own tree now
/// (conversation-spec.md, Attachment): `attached`, `moved`, `detached`
/// carry the full `(world, instanceId)` pair, per agent-spec.md's Attachment.
async fn publish_conv_attachment<B: Broker>(
    broker: &B,
    conv: &str,
    leaf: &str,
    payload: serde_json::Value,
) {
    let subject = format!("conv.v2.{conv}.attachment.{leaf}");
    let bytes = serde_json::to_vec(&payload).expect("json! of plain values cannot fail");
    eprintln!(
        "{} bridge[{conv}]: → {subject} ({} B)",
        now_iso(),
        bytes.len()
    );
    if let Err(e) = broker.publish(subject, bytes).await {
        eprintln!(
            "bridge[{conv}]: attachment publish failed: {:#}",
            anyhow::Error::new(e)
        );
    }
}

/// Watch this conversation's own attachment leaf for a displacement: another
/// instance's `attached` superseding ours (agent-spec.md, Attachment — "a
/// compliant instance watches the attachment leaf for every conversation it
/// serves"). On seeing one, stop serving (abort the running query task) and
/// publish `detached` — the observable act of standing down; the fold
/// already moved the claim, so this changes nothing but makes compliance
/// visible in the record.
async fn watch_attachment<B: Broker>(
    broker: B,
    conv: String,
    world: String,
    instance: String,
    abort: tokio::task::AbortHandle,
) {
    let mut sub = match broker
        .subscribe(format!("conv.v2.{conv}.attachment.>"))
        .await
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "bridge[{conv}]: attachment watch subscribe failed: {:#}",
                anyhow::Error::new(e)
            );
            return;
        }
    };
    while let Some(msg) = sub.next().await {
        if !msg.subject.ends_with(".attachment.attached") {
            continue;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&msg.payload) else {
            continue;
        };
        let their_instance = value.get("instanceId").and_then(serde_json::Value::as_str);
        let their_world = value.get("world").and_then(serde_json::Value::as_str);
        if their_instance == Some(instance.as_str()) && their_world == Some(world.as_str()) {
            continue; // our own claim, not a displacement
        }
        eprintln!("bridge[{conv}]: displaced by {their_world:?}/{their_instance:?}; standing down");
        abort.abort();
        publish_conv_attachment(
            &broker,
            &conv,
            "detached",
            serde_json::json!({ "ts": now_iso(), "instanceId": instance, "world": world }),
        )
        .await;
        break;
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
/// Returns the conversation id and a handle to the spawned servicer task on
/// success (the caller writes the stdout reply; a test awaits the handle
/// before tearing down anything the task still holds, e.g. a scratch dir's
/// sqlite files); None means the subscription could not be made - the error
/// line is already written, so the caller moves on.
async fn serve_conversation<B: Broker, D: DeltaSink>(
    broker: &B,
    sink: D,
    world: &str,
    instance: &str,
    served: &ServedCwds,
    config: agent::AgentConfig,
    conversation: decisions::Conversation,
) -> Option<(String, tokio::task::JoinHandle<()>)> {
    let conv = config.conv.0.clone();
    let requests = match agent::subscribe(broker, &config.conv).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "bridge: subscribe failed for {conv}: {:#}",
                anyhow::Error::new(e)
            );
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
    // this conversation's cwd cell so `chdir` can look it up later.
    let cwd_cell = Arc::clone(&config.cwd);
    let cwd = cwd_cell.read().unwrap().to_string_lossy().to_string();
    served.write().unwrap().insert(conv.clone(), cwd_cell);
    let handle = tokio::spawn(agent::run(
        broker.clone(),
        sink,
        requests,
        config,
        conversation,
    ));
    // The attachment is what makes the conversation exist for observers
    // before its first message. cwd is causal (an input to how the
    // conversation unfolds). Rides the conversation's own tree now
    // (conversation-spec.md, Attachment), carrying the full identity pair.
    let attached = serde_json::json!({
        "ts": now_iso(),
        "instanceId": instance,
        "world": world,
        "tip": tip,
        "cwd": cwd,
        "intervalS": PULSE_INTERVAL_S,
    });
    publish_conv_attachment(broker, &conv, "attached", attached).await;
    // One instance per claim, watching its own conversation: a displacement
    // (another instance's `attached` superseding ours) is observed and
    // answered with `detached` (agent-spec.md, Attachment).
    tokio::spawn(watch_attachment(
        broker.clone(),
        conv.clone(),
        world.to_string(),
        instance.to_string(),
        handle.abort_handle(),
    ));
    Some((conv, handle))
}

/// The host's shared config and live cells. Every control line — from `-c` or
/// live stdin — reads through this; the cells are what a `skills`, `system`,
/// or `context` line repoints without a restart.
struct Host {
    broker: NatsBroker,
    delta: NatsDeltaSink,
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
    /// Every conversation's live cwd cell (cwd.rs), keyed by id.
    served: ServedCwds,
    /// The instance's own default cwd (cwd.rs's `resolve_cwd`), seeded from
    /// the process's directory at boot; the `cwd` control line writes here.
    default_cwd: Arc<RwLock<std::path::PathBuf>>,
    /// The path-scoped permission matrix (permissions.rs): one scoped blob,
    /// live-repointable by a `permissions` control line, same discipline as
    /// `skills_root`. Strict-default until a line sets it: every gated
    /// operation asks, identical to bridge's behavior before this existed.
    permissions: Arc<RwLock<permissions::PermissionSet>>,
}

impl Host {
    /// Build the config for a new or adopted conversation from the live
    /// cells.
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
            let Some((conv, _handle)) = serve_conversation(
                &self.broker,
                self.delta.clone(),
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
                match replay_conversation(&self.broker, &stream_name, &conv, &self.attach).await {
                    Ok(m) => m,
                    Err(e) => {
                        // `e` is already an `anyhow::Error` (via `?` in
                        // replay_conversation); `{:#}` renders its full
                        // chain, per CLAUDE.md's Errors rule — a bare `{e}`
                        // would drop the cause.
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
            let Some((conv, _handle)) = serve_conversation(
                &self.broker,
                self.delta.clone(),
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
            // The instance's own default cwd (cwd.rs); use `chdir` to move
            // a conversation that's already running.
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
            // Move one conversation's cwd (agent-spec's `chdir` request).
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
                    // A changed cwd is a fact about the standing claim, not
                    // a new one — `moved`, never a re-published `attached`
                    // (agent-spec.md, Attachment: that is now the violation
                    // shape).
                    publish_conv_attachment(
                        &self.broker,
                        conv,
                        "moved",
                        serde_json::json!({
                            "ts": now_iso(),
                            "instanceId": self.instance,
                            "world": self.world,
                            "cwd": now,
                        }),
                    )
                    .await;
                    println!(
                        "{}",
                        serde_json::json!({ "conversationId": conv, "cwd": now })
                    );
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
            match self.broker.publish(subject, bytes).await {
                Ok(()) => println!(
                    "{}",
                    serde_json::json!({ "conversationId": conv, "revisedMessage": message_id })
                ),
                Err(e) => {
                    eprintln!("bridge: revise publish failed: {:#}", anyhow::Error::new(e));
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
    let broker = NatsBroker {
        client: client.clone(),
    };
    let delta = NatsDeltaSink(client.clone());

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
        &broker,
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
        let broker = broker.clone();
        let world = world.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            let mut tick =
                tokio::time::interval(std::time::Duration::from_secs(PULSE_INTERVAL_S as u64));
            loop {
                tick.tick().await;
                publish_agent(
                    &broker,
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
        broker,
        delta,
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
        default_cwd: Arc::new(RwLock::new(std::env::current_dir().unwrap_or_default())),
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
    use super::{
        ServedCwds, decisions, expand_tilde, fold_replay, replay_conversation, serve_conversation,
    };
    use crate::anthropic::NoopDeltaSink;
    use crate::testsupport::config;
    use bridge::broker::BrokerMessage;
    use bridge_testkit::{FakeBroker, TestScratch};
    use std::collections::VecDeque;
    use std::sync::{Arc, RwLock};

    fn served() -> ServedCwds {
        Arc::new(RwLock::new(std::collections::HashMap::new()))
    }

    /// The fact the module doc names directly: a conversation that cannot
    /// hear requests is not spawned in any meaningful sense, so the
    /// subscribe must land before the `attached` publish that tells
    /// observers it exists.
    #[tokio::test]
    async fn subscription_is_made_before_attached_is_published() {
        let broker = FakeBroker::default();
        let scratch = TestScratch::new("serve-ordering");
        let served_conv = serve_conversation(
            &broker,
            NoopDeltaSink,
            "local",
            "instance-1",
            &served(),
            config("conv-a", &scratch),
            decisions::Conversation::default(),
        )
        .await;
        let Some((_conv, handle)) = served_conv else {
            panic!("expected a served conversation");
        };

        let calls = broker.calls.lock().unwrap().clone();
        let subscribe_at = calls
            .iter()
            .position(|c| c.starts_with("subscribe:"))
            .unwrap();
        let attached_at = calls
            .iter()
            .position(|c| c == "publish:conv.v2.conv-a.attachment.attached")
            .unwrap();
        assert!(subscribe_at < attached_at, "{calls:?}");

        // serve_conversation spawns agent::run fire-and-forget, holding the
        // config's sqlite handles into `scratch`'s own directory; await the
        // handle directly so `scratch` never drops while the task might
        // still be running (the fake subscription ends the loop immediately,
        // so this resolves right away).
        handle.await.unwrap();
    }

    /// Adopt must replay only the conversation record's own changes, never
    /// widen to `.requests.>` (a live request subject, not a capture-stream
    /// filter) or any other conversation's subjects.
    #[tokio::test]
    async fn adopt_replays_only_this_conversations_changes() {
        let broker = FakeBroker::default();
        broker
            .replay_data
            .lock()
            .unwrap()
            .insert("conv.v2.conv-x.changes.>".to_string(), VecDeque::new());

        replay_conversation(&broker, "conv-approval", "conv-x", &None)
            .await
            .unwrap();

        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            calls
                .iter()
                .any(|c| c == "replay:conv-approval:conv.v2.conv-x.changes.>"),
            "{calls:?}"
        );
    }

    /// A subscribe failure must release the claim: no `attached` publish, no
    /// conversation id returned, and the conversation never enters `served`.
    #[tokio::test]
    async fn a_subscribe_failure_releases_the_claim() {
        let broker = FakeBroker {
            subscribe_fails: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            ..Default::default()
        };
        let scratch = TestScratch::new("serve-subscribe-fail");
        let served_cwds = served();
        let conv = serve_conversation(
            &broker,
            NoopDeltaSink,
            "local",
            "instance-1",
            &served_cwds,
            config("conv-b", &scratch),
            decisions::Conversation::default(),
        )
        .await;

        assert!(conv.is_none());
        assert!(served_cwds.read().unwrap().is_empty());
        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls.iter().any(|c| c.starts_with("publish:")),
            "no attached publish on a failed subscribe: {calls:?}"
        );
    }

    /// The pure fold: a message and a later revision for the same id, in
    /// stream order, replayed to the tree's own last-write-wins state — no
    /// broker involved, a literal batch of frames proves it.
    #[test]
    fn fold_replay_applies_a_later_revision_over_its_message() {
        let seed_and_revise = vec![
            BrokerMessage {
                subject: "conv.v2.c1.changes.message".to_string(),
                payload: serde_json::json!({
                    "ts": "2026-07-26T00:00:00+00:00",
                    "id": "m1", "queryId": "q1", "turnId": "t1",
                    "role": "user", "content": [{ "type": "text", "text": "original" }],
                })
                .to_string()
                .into_bytes()
                .into(),
                reply: None,
            },
            BrokerMessage {
                subject: "conv.v2.c1.changes.revision".to_string(),
                payload: serde_json::json!({
                    "ts": "2026-07-26T00:00:01+00:00",
                    "messageId": "m1",
                    "content": [{ "type": "text", "text": "corrected" }],
                })
                .to_string()
                .into_bytes()
                .into(),
                reply: None,
            },
        ];

        let messages = fold_replay(&seed_and_revise);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "m1");
        assert_eq!(
            messages[0].content,
            vec![serde_json::json!({ "type": "text", "text": "corrected" })]
        );
    }

    #[test]
    fn fold_replay_skips_frames_that_do_not_parse_as_a_conv_change() {
        let unrelated = vec![BrokerMessage {
            subject: "conv.v2.c1.telemetry.turn.started".to_string(),
            payload: b"{}".to_vec().into(),
            reply: None,
        }];
        assert!(fold_replay(&unrelated).is_empty());
    }

    /// The refactor's own headline invariant, proven with a fake that can
    /// actually script the failure: a mid-replay read error must fail the
    /// adopt loudly, never read as the backlog simply ending.
    #[tokio::test]
    async fn a_mid_replay_read_failure_fails_the_adopt() {
        let broker = FakeBroker::default();
        let filter = "conv.v2.conv-y.changes.>".to_string();
        broker.replay_data.lock().unwrap().insert(
            filter,
            VecDeque::from([
                Ok(BrokerMessage {
                    subject: "conv.v2.conv-y.changes.message".to_string(),
                    payload: serde_json::json!({
                        "ts": "2026-07-26T00:00:00+00:00",
                        "id": "m1", "queryId": "q1", "turnId": "t1",
                        "role": "user", "content": [{ "type": "text", "text": "hi" }],
                    })
                    .to_string()
                    .into_bytes()
                    .into(),
                    reply: None,
                }),
                Err("connection reset mid-replay".to_string()),
            ]),
        );

        let result = replay_conversation(&broker, "conv-approval", "conv-y", &None).await;

        assert!(
            result.is_err(),
            "a mid-replay read failure must fail the adopt"
        );
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
