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
//! The process is one agent instance in a world (agent.md): `ready` on
//! boot, a `pulse` every PULSE_INTERVAL_S, on agent.v1 (unchanged by the
//! attachment migration — only Attachment moved off that tree). The world
//! is deployer-chosen (`BRIDGE_WORLD`, default `local`); the instance id is
//! generated per process, so a restart is a new instance in the same world.
//!
//! Attachment claims ride the CONVERSATION's own tree now
//! (conversation.md, Attachment; agent.md, Attachment): `attached`
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
mod credentials;
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
mod model;
mod mutate;
mod objects;
mod permissions;
mod pipe;
mod read;
mod readfile;
mod refs;
mod service;
mod skills;
mod slice;
mod stream;
#[cfg(test)]
mod testsupport;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use anyhow::Context;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;
use wire::now_iso;

use crate::anthropic::{DeltaSink, NatsDeltaSink};
use bridge::broker::{Broker, BrokerMessage, BrokerReplay, BrokerSubscription, NatsBroker};
use cwd::{ChdirError, ServedCwds, apply_chdir, resolve_cwd, validate_dir};

const PULSE_INTERVAL_S: i64 = 30;

/// The re-establishment backoff's ceiling, and the run length that counts
/// as having stayed up.
const MAX_BACKOFF_S: u64 = 30;

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
/// conversation.md: "the state of a message is its latest revision"
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
/// (conversation.md, Attachment): `attached`, `moved`, `detached`
/// carry the full `(world, instanceId)` pair, per agent.md's Attachment.
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
/// instance's `attached` superseding ours (agent.md, Attachment — "a
/// compliant instance watches the attachment leaf for every conversation it
/// serves"). On seeing one, stop serving — signal the servicer's own
/// `displaced` watch (never an `AbortHandle`: aborting the outer loop drops
/// the live query's cancel sender out from under it, and a spawned query
/// task the abort never reaches keeps running beside the new instance; the
/// servicer instead stops at the cancel checkpoint it already has, exactly
/// as a `cancel` request would) — release the conversation's `served` entry
/// (so a later `chdir` can't "succeed" against a claim we no longer hold,
/// and a re-adopt of this conversation doesn't collide with a stale one),
/// and publish `detached` — the observable act of standing down; the fold
/// already moved the claim, so this changes nothing but makes compliance
/// visible in the record.
///
/// Takes an already-live subscription rather than making its own: the watch
/// must be listening BEFORE our own `attached` is announced, or a
/// displacement landing in that window is never seen (the caller subscribes
/// first and hands the subscription in). `own_ts` is our own claim's
/// published ts: two instances racing to attach each see the OTHER's
/// `attached` and would both stand down, leaving the conversation unserved
/// — an incoming claim whose ts precedes ours is ignored rather than read as
/// a displacement, breaking the symmetry.
#[allow(clippy::too_many_arguments)]
async fn watch_attachment<B: Broker>(
    broker: B,
    mut sub: B::Subscription,
    served: ServedCwds,
    conv: String,
    world: String,
    instance: String,
    own_ts: String,
    displaced: watch::Sender<bool>,
) {
    let own_ts_ms = wire::parse_ts(&own_ts);
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
        let their_ts_ms = value
            .get("ts")
            .and_then(serde_json::Value::as_str)
            .and_then(wire::parse_ts);
        if let (Some(own), Some(theirs)) = (own_ts_ms, their_ts_ms)
            && theirs < own
        {
            // A concurrent race, not a real displacement: their claim is
            // OLDER than ours, so we consider ours the one that stands.
            continue;
        }
        eprintln!("bridge[{conv}]: displaced by {their_world:?}/{their_instance:?}; standing down");
        let _ = displaced.send(true);
        served.write().unwrap().remove(&conv);
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

/// What serving decided about the claim. The caller owns how each variant
/// surfaces — a stdout line for a stdio control line, a reply payload for a
/// NATS request — so this function never writes to stdout: stdout is the
/// stdio control protocol's reply channel, and a NATS caller sharing this
/// path must never see an unsolicited line land there.
enum ServeOutcome {
    /// Claimed, subscribed, spawned, `attached` published. Carries the
    /// conversation id and the servicer task's handle (a test awaits it
    /// before tearing down anything the task still holds).
    Attached(String, tokio::task::JoinHandle<()>),
    /// This instance already holds the conversation. The check-and-insert
    /// below is one lock acquisition with no `.await` inside it, so two
    /// callers — stdio and NATS alike — racing the same id cannot both
    /// claim.
    AlreadyAttached,
    /// The undertaking failed; the claim was released before returning so a
    /// retry is not locked out. Carries the detail for diagnostics — the
    /// machine-facing reason token stays the coarse `failed`.
    Failed(String),
}

/// The claim: check-and-insert in one lock acquisition — `served`'s
/// insert-if-absent IS the claim, not a side effect of a later step. Taking
/// it is what makes a second caller (a retry, the other transport) see
/// `already_attached` instead of starting a second undertaking for the same
/// conversation, so it is taken before anything slow and before any reply
/// goes out. Returns false when the id is already held here.
fn claim_conversation(
    served: &ServedCwds,
    conv: &str,
    cwd_cell: &Arc<RwLock<std::path::PathBuf>>,
) -> bool {
    let mut map = served.write().unwrap();
    if map.contains_key(conv) {
        return false;
    }
    map.insert(conv.to_string(), Arc::clone(cwd_cell));
    true
}

/// Serve a conversation: claim the id in `served`, subscribe (the fact
/// before the claim's announcement - a conversation that cannot hear
/// requests is not spawned in any meaningful sense, so the `attached`
/// publish waits for this fact), spawn the agent loop on the seeded tree,
/// and publish `attached` so observers see the conversation exist before
/// its first message. Shared by spawn (a fresh tree), adopt (a replayed
/// record), and by the future warden before a fourth caller copies the
/// wiring. The `service` request claims and serves in two steps instead
/// (`claim_conversation` then `serve_claimed`), because its reply must go
/// out between the two.
async fn serve_conversation<B: Broker, D: DeltaSink>(
    broker: &B,
    sink: D,
    world: &str,
    instance: &str,
    served: &ServedCwds,
    config: agent::AgentConfig,
    conversation: decisions::Conversation,
) -> ServeOutcome {
    if !claim_conversation(served, &config.conv.0, &config.cwd) {
        return ServeOutcome::AlreadyAttached;
    }
    serve_claimed(broker, sink, world, instance, served, config, conversation).await
}

/// The two subscriptions serving requires, both of which must be live
/// before the claim is announced: the conversation's own request tree, and
/// the attachment watch. Subscribing is instant and it is what makes the
/// conversation reachable, so it happens before a `service` reply goes out
/// — a request that arrives while the history is still loading queues
/// against a live subscription and gets an answer, rather than finding no
/// responder at all.
///
/// Watching for a displacement is a compliance requirement of serving
/// (agent.md, Attachment), not an optional extra: an instance that cannot
/// watch can never see itself superseded, so it must not claim in the first
/// place — same discipline as the requests subscribe beside it.
async fn subscribe_conversation<B: Broker>(
    broker: &B,
    conv: &wire::ConversationId,
) -> Result<(B::Subscription, B::Subscription), String> {
    let requests = agent::subscribe(broker, conv)
        .await
        .map_err(|e| format!("subscribe failed: {:#}", anyhow::Error::new(e)))?;
    let attachment_watch = broker
        .subscribe(format!("conv.v2.{}.attachment.>", conv.0))
        .await
        .map_err(|e| {
            format!(
                "attachment watch subscribe failed: {:#}",
                anyhow::Error::new(e)
            )
        })?;
    Ok((requests, attachment_watch))
}

/// Everything after the claim, for a caller that already holds it. Releases
/// the claim on any failure, so a retry is never locked out by an
/// undertaking that did not get off the ground.
async fn serve_claimed<B: Broker, D: DeltaSink>(
    broker: &B,
    sink: D,
    world: &str,
    instance: &str,
    served: &ServedCwds,
    config: agent::AgentConfig,
    conversation: decisions::Conversation,
) -> ServeOutcome {
    let conv = config.conv.0.clone();
    let (requests, attachment_watch) = match subscribe_conversation(broker, &config.conv).await {
        Ok(pair) => pair,
        Err(detail) => {
            eprintln!("bridge[{conv}]: {detail}");
            served.write().unwrap().remove(&conv);
            return ServeOutcome::Failed(detail);
        }
    };
    serve_subscribed(
        broker,
        sink,
        world,
        instance,
        served,
        config,
        conversation,
        requests,
        attachment_watch,
    )
    .await
}

/// Everything after the claim and the subscriptions, for a caller holding
/// both. This is where the loaded conversation finally matters: the agent
/// loop starts on it, and the `attached` announcing the claim carries the
/// `tip` read off it — which is why `attached` cannot be published before
/// the history is loaded, and why it is the signal that this conversation
/// is caught up and ready.
#[allow(clippy::too_many_arguments)]
async fn serve_subscribed<B: Broker, D: DeltaSink>(
    broker: &B,
    sink: D,
    world: &str,
    instance: &str,
    served: &ServedCwds,
    config: agent::AgentConfig,
    conversation: decisions::Conversation,
    requests: B::Subscription,
    attachment_watch: B::Subscription,
) -> ServeOutcome {
    let conv = config.conv.0.clone();
    // Read before the move: `config` is owned by the spawned task.
    let cwd_cell = Arc::clone(&config.cwd);
    // tip: where the conversation stands right now, so an observer other
    // than this servicer (towerd, a client, another agent) can learn it
    // without replaying the change stream first — the gap that made a
    // migrated-in conversation unaddressable except by its own servicer.
    // Read before the move: `conversation` is owned by the spawned task.
    let tip = conversation.tip().map(str::to_owned);
    let cwd = cwd_cell.read().unwrap().to_string_lossy().to_string();
    // The displacement signal: a plain flag the servicer loop races
    // alongside its requests and its live query's own cancel — never an
    // `AbortHandle` (watch_attachment's doc explains why).
    let (displaced_tx, displaced_rx) = watch::channel(false);
    let handle = tokio::spawn(agent::run(
        broker.clone(),
        sink,
        requests,
        config,
        conversation,
        displaced_rx,
    ));
    // The attachment is what makes the conversation exist for observers
    // before its first message. cwd is causal (an input to how the
    // conversation unfolds). Rides the conversation's own tree now
    // (conversation.md, Attachment), carrying the full identity pair.
    let own_ts = now_iso();
    let attached = serde_json::json!({
        "ts": own_ts,
        "instanceId": instance,
        "world": world,
        "tip": tip,
        "cwd": cwd,
        "intervalS": PULSE_INTERVAL_S,
    });
    publish_conv_attachment(broker, &conv, "attached", attached).await;
    // One instance per claim, watching its own conversation: a displacement
    // (another instance's `attached` superseding ours) is observed and
    // answered with `detached` (agent.md, Attachment).
    tokio::spawn(watch_attachment(
        broker.clone(),
        attachment_watch,
        Arc::clone(served),
        conv.clone(),
        world.to_string(),
        instance.to_string(),
        own_ts,
        displaced_tx,
    ));
    ServeOutcome::Attached(conv, handle)
}

/// The host's shared config and live cells. Every control line — from `-c` or
/// live stdin — reads through this, and so does the world's own request loop
/// (`serve_agent_requests`); the cells are what a `skills`, `system`, or
/// `context` line repoints without a restart. Generic over the two seams it
/// holds so a test drives the whole request path through the FakeBroker.
struct Host<B: Broker, D: DeltaSink> {
    broker: B,
    delta: D,
    world: String,
    instance: String,
    /// The `model` cell (model.rs), merged into by the `model` control line
    /// and read when a conversation is served. Nothing defaults it: until a
    /// line fills in at least a name and a maxTokens, this world cannot
    /// serve a conversation at all.
    model: Arc<RwLock<model::Settings>>,
    auth: anthropic::Auth,
    /// The shared, keepalive-configured HTTP client (anthropic.rs's
    /// `build_http_client`) every conversation's messages-API calls share.
    http: reqwest::Client,
    skills_root: Arc<RwLock<std::path::PathBuf>>,
    system: Arc<RwLock<Option<String>>>,
    context: Arc<RwLock<Option<String>>>,
    attach_bucket: String,
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
    /// The `credentials` and `tools` cells (credentials.rs), each replaced
    /// whole by its own control line. Held apart and resolved against each
    /// other only at the point of use, which is why the two lines can arrive
    /// in either order.
    credentials: Arc<RwLock<credentials::Credentials>>,
    tools: Arc<RwLock<credentials::ToolsConfig>>,
    /// The capture stream adopt and the `service` premise replay from
    /// (`BRIDGE_STREAM`), read once at boot — ambient env never reaches a
    /// call site.
    stream: String,
    /// The ephemeral capture the liveness seed replays world telemetry
    /// from (`BRIDGE_STREAM_EPHEMERAL`).
    stream_ephemeral: String,
    /// This world's own liveness map (service.rs), fed by the boot-time
    /// telemetry watch and consulted by the `service` premise.
    liveness: Arc<std::sync::Mutex<service::WorldLiveness>>,
}

impl<B: Broker, D: DeltaSink> Host<B, D> {
    /// Build the config for a new or adopted conversation from the live
    /// cells. `model_name` is the name a spawn or a service request named,
    /// if it named one; the rest of the configuration comes from the cell.
    /// Fails when the cell has no name and no maxTokens between them, which
    /// is the one place that is checked.
    fn config(
        &self,
        conv: &str,
        model_name: Option<&str>,
        cwd: Arc<RwLock<std::path::PathBuf>>,
    ) -> Result<agent::AgentConfig, String> {
        let model = self.model.read().unwrap().resolve(model_name)?;
        Ok(agent::AgentConfig {
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
            attach: self.attach.clone(),
            cwd,
            permissions: Arc::clone(&self.permissions),
            credentials: Arc::clone(&self.credentials),
            tools: Arc::clone(&self.tools),
        })
    }

    /// Carry out one control line, writing its single response to stdout.
    async fn handle(&self, value: serde_json::Value) {
        if let Some(spawn) = value.get("spawn") {
            let conv = uuid::Uuid::new_v4().to_string();
            let model_name = spawn.get("model").and_then(serde_json::Value::as_str);
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
            let config = match self.config(&conv, model_name, Arc::new(RwLock::new(cwd))) {
                Ok(config) => config,
                Err(e) => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("invalid model: {e}") })
                    );
                    return;
                }
            };
            match serve_conversation(
                &self.broker,
                self.delta.clone(),
                &self.world,
                &self.instance,
                &self.served,
                config,
                decisions::Conversation::default(),
            )
            .await
            {
                ServeOutcome::Attached(conv, _handle) => {
                    println!("{}", serde_json::json!({ "conversationId": conv }));
                }
                ServeOutcome::AlreadyAttached => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("already serving {conv}") })
                    );
                }
                ServeOutcome::Failed(detail) => {
                    println!("{}", serde_json::json!({ "error": detail }));
                }
            }
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
            let messages =
                match replay_conversation(&self.broker, &self.stream, &conv, &self.attach).await {
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
            let config = match self.config(&conv, None, Arc::new(RwLock::new(cwd))) {
                Ok(config) => config,
                Err(e) => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("invalid model: {e}") })
                    );
                    return;
                }
            };
            match serve_conversation(
                &self.broker,
                self.delta.clone(),
                &self.world,
                &self.instance,
                &self.served,
                config,
                decisions::Conversation::adopt(messages),
            )
            .await
            {
                ServeOutcome::Attached(conv, _handle) => {
                    println!(
                        "{}",
                        serde_json::json!({ "conversationId": conv, "adoptedMessages": adopted })
                    );
                }
                ServeOutcome::AlreadyAttached => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("already serving {conv}") })
                    );
                }
                ServeOutcome::Failed(detail) => {
                    println!("{}", serde_json::json!({ "error": detail }));
                }
            }
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
        } else if let Some(creds) = value.get("credentials") {
            // One cell, replaced whole, same discipline as `permissions`. An
            // unknown provider is rejected here: a typo that silently
            // configures nothing is the failure this validation exists for.
            // A binding naming a credential this line just removed is only a
            // warning, because the `tools` line may legitimately arrive
            // first.
            match credentials::parse_credentials(creds) {
                Ok(parsed) => {
                    *self.credentials.write().unwrap() = parsed;
                    let warnings = credentials::warnings(
                        &self.credentials.read().unwrap(),
                        &self.tools.read().unwrap(),
                    );
                    for warning in &warnings {
                        eprintln!("bridge: credentials warning: {warning}");
                    }
                    eprintln!(
                        "bridge: credentials set ({} configured)",
                        self.credentials.read().unwrap().0.len()
                    );
                    println!(
                        "{}",
                        serde_json::json!({ "credentials": "ok", "warnings": warnings })
                    );
                }
                Err(e) => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("invalid credentials: {e}") })
                    );
                }
            }
        } else if let Some(groups) = value.get("tools") {
            // The other half, and the same shape: one cell replaced whole,
            // an unknown group rejected, an unknown credential name warned
            // about and the group left inactive.
            match credentials::parse_tools(groups) {
                Ok(parsed) => {
                    *self.tools.write().unwrap() = parsed;
                    let warnings = credentials::warnings(
                        &self.credentials.read().unwrap(),
                        &self.tools.read().unwrap(),
                    );
                    for warning in &warnings {
                        eprintln!("bridge: tools warning: {warning}");
                    }
                    eprintln!("bridge: tool groups set");
                    println!(
                        "{}",
                        serde_json::json!({ "tools": "ok", "warnings": warnings })
                    );
                }
                Err(e) => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("invalid tools: {e}") })
                    );
                }
            }
        } else if let Some(model) = value.get("model") {
            // One cell, MERGED rather than replaced: the line updates the
            // fields it names and leaves the rest alone, and null clears an
            // optional one. So the line is validated on the values it
            // carries, and whether the cell is complete is asked when a
            // conversation is served. New spawns take it; a conversation
            // already running keeps what it was served with.
            let merged = self.model.read().unwrap().merged(model);
            match merged {
                Ok(settings) => {
                    *self.model.write().unwrap() = settings;
                    let echo = self.model.read().unwrap().to_json();
                    eprintln!("bridge: model set ({echo})");
                    println!("{}", serde_json::json!({ "model": echo }));
                }
                Err(e) => {
                    println!(
                        "{}",
                        serde_json::json!({ "error": format!("invalid model: {e}") })
                    );
                }
            }
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
            // Move one conversation's cwd (conversation.md's `chdir` request).
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
                    // (agent.md, Attachment: that is now the violation
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
            // (conversation.md: revision) — a trim, a resize, or a bug fix
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
            let credentials = credentials::settings(
                &self.credentials.read().unwrap(),
                &self.tools.read().unwrap(),
            );
            let warnings = credentials::warnings(
                &self.credentials.read().unwrap(),
                &self.tools.read().unwrap(),
            );
            println!(
                "{}",
                serde_json::json!({
                    "warnings": warnings,
                    "settings": {
                        "credentials": credentials["credentials"],
                        "tools": credentials["tools"],
                        "world": self.world,
                        "instance": self.instance,
                        "cwd": self.default_cwd.read().unwrap().to_string_lossy(),
                        "model": self.model.read().unwrap().to_json(),
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

/// Fold one world-telemetry frame into the liveness map, observed `at` —
/// receipt time for the live feed, a ts-derived instant for a seeded frame.
fn fold_world_telemetry(
    subject: &str,
    payload: &[u8],
    at: std::time::Instant,
    liveness: &std::sync::Mutex<service::WorldLiveness>,
) {
    let Some(leaf) = subject.rsplit('.').next() else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return;
    };
    let Some(instance) = value.get("instanceId").and_then(serde_json::Value::as_str) else {
        return;
    };
    let interval = value.get("intervalS").and_then(serde_json::Value::as_i64);
    let mut map = liveness.lock().unwrap();
    match leaf {
        // A pulse's `intervalS` is required and bounded; the fold drops the
        // event whole when it is missing or out of range, because an
        // invalid heartbeat is not a heartbeat and proves nothing.
        "pulse" => map.on_pulse(instance, interval, at),
        "ready" => map.on_ready(instance, at),
        // Old-tree attachment telemetry proves the publisher's presence
        // exactly as a pulse does (towerd's fold counts it the same way);
        // `attached` may also carry the cadence, and a bad one invalidates
        // that event just as it does a pulse.
        "attached" => map.on_attached(instance, interval, at),
        "detached" => map.on_ready(instance, at),
        _ => {}
    }
}

/// Seed the liveness map from the ephemeral capture: the last
/// `MAX_SILENCE_S` of this world's telemetry, which is exactly sufficient —
/// no honoured threshold exceeds it, so an older frame cannot change any
/// verdict. Built, not guessed: after a seed, never-heard genuinely means
/// silent past every honoured threshold. A replayed frame's observation
/// instant derives from its own `ts` (sender wall clock — bounded harm
/// inside this window, and the fold never regresses a fresher live entry).
async fn seed_world_liveness<B: Broker>(
    broker: &B,
    stream: &str,
    world: &str,
    liveness: &std::sync::Mutex<service::WorldLiveness>,
) -> anyhow::Result<()> {
    let window = std::time::Duration::from_secs(service::MAX_SILENCE_S);
    let start = std::time::SystemTime::now() - window;
    let mut replay = broker
        .replay_since(
            stream.to_string(),
            format!("agent.v1.{world}.telemetry.>"),
            start,
        )
        .await
        .context("liveness seed needs the telemetry capture")?;
    while let Some(frame) = replay.next().await {
        let frame = frame.context("liveness seed read failed")?;
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&frame.payload) else {
            continue;
        };
        let Some(ts_ms) = value
            .get("ts")
            .and_then(serde_json::Value::as_str)
            .and_then(wire::parse_ts)
        else {
            continue;
        };
        let now_wall_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let age = std::time::Duration::from_millis((now_wall_ms - ts_ms).max(0) as u64);
        if age > window {
            continue;
        }
        // checked_sub: Instant is monotonic-since-boot on Linux/macOS, so
        // on a host younger than the frame's age the subtraction would
        // panic — and a frame older than uptime predates every process on
        // this machine, so it can't change a verdict; skip it.
        let Some(at) = std::time::Instant::now().checked_sub(age) else {
            continue;
        };
        fold_world_telemetry(&frame.subject, &frame.payload, at, liveness);
    }
    Ok(())
}

/// Fold every telemetry frame already queued on the subscription, without
/// awaiting — called before each request is handled, so sustained request
/// traffic can never starve the map while the biased select keeps the
/// requests arm continuously ready. Returns true when the subscription has
/// ended (the caller re-establishes after answering).
fn drain_ready_telemetry<S: bridge::broker::BrokerSubscription>(
    sub: &mut S,
    liveness: &std::sync::Mutex<service::WorldLiveness>,
) -> bool {
    use futures::FutureExt;
    loop {
        match sub.next().now_or_never() {
            None => return false,
            Some(None) => return true,
            Some(Some(msg)) => fold_world_telemetry(
                &msg.subject,
                &msg.payload,
                std::time::Instant::now(),
                liveness,
            ),
        }
    }
}

/// The world's `service` request (agent.md: Requests, "The premise for
/// `service`"). The premise is read off the conversation's own attachment
/// record (the capture replayed and folded) plus this world's liveness map,
/// then dispatched on the four cases exactly. The reply confirms the
/// premise, never the outcome: acceptance means the servicing was
/// undertaken — the outcome is the `attached` on the conversation's tree.
/// So the answer is settled here, and the loading it authorises is handed
/// off rather than waited on.
async fn handle_service<B: Broker, D: DeltaSink>(
    host: &Arc<Host<B, D>>,
    conv: String,
    cwd: Option<String>,
    model: Option<String>,
) -> Vec<u8> {
    let mut replay = match host
        .broker
        .replay(host.stream.clone(), format!("conv.v2.{conv}.attachment.>"))
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let detail = format!("attachment replay failed: {:#}", anyhow::Error::new(e));
            eprintln!("bridge: service {conv}: {detail}");
            return wire::encode_rejected_detailed("failed", &detail);
        }
    };
    let mut events = Vec::new();
    loop {
        match replay.next().await {
            None => break,
            Some(Err(e)) => {
                let detail = format!("attachment replay failed: {:#}", anyhow::Error::new(e));
                eprintln!("bridge: service {conv}: {detail}");
                return wire::encode_rejected_detailed("failed", &detail);
            }
            Some(Ok(msg)) => {
                if let Some(wire::WireEvent::Conv(event)) =
                    wire::parse_wire(&msg.subject, &msg.payload)
                    && let wire::EventKind::Attachment(a) = event.kind
                {
                    events.push(a);
                }
            }
        }
    }
    let standing = service::fold_attachment(&events);
    let premise = {
        let liveness = host.liveness.lock().unwrap();
        service::service_premise(
            standing.as_ref(),
            &host.world,
            &host.instance,
            &liveness,
            std::time::Instant::now(),
        )
    };
    eprintln!("bridge: service {conv}: premise {premise:?}");
    if premise == service::ServicePremise::AlreadyAttached {
        return wire::encode_rejected("already_attached");
    }
    // Environment: absence delegates to the world's own defaults, presence
    // binds — a named value the world cannot establish rejects the request,
    // never a silent fallback.
    let default_cwd = host.default_cwd.read().unwrap().clone();
    let resolved_cwd = match resolve_cwd(cwd.as_deref(), &default_cwd) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("bridge: service {conv}: invalid cwd: {e}");
            return wire::encode_rejected_detailed("invalid_cwd", &e);
        }
    };
    // A request that names a model supplies the name; the cell supplies the
    // rest — same rule as a stdio spawn. A cell with no name and no
    // maxTokens between them cannot serve anything, and this is where that
    // is refused: name and maxTokens are both required, so the cell is only
    // ever unset or whole, and refusing here leaves no unconfigured path
    // behind it.
    let config = match host.config(&conv, model.as_deref(), Arc::new(RwLock::new(resolved_cwd))) {
        Ok(config) => config,
        Err(e) => {
            eprintln!("bridge: service {conv}: no model: {e}");
            return wire::encode_rejected_detailed("no_model", &e);
        }
    };
    // The claim goes before the reply, never on the handed-off work: it is
    // what a retry from a sender that gave up waiting collides with, and a
    // claim taken only once the replay started would let that retry begin a
    // second replay of the same conversation.
    if !claim_conversation(&host.served, &conv, &config.cwd) {
        return wire::encode_rejected("already_attached");
    }
    // Subscribing is instant, and it is what makes the conversation
    // reachable — so it belongs on this side of the reply too. A say that
    // arrives while the history is still loading meets a live subscription
    // and is answered on its own merits, rather than finding no responder
    // at all.
    let (requests, attachment_watch) =
        match subscribe_conversation(&host.broker, &config.conv).await {
            Ok(pair) => pair,
            Err(detail) => {
                eprintln!("bridge: service {conv}: {detail}");
                host.served.write().unwrap().remove(&conv);
                return wire::encode_rejected_detailed("failed", &detail);
            }
        };
    // Accepting and loading are separate concerns: the reply confirms the
    // premise, so nothing about it waits on a replay. Handing the loading
    // off frees the request loop for the next request immediately, and
    // conversations are independent — one conversation's history must never
    // hold up a request about another. How that handed-off loading is
    // scheduled (concurrently, or serialised against broker and disk
    // contention) is a separate question, deliberately not settled here.
    let host = Arc::clone(host);
    tokio::spawn(async move {
        // No standing attachment and no history: spawn fresh. History:
        // adopt. One replay answers both — an empty backlog is the fresh
        // case.
        let messages =
            match replay_conversation(&host.broker, &host.stream, &conv, &host.attach).await {
                Ok(m) => m,
                Err(e) => {
                    // The reply is long gone, so the failure shows where
                    // every other outcome shows: on the record, as the
                    // `attached` that never arrives. Release the claim so a
                    // later request can try again.
                    host.served.write().unwrap().remove(&conv);
                    eprintln!("bridge: service {conv}: history replay failed: {e:#}");
                    return;
                }
            };
        let conversation = if messages.is_empty() {
            decisions::Conversation::default()
        } else {
            decisions::Conversation::adopt(messages)
        };
        if let ServeOutcome::Failed(detail) = serve_subscribed(
            &host.broker,
            host.delta.clone(),
            &host.world,
            &host.instance,
            &host.served,
            config,
            conversation,
            requests,
            attachment_watch,
        )
        .await
        {
            eprintln!("bridge: service {conv}: {detail}");
        }
    });
    wire::encode_accepted(None)
}

/// Serve `agent.v1.{world}.requests.>` for this instance's life — the
/// world-level counterpart of the per-conversation `.requests.>` loop. One
/// queue group per world, so exactly one instance answers; plain NATS,
/// never JetStream — a `.requests` subject is never stream-captured
/// (nats.md, Storage). Every request owes a reply: `service` is
/// dispatched on its premise, a recognised-but-malformed body is `invalid`,
/// and any other leaf is honest `unsupported` — compliance is answering,
/// not implementing.
async fn serve_agent_requests<B: Broker, D: DeltaSink>(host: Arc<Host<B, D>>) {
    let mut delay = 1u64;
    loop {
        match serve_agent_requests_once(&host).await {
            // Establishing is the attempt; staying up is the evidence. A
            // feed that dies the moment it is made would otherwise reset
            // the backoff every time and re-seed a MAX_SILENCE_S window
            // once a second, forever. The run is measured from when
            // serving actually began, so a slow establish never passes for
            // a healthy run.
            Some(serving_since) => {
                if serving_since.elapsed() >= std::time::Duration::from_secs(MAX_BACKOFF_S) {
                    delay = 1;
                }
                eprintln!("bridge: agent request serving interrupted; re-establishing in {delay}s");
            }
            None => {
                eprintln!("bridge: agent request serving not established; retrying in {delay}s")
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        delay = (delay * 2).min(MAX_BACKOFF_S);
    }
}

/// One establishment of the world's request serving: telemetry watch, seed,
/// requests queue group, then one merged loop over both. All three stand or
/// fall together — any of them failing or ending returns for the caller to
/// re-establish, so a dead telemetry feed or an unseedable map never leaves
/// a surviving request loop answering off weak verdicts. Returns when
/// serving actually began, or `None` if it never did — the caller measures
/// the run from that instant, so establishing costs are never counted as
/// time spent serving.
async fn serve_agent_requests_once<B: Broker, D: DeltaSink>(
    host: &Arc<Host<B, D>>,
) -> Option<std::time::Instant> {
    // The liveness watch first, and fatally: the premise's alive-vs-
    // stranded read is only honest off a live map, so an instance that
    // cannot watch its world-mates must not answer requests at all.
    let telemetry_subject = format!("agent.v1.{}.telemetry.>", host.world);
    let mut telemetry = match host.broker.subscribe(telemetry_subject.clone()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "bridge: world telemetry subscribe failed ({telemetry_subject}): {:#} — not serving agent requests",
                anyhow::Error::new(e)
            );
            return None;
        }
    };
    // Subscribe first, then seed — no pulse lands in the gap between the
    // two reads. A seed failure is a broken deployment (the capture is
    // load-bearing for adopt and the premise read alike), not a mode to
    // serve through: same rule as the telemetry watch, refuse and let the
    // caller re-establish.
    *host.liveness.lock().unwrap() = service::WorldLiveness::new();
    if let Err(e) = seed_world_liveness(
        &host.broker,
        &host.stream_ephemeral,
        &host.world,
        &host.liveness,
    )
    .await
    {
        eprintln!("bridge: liveness seed failed — not serving agent requests: {e:#}");
        return None;
    }

    // Warm, and only now joining: an instance does not offer to serve until
    // its own fold can answer the premise (agent.md, "The premise for
    // `service`"). A sender arriving before this point meets no queue-group
    // member at all and gets NATS's own no-responder — honestly "not
    // available yet", which it retries — rather than a wrong verdict read
    // off a fold that has measured nothing.
    let subject = format!("agent.v1.{}.requests.>", host.world);
    let mut requests = match host
        .broker
        .queue_subscribe(subject.clone(), "servicers".to_string())
        .await
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "bridge: agent requests subscribe failed ({subject}): {:#}",
                anyhow::Error::new(e)
            );
            return None;
        }
    };
    // Serving starts here, so this is where the run's clock starts: the
    // subscribe and seed above are the cost of establishing, and counting
    // them would let a slow seed followed by an instantly dead feed read as
    // a healthy run.
    let serving_since = std::time::Instant::now();
    let prefix = format!("agent.v1.{}.requests.", host.world);
    eprintln!("bridge: serving {subject}");
    loop {
        tokio::select! {
            // Biased: drain pending requests before reading the telemetry
            // arm, so a scripted/finite telemetry source ending never races
            // ahead of requests already delivered. In production telemetry
            // frames queue in the subscription and fold between requests;
            // verdicts are read at handle time.
            biased;
            req = requests.next() => match req {
                None => {
                    eprintln!("bridge: agent requests subscription ended");
                    return Some(serving_since);
                }
                Some(msg) => {
                    // Fold whatever telemetry is already queued before
                    // judging any premise: verdicts are read at handle
                    // time, and the biased select alone would only poll
                    // the telemetry arm when requests go quiet.
                    let telemetry_ended = drain_ready_telemetry(&mut telemetry, &host.liveness);
                    let Some(reply_to) = msg.reply.clone() else {
                        if telemetry_ended {
                            eprintln!("bridge: world telemetry subscription ended");
                            return Some(serving_since);
                        }
                        continue;
                    };
                    let leaf = msg.subject.strip_prefix(prefix.as_str()).unwrap_or("");
                    eprintln!(
                        "{} bridge: ← agent request {leaf} ({} B)",
                        now_iso(),
                        msg.payload.len()
                    );
                    let response = match wire::parse_agent_request(leaf, &msg.payload) {
                        wire::AgentRequest::Service {
                            conversation_id,
                            cwd,
                            model,
                        } => handle_service(host, conversation_id.0, cwd, model).await,
                        wire::AgentRequest::Invalid { leaf } => {
                            eprintln!("bridge: invalid agent request {leaf}");
                            wire::encode_rejected("invalid")
                        }
                        wire::AgentRequest::Other { leaf } => {
                            eprintln!("bridge: unsupported agent request {leaf}");
                            wire::encode_rejected("unsupported")
                        }
                    };
                    if let Err(e) = host.broker.publish(reply_to, response).await {
                        eprintln!(
                            "bridge: agent request reply publish failed: {:#}",
                            anyhow::Error::new(e)
                        );
                    }
                    // A dead feed returns NOW, after the request in hand,
                    // never deferred to the telemetry arm — under gapless
                    // request traffic that arm is never polled, and the
                    // frozen map would age every live holder into a
                    // takeover. A request already delivered on the dropped
                    // loop is the sender's retry, not our debt.
                    if telemetry_ended {
                        eprintln!("bridge: world telemetry subscription ended");
                        return Some(serving_since);
                    }
                }
            },
            tele = telemetry.next() => match tele {
                None => {
                    eprintln!("bridge: world telemetry subscription ended");
                    return Some(serving_since);
                }
                Some(msg) => fold_world_telemetry(
                    &msg.subject,
                    &msg.payload,
                    std::time::Instant::now(),
                    &host.liveness,
                ),
            },
        }
    }
}

/// Parse one control line and hand it to the host. Shared by the -c batch and
/// the live stdin loop, so both surfaces answer identically.
async fn handle_line<B: Broker, D: DeltaSink>(host: &Host<B, D>, line: &str) {
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
    // grammar, two delivery points — the -c batch, then live stdin — plus
    // the world's own NATS request loop.
    let stream = std::env::var("BRIDGE_STREAM").unwrap_or_else(|_| "conv-approval".into());
    let stream_ephemeral =
        std::env::var("BRIDGE_STREAM_EPHEMERAL").unwrap_or_else(|_| "conv-ephemeral".into());
    let liveness = Arc::new(std::sync::Mutex::new(service::WorldLiveness::new()));
    let host = Arc::new(Host {
        broker,
        delta,
        world,
        instance,
        // Nothing defaults the model: until a `model` line names at least a
        // name and a maxTokens, this instance refuses to serve anything.
        model: Arc::new(RwLock::new(model::Settings::default())),
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
        permissions: Arc::new(RwLock::new(permissions::PermissionSet::strict_default())),
        // No defaults and no environment variables: until a `credentials`
        // and a `tools` line arrive, nothing is configured, every group is
        // inactive, and Exec's environment is untouched.
        credentials: Arc::new(RwLock::new(credentials::Credentials::default())),
        tools: Arc::new(RwLock::new(credentials::ToolsConfig::default())),
        stream,
        stream_ephemeral,
        liveness,
    });

    // The world's own requests (agent.md): queue group per world, so
    // exactly one instance answers even with several sharing it. Plain
    // NATS, never JetStream-captured (nats.md, Storage). The loop makes
    // the world-mate liveness feed before it answers anything, and refuses
    // to serve if that feed cannot be made.
    tokio::spawn(serve_agent_requests(Arc::clone(&host)));

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
    eprintln!("bridge: tools: {}", tool_names.join(", "));
    eprintln!(
        "bridge: ready (model {}); spawn with {{\"spawn\":{{}}}} (optionally {{\"cwd\":\"...\"}})",
        host.model.read().unwrap().to_json()
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
        ServeOutcome, ServedCwds, decisions, expand_tilde, fold_replay, replay_conversation,
        serve_conversation,
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
        let ServeOutcome::Attached(_conv, handle) = served_conv else {
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

    /// A displacement landing between our `attached` publish and the
    /// watcher's subscribe is never seen: the watch must be live before the
    /// claim is announced, or the window is a silent double-serve.
    #[tokio::test]
    async fn attachment_watch_subscribes_before_attached_is_published() {
        let broker = FakeBroker::default();
        let scratch = TestScratch::new("watch-ordering");
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
        let ServeOutcome::Attached(_conv, handle) = served_conv else {
            panic!("expected a served conversation");
        };

        // The watcher runs as its own task; give its subscribe time to land
        // before reading the order.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let calls = loop {
            let calls = broker.calls.lock().unwrap().clone();
            if calls
                .iter()
                .any(|c| c == "subscribe:conv.v2.conv-a.attachment.>")
            {
                break calls;
            }
            if std::time::Instant::now() > deadline {
                panic!("attachment watch never subscribed: {calls:?}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        };
        let watch_at = calls
            .iter()
            .position(|c| c == "subscribe:conv.v2.conv-a.attachment.>")
            .unwrap();
        let attached_at = calls
            .iter()
            .position(|c| c == "publish:conv.v2.conv-a.attachment.attached")
            .unwrap();
        assert!(
            watch_at < attached_at,
            "watch must be live before the claim is announced: {calls:?}"
        );
        handle.await.unwrap();
    }

    /// Two instances racing to attach each see the OTHER's `attached` over
    /// the watch — read naively, both would stand down and the
    /// conversation would go unserved. An incoming claim whose ts precedes
    /// our own must never be treated as a displacement.
    #[tokio::test]
    async fn an_older_concurrent_attached_is_not_a_displacement() {
        let broker = FakeBroker::default();
        broker.subscribe_data.lock().unwrap().insert(
            "conv.v2.conv-a.attachment.>".to_string(),
            VecDeque::from([BrokerMessage {
                subject: "conv.v2.conv-a.attachment.attached".to_string(),
                payload: serde_json::json!({
                    "ts": "1970-01-01T00:00:01+00:00",
                    "instanceId": "inst-other",
                    "world": "vm",
                    "cwd": "~/repos/tower",
                })
                .to_string()
                .into_bytes()
                .into(),
                reply: None,
            }]),
        );
        let scratch = TestScratch::new("concurrent-race");
        let served_cwds = served();
        let served_conv = serve_conversation(
            &broker,
            NoopDeltaSink,
            "local",
            "instance-1",
            &served_cwds,
            config("conv-a", &scratch),
            decisions::Conversation::default(),
        )
        .await;
        let ServeOutcome::Attached(_conv, handle) = served_conv else {
            panic!("expected a served conversation");
        };
        handle.await.unwrap();

        // The watcher drains the queued message off the fake subscription
        // synchronously; give its task a moment to run before asserting
        // silence.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls
                .iter()
                .any(|c| c == "publish:conv.v2.conv-a.attachment.detached"),
            "an older concurrent claim must never read as a displacement: {calls:?}"
        );
        assert!(
            served_cwds.read().unwrap().contains_key("conv-a"),
            "the claim must still be held"
        );
    }

    /// Standing down on displacement is more than aborting the servicer:
    /// the conversation must leave `served`, or a later chdir "succeeds"
    /// against a claim we no longer hold and a re-adopt collides with the
    /// stale entry.
    #[tokio::test]
    async fn displacement_releases_the_served_entry() {
        let broker = FakeBroker::default();
        broker.subscribe_data.lock().unwrap().insert(
            "conv.v2.conv-a.attachment.>".to_string(),
            VecDeque::from([BrokerMessage {
                subject: "conv.v2.conv-a.attachment.attached".to_string(),
                payload: serde_json::json!({
                    // Deliberately far in the future: must read as a real
                    // displacement regardless of when this test runs, never
                    // ignored as an older concurrent-race claim (issue 4's
                    // ts-precedence guard).
                    "ts": "2099-01-01T00:00:00+10:00",
                    "instanceId": "inst-other",
                    "world": "vm",
                    "cwd": "~/repos/tower",
                })
                .to_string()
                .into_bytes()
                .into(),
                reply: None,
            }]),
        );
        let scratch = TestScratch::new("displacement-served");
        let served_cwds = served();
        let served_conv = serve_conversation(
            &broker,
            NoopDeltaSink,
            "local",
            "instance-1",
            &served_cwds,
            config("conv-a", &scratch),
            decisions::Conversation::default(),
        )
        .await;
        let ServeOutcome::Attached(_conv, handle) = served_conv else {
            panic!("expected a served conversation");
        };

        // Standing down is observable as the detached publish; wait for it.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let calls = broker.calls.lock().unwrap().clone();
            if calls
                .iter()
                .any(|c| c == "publish:conv.v2.conv-a.attachment.detached")
            {
                break;
            }
            if std::time::Instant::now() > deadline {
                panic!("displaced instance never stood down: {calls:?}");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            served_cwds.read().unwrap().is_empty(),
            "a displaced conversation must leave `served`"
        );
        // The servicer was aborted by the watcher; either outcome ends it.
        let _ = handle.await;
    }

    /// Watching the attachment leaf is a compliance requirement of serving
    /// (agent.md, Attachment): if the watch can't be established, the
    /// claim must be released — same discipline as a `requests` subscribe
    /// failure — not served unwatched, where a displacement is never seen.
    #[tokio::test]
    async fn an_attachment_watch_subscribe_failure_releases_the_claim() {
        let broker = FakeBroker::default();
        broker
            .subscribe_fail_subjects
            .lock()
            .unwrap()
            .insert("conv.v2.conv-b.attachment.>".to_string());
        let scratch = TestScratch::new("watch-subscribe-fail");
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

        assert!(
            matches!(conv, ServeOutcome::Failed(_)),
            "an unwatchable conversation must not be served"
        );
        assert!(served_cwds.read().unwrap().is_empty());
        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls
                .iter()
                .any(|c| c == "publish:conv.v2.conv-b.attachment.attached"),
            "no attached publish when the watch cannot be established: {calls:?}"
        );
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

        assert!(matches!(conv, ServeOutcome::Failed(_)));
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

    // --- the world's `service` request (agent.md, "The premise for
    // `service`") — every premise arm, plus reply shape and environment
    // strictness, scripted through the FakeBroker. ---

    use crate::testsupport::host;

    fn attached_frame(conv: &str, instance: &str, world: &str) -> BrokerMessage {
        BrokerMessage {
            subject: format!("conv.v2.{conv}.attachment.attached"),
            payload: serde_json::json!({
                "ts": "2026-07-07T21:00:00+10:00",
                "instanceId": instance,
                "world": world,
                "cwd": "/tmp",
            })
            .to_string()
            .into_bytes()
            .into(),
            reply: None,
        }
    }

    fn seed_attachment(broker: &FakeBroker, conv: &str, frames: Vec<BrokerMessage>) {
        broker.replay_data.lock().unwrap().insert(
            format!("conv.v2.{conv}.attachment.>"),
            frames.into_iter().map(Ok).collect(),
        );
    }

    fn seed_changes(broker: &FakeBroker, conv: &str, frames: Vec<BrokerMessage>) {
        broker.replay_data.lock().unwrap().insert(
            format!("conv.v2.{conv}.changes.>"),
            frames.into_iter().map(Ok).collect(),
        );
    }

    fn reply_json(reply: &[u8]) -> serde_json::Value {
        serde_json::from_slice(reply).expect("reply is one json value")
    }

    /// The reply lands before the loading it authorises, so a test that
    /// wants the outcome waits for the outcome. Polls rather than sleeps a
    /// fixed span: it returns the moment the call shows up, and only fails
    /// after long enough that a real hang is the only explanation.
    async fn await_call(broker: &FakeBroker, want: &str) {
        for _ in 0..1_000 {
            if broker.calls.lock().unwrap().iter().any(|c| c == want) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        panic!(
            "{want} never happened; calls: {:?}",
            broker.calls.lock().unwrap()
        );
    }

    /// Fresh spawn: no standing attachment, no history — accepted, and the
    /// claim is announced on the conversation's own attachment leaf.
    #[tokio::test]
    async fn service_of_an_unknown_conversation_spawns_fresh_and_accepts() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-f", vec![]);
        seed_changes(&broker, "conv-f", vec![]);
        let scratch = TestScratch::new("service-fresh");
        let host = host(&scratch, broker.clone());

        let reply = super::handle_service(&host, "conv-f".into(), None, None).await;

        assert_eq!(reply_json(&reply), serde_json::json!({ "accepted": true }));
        await_call(&broker, "publish:conv.v2.conv-f.attachment.attached").await;
    }

    /// Adopt: no standing attachment but a committed record — accepted, the
    /// record replayed into the served tree.
    #[tokio::test]
    async fn service_of_a_conversation_with_history_adopts_and_accepts() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-h", vec![]);
        seed_changes(
            &broker,
            "conv-h",
            vec![BrokerMessage {
                subject: "conv.v2.conv-h.changes.message".to_string(),
                payload: serde_json::json!({
                    "ts": "2026-07-26T00:00:00+00:00",
                    "id": "m1", "queryId": "q1", "turnId": "t1",
                    "role": "user", "content": [{ "type": "text", "text": "hi" }],
                })
                .to_string()
                .into_bytes()
                .into(),
                reply: None,
            }],
        );
        let scratch = TestScratch::new("service-adopt");
        let host = host(&scratch, broker.clone());

        let reply = super::handle_service(&host, "conv-h".into(), None, None).await;

        assert_eq!(reply_json(&reply), serde_json::json!({ "accepted": true }));
        // The adopted tip rides the attached claim — the observable proof
        // the record was replayed, not spawned over.
        await_call(&broker, "publish:conv.v2.conv-h.attachment.attached").await;
        let published = broker.published.lock().unwrap().clone();
        let attached = published
            .iter()
            .find(|(s, _)| s == "conv.v2.conv-h.attachment.attached")
            .expect("attached published");
        let payload: serde_json::Value = serde_json::from_slice(&attached.1).unwrap();
        assert_eq!(payload["tip"], "m1");
    }

    /// Standing attachment in this world, holder alive: rejected
    /// `already_attached` — the goal already holds, and a retried request
    /// never causes a takeover.
    #[tokio::test]
    async fn service_is_rejected_already_attached_while_the_holder_lives_here() {
        let broker = FakeBroker::default();
        seed_attachment(
            &broker,
            "conv-a",
            vec![attached_frame("conv-a", "inst-mate", "mac")],
        );
        let scratch = TestScratch::new("service-already");
        let host = host(&scratch, broker.clone());
        host.liveness
            .lock()
            .unwrap()
            .on_pulse("inst-mate", Some(30), std::time::Instant::now());

        let reply = super::handle_service(&host, "conv-a".into(), None, None).await;

        assert_eq!(
            reply_json(&reply),
            serde_json::json!({ "rejected": true, "reason": "already_attached" })
        );
        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls
                .iter()
                .any(|c| c == "publish:conv.v2.conv-a.attachment.attached"),
            "a redundant request must never cause a takeover: {calls:?}"
        );
    }

    /// Standing attachment in this world, holder stranded (silent past its
    /// threshold — here never heard from at all): accepted, taken over. A
    /// dead holder never blocks pickup.
    #[tokio::test]
    async fn service_takes_over_from_a_stranded_holder_in_this_world() {
        let broker = FakeBroker::default();
        seed_attachment(
            &broker,
            "conv-s",
            vec![attached_frame("conv-s", "inst-dead", "mac")],
        );
        seed_changes(&broker, "conv-s", vec![]);
        let scratch = TestScratch::new("service-stranded");
        let host = host(&scratch, broker.clone());

        let reply = super::handle_service(&host, "conv-s".into(), None, None).await;

        assert_eq!(reply_json(&reply), serde_json::json!({ "accepted": true }));
        await_call(&broker, "publish:conv.v2.conv-s.attachment.attached").await;
    }

    /// Standing attachment in another world: accepted and taken over even
    /// with the incumbent demonstrably alive — asking a different world to
    /// serve IS migration.
    #[tokio::test]
    async fn service_takes_over_cross_world_regardless_of_the_incumbents_liveness() {
        let broker = FakeBroker::default();
        seed_attachment(
            &broker,
            "conv-x",
            vec![attached_frame("conv-x", "inst-far", "pc")],
        );
        seed_changes(&broker, "conv-x", vec![]);
        let scratch = TestScratch::new("service-crossworld");
        let host = host(&scratch, broker.clone());
        host.liveness
            .lock()
            .unwrap()
            .on_pulse("inst-far", Some(30), std::time::Instant::now());

        let reply = super::handle_service(&host, "conv-x".into(), None, None).await;

        assert_eq!(reply_json(&reply), serde_json::json!({ "accepted": true }));
    }

    /// A named environment value the world cannot establish rejects the
    /// request — presence binds, never a silent fallback.
    #[tokio::test]
    async fn service_with_an_unestablishable_cwd_is_rejected_invalid_cwd() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-c", vec![]);
        let scratch = TestScratch::new("service-invalid-cwd");
        let host = host(&scratch, broker.clone());

        let reply = super::handle_service(
            &host,
            "conv-c".into(),
            Some("/definitely/not/a/real/dir".into()),
            None,
        )
        .await;

        let value = reply_json(&reply);
        assert_eq!(value["rejected"], true);
        assert_eq!(value["reason"], "invalid_cwd");
        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls.iter().any(|c| c.starts_with("publish:")),
            "nothing undertaken on a rejected environment: {calls:?}"
        );
    }

    /// Nothing defaults the model, so a world whose cell was never filled in
    /// refuses to serve rather than spawning something it cannot run a turn
    /// for. Name and maxTokens are both required, so the cell is only ever
    /// unset or whole, and refusing here leaves no unconfigured path behind
    /// it.
    #[tokio::test]
    async fn service_with_an_unconfigured_model_is_rejected_no_model() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-m", vec![]);
        let scratch = TestScratch::new("service-no-model");
        let host = host(&scratch, broker.clone());
        *host.model.write().unwrap() = crate::model::Settings::default();

        let reply = super::handle_service(&host, "conv-m".into(), None, None).await;

        let value = reply_json(&reply);
        assert_eq!(value["rejected"], true);
        assert_eq!(value["reason"], "no_model");
    }

    /// A conversation is never left half-served by that refusal.
    #[tokio::test]
    async fn a_service_rejected_for_no_model_undertakes_nothing() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-m2", vec![]);
        let scratch = TestScratch::new("service-no-model-clean");
        let host = host(&scratch, broker.clone());
        *host.model.write().unwrap() = crate::model::Settings::default();

        super::handle_service(&host, "conv-m2".into(), None, None).await;

        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls.iter().any(|c| c.starts_with("publish:")),
            "nothing undertaken on a rejected environment: {calls:?}"
        );
    }

    /// The cell holds everything but the name; the request names it. The two
    /// halves make a whole configuration, so the request is served.
    #[tokio::test]
    async fn service_naming_a_model_is_served_from_a_cell_that_has_no_name() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-m3", vec![]);
        seed_changes(&broker, "conv-m3", vec![]);
        let scratch = TestScratch::new("service-model-pin");
        let host = host(&scratch, broker.clone());
        *host.model.write().unwrap() = crate::model::Settings::default()
            .merged(&serde_json::json!({ "maxTokens": 8192 }))
            .unwrap();

        let reply =
            super::handle_service(&host, "conv-m3".into(), None, Some("claude-opus-5".into()))
                .await;

        assert_eq!(reply_json(&reply), serde_json::json!({ "accepted": true }));
    }

    /// An omitted cwd falls to the world's own default — absence delegates.
    #[tokio::test]
    async fn service_with_no_cwd_takes_the_worlds_own_default() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-d", vec![]);
        seed_changes(&broker, "conv-d", vec![]);
        let scratch = TestScratch::new("service-default-cwd");
        let host = host(&scratch, broker.clone());
        let expected = host
            .default_cwd
            .read()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let reply = super::handle_service(&host, "conv-d".into(), None, None).await;

        assert_eq!(reply_json(&reply), serde_json::json!({ "accepted": true }));
        await_call(&broker, "publish:conv.v2.conv-d.attachment.attached").await;
        let published = broker.published.lock().unwrap().clone();
        let attached = published
            .iter()
            .find(|(s, _)| s == "conv.v2.conv-d.attachment.attached")
            .expect("attached published");
        let payload: serde_json::Value = serde_json::from_slice(&attached.1).unwrap();
        assert_eq!(payload["cwd"], expected);
    }

    /// The world could not undertake the operation: `failed`, with the
    /// cause riding `detail` — the machine token stays coarse.
    #[tokio::test]
    async fn service_whose_premise_read_fails_is_rejected_failed_with_detail() {
        let broker = FakeBroker::default();
        broker.replay_data.lock().unwrap().insert(
            "conv.v2.conv-e.attachment.>".to_string(),
            VecDeque::from([Err("connection reset mid-replay".to_string())]),
        );
        let scratch = TestScratch::new("service-failed");
        let host = host(&scratch, broker.clone());

        let reply = super::handle_service(&host, "conv-e".into(), None, None).await;

        let value = reply_json(&reply);
        assert_eq!(value["rejected"], true);
        assert_eq!(value["reason"], "failed");
        let detail = value["detail"].as_str().expect("detail names the cause");
        assert!(
            detail.contains("connection reset mid-replay"),
            "detail must carry the underlying cause: {detail:?}"
        );
    }

    /// The request loop itself: queue-group per world, every request owes a
    /// reply — `service` dispatched, a malformed body `invalid`, any other
    /// leaf honest `unsupported`.
    #[tokio::test]
    async fn the_request_loop_answers_every_leaf_on_the_senders_reply_subject() {
        let broker = FakeBroker::default();
        broker
            .replay_data
            .lock()
            .unwrap()
            .insert("agent.v1.mac.telemetry.>".to_string(), VecDeque::new());
        broker
            .open_subjects
            .lock()
            .unwrap()
            .insert("agent.v1.mac.telemetry.>".to_string());
        broker.subscribe_data.lock().unwrap().insert(
            "agent.v1.mac.requests.>".to_string(),
            VecDeque::from([
                BrokerMessage {
                    subject: "agent.v1.mac.requests.drain".to_string(),
                    payload: b"{}".to_vec().into(),
                    reply: Some("_INBOX.r1".to_string()),
                },
                BrokerMessage {
                    subject: "agent.v1.mac.requests.service".to_string(),
                    payload: b"{}".to_vec().into(),
                    reply: Some("_INBOX.r2".to_string()),
                },
            ]),
        );
        let scratch = TestScratch::new("service-loop");
        let host = host(&scratch, broker.clone());

        super::serve_agent_requests_once(&host).await;

        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            calls
                .iter()
                .any(|c| c == "queue_subscribe:agent.v1.mac.requests.>:servicers"),
            "requests must ride the world's queue group, never a plain subscribe: {calls:?}"
        );
        let published = broker.published.lock().unwrap().clone();
        let reply_to = |subject: &str| {
            published
                .iter()
                .find(|(s, _)| s == subject)
                .map(|(_, p)| serde_json::from_slice::<serde_json::Value>(p).unwrap())
                .unwrap_or_else(|| panic!("no reply on {subject}: {published:?}"))
        };
        assert_eq!(
            reply_to("_INBOX.r1"),
            serde_json::json!({ "rejected": true, "reason": "unsupported" })
        );
        assert_eq!(
            reply_to("_INBOX.r2"),
            serde_json::json!({ "rejected": true, "reason": "invalid" })
        );
    }

    /// An unseedable map is a broken deployment, not a mode to serve
    /// through: the capture is load-bearing for the premise read too, so
    /// the loop refuses and the outer retry re-establishes.
    #[tokio::test]
    async fn the_request_loop_refuses_to_serve_when_the_seed_fails() {
        let broker = FakeBroker::default();
        // No scripted capture for the telemetry filter: replay_since fails.
        broker
            .open_subjects
            .lock()
            .unwrap()
            .insert("agent.v1.mac.telemetry.>".to_string());
        let scratch = TestScratch::new("service-no-seed");
        let host = host(&scratch, broker.clone());

        let established = super::serve_agent_requests_once(&host).await;

        assert!(established.is_none());
        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls
                .iter()
                .any(|c| c.starts_with("queue_subscribe:agent.v1.mac.requests.>")),
            "an unseedable instance must not answer requests: {calls:?}"
        );
    }

    /// A telemetry feed found dead during a request burst ends serving
    /// right after the request in hand — never deferred until traffic
    /// pauses, where a frozen map would age live holders into takeovers.
    /// Later requests already delivered on the dropped loop go unanswered
    /// (the sender's retry rides the re-established loop).
    #[tokio::test]
    async fn a_dead_feed_ends_serving_after_the_request_in_hand() {
        let broker = FakeBroker::default();
        broker
            .replay_data
            .lock()
            .unwrap()
            .insert("agent.v1.mac.telemetry.>".to_string(), VecDeque::new());
        // The telemetry subject is NOT marked open: the live subscription
        // ends as soon as the first drain looks at it.
        broker.subscribe_data.lock().unwrap().insert(
            "agent.v1.mac.requests.>".to_string(),
            VecDeque::from([
                BrokerMessage {
                    subject: "agent.v1.mac.requests.drain".to_string(),
                    payload: b"{}".to_vec().into(),
                    reply: Some("_INBOX.d1".to_string()),
                },
                BrokerMessage {
                    subject: "agent.v1.mac.requests.drain".to_string(),
                    payload: b"{}".to_vec().into(),
                    reply: Some("_INBOX.d2".to_string()),
                },
            ]),
        );
        let scratch = TestScratch::new("service-dead-feed");
        let host = host(&scratch, broker.clone());

        let established = super::serve_agent_requests_once(&host).await;

        assert!(established.is_some());
        let published = broker.published.lock().unwrap().clone();
        assert!(
            published.iter().any(|(s, _)| s == "_INBOX.d1"),
            "the request in hand still gets its reply: {published:?}"
        );
        assert!(
            !published.iter().any(|(s, _)| s == "_INBOX.d2"),
            "serving must end for re-establishment, not continue on the frozen map: {published:?}"
        );
    }

    /// The request loop must not serve at all when the world-mate liveness
    /// feed cannot be made: an instance answering off a permanently empty
    /// map would read every live same-world holder as stranded.
    #[tokio::test]
    async fn the_request_loop_refuses_to_serve_without_the_liveness_feed() {
        let broker = FakeBroker::default();
        broker
            .subscribe_fail_subjects
            .lock()
            .unwrap()
            .insert("agent.v1.mac.telemetry.>".to_string());
        let scratch = TestScratch::new("service-no-feed");
        let host = host(&scratch, broker.clone());

        super::serve_agent_requests_once(&host).await;

        let calls = broker.calls.lock().unwrap().clone();
        assert!(
            !calls
                .iter()
                .any(|c| c.starts_with("queue_subscribe:agent.v1.mac.requests.>")),
            "the two subscriptions stand or fall together: {calls:?}"
        );
    }

    fn epoch_ms_ago(secs: u64) -> String {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        wire::format_ts(now_ms - (secs as i64) * 1000)
    }

    fn pulse_frame(instance: &str, interval_s: i64, ago_secs: u64) -> BrokerMessage {
        BrokerMessage {
            subject: "agent.v1.mac.telemetry.pulse".to_string(),
            payload: serde_json::json!({
                "ts": epoch_ms_ago(ago_secs),
                "instanceId": instance,
                "intervalS": interval_s,
            })
            .to_string()
            .into_bytes()
            .into(),
            reply: None,
        }
    }

    /// Telemetry already queued on the live subscription folds before each
    /// request's premise is judged. Distinguishing setup: the seed leaves
    /// the holder stranded (an old captured pulse, 30s cadence, 100s ago),
    /// and only the fresh pulse sitting in the live queue makes it alive —
    /// the biased select alone would judge the premise first and take over.
    #[tokio::test]
    async fn queued_telemetry_folds_before_a_requests_premise_is_judged() {
        let broker = FakeBroker::default();
        broker.replay_data.lock().unwrap().insert(
            "agent.v1.mac.telemetry.>".to_string(),
            VecDeque::from([Ok(pulse_frame("inst-mate", 30, 100))]),
        );
        seed_attachment(
            &broker,
            "conv-q",
            vec![attached_frame("conv-q", "inst-mate", "mac")],
        );
        broker.subscribe_data.lock().unwrap().insert(
            "agent.v1.mac.telemetry.>".to_string(),
            VecDeque::from([BrokerMessage {
                subject: "agent.v1.mac.telemetry.pulse".to_string(),
                payload: serde_json::json!({
                    "ts": epoch_ms_ago(0),
                    "instanceId": "inst-mate",
                    "intervalS": 30,
                })
                .to_string()
                .into_bytes()
                .into(),
                reply: None,
            }]),
        );
        broker.subscribe_data.lock().unwrap().insert(
            "agent.v1.mac.requests.>".to_string(),
            VecDeque::from([BrokerMessage {
                subject: "agent.v1.mac.requests.service".to_string(),
                payload: serde_json::json!({ "conversationId": "conv-q" })
                    .to_string()
                    .into_bytes()
                    .into(),
                reply: Some("_INBOX.q1".to_string()),
            }]),
        );
        broker
            .open_subjects
            .lock()
            .unwrap()
            .insert("agent.v1.mac.telemetry.>".to_string());
        let scratch = TestScratch::new("service-queued-telemetry");
        let host = host(&scratch, broker.clone());

        super::serve_agent_requests_once(&host).await;

        let published = broker.published.lock().unwrap().clone();
        let reply = published
            .iter()
            .find(|(s, _)| s == "_INBOX.q1")
            .map(|(_, p)| serde_json::from_slice::<serde_json::Value>(p).unwrap())
            .expect("the request was answered");
        assert_eq!(
            reply,
            serde_json::json!({ "rejected": true, "reason": "already_attached" })
        );
        assert!(
            !published
                .iter()
                .any(|(s, _)| s == "conv.v2.conv-q.attachment.attached"),
            "a live pulse in the queue must never be outrun by a takeover: {published:?}"
        );
    }

    /// The seed builds the view instead of guessing: a world-mate whose
    /// last pulse (long cadence included) sits in the capture reads alive
    /// off its own promise — where an unseeded warm map would call it
    /// stranded, never having overheard it.
    #[tokio::test]
    async fn the_seed_folds_captured_pulses_so_a_long_cadence_mate_reads_alive() {
        let broker = FakeBroker::default();
        broker.replay_data.lock().unwrap().insert(
            "agent.v1.mac.telemetry.>".to_string(),
            VecDeque::from([Ok(pulse_frame("inst-slow", 300, 400))]),
        );
        let scratch = TestScratch::new("service-seed");
        let host = host(&scratch, broker.clone());

        super::seed_world_liveness(&host.broker, "conv-ephemeral", "mac", &host.liveness)
            .await
            .unwrap();

        // 400s of silence against a declared 300s cadence (threshold 900s):
        // alive by its own promise, which only the capture could know.
        let now = std::time::Instant::now();
        assert!(host.liveness.lock().unwrap().is_alive("inst-slow", now));
        assert!(
            !host.liveness.lock().unwrap().is_alive("inst-unheard", now),
            "the map is warm (testsupport backdates it): never-heard stays stranded"
        );
    }

    /// A captured frame older than the longest honoured silence cannot
    /// change any verdict and is skipped.
    #[tokio::test]
    async fn the_seed_skips_frames_older_than_the_honoured_window() {
        let broker = FakeBroker::default();
        broker.replay_data.lock().unwrap().insert(
            "agent.v1.mac.telemetry.>".to_string(),
            VecDeque::from([Ok(pulse_frame(
                "inst-old",
                300,
                crate::service::MAX_SILENCE_S + 60,
            ))]),
        );
        let scratch = TestScratch::new("service-seed-old");
        let host = host(&scratch, broker.clone());

        super::seed_world_liveness(&host.broker, "conv-ephemeral", "mac", &host.liveness)
            .await
            .unwrap();

        assert!(
            !host
                .liveness
                .lock()
                .unwrap()
                .is_alive("inst-old", std::time::Instant::now())
        );
    }

    /// A second `service` for a conversation this instance already serves is
    /// `already_attached` off the local claim itself — no fold ambiguity,
    /// and the same answer any instance in the world would give.
    #[tokio::test]
    async fn service_of_a_conversation_this_instance_serves_is_already_attached() {
        let broker = FakeBroker::default();
        seed_attachment(&broker, "conv-r", vec![]);
        seed_changes(&broker, "conv-r", vec![]);
        let scratch = TestScratch::new("service-resume");
        let host = host(&scratch, broker.clone());

        let first = super::handle_service(&host, "conv-r".into(), None, None).await;
        assert_eq!(reply_json(&first), serde_json::json!({ "accepted": true }));
        await_call(&broker, "publish:conv.v2.conv-r.attachment.attached").await;

        // The second read of the record now shows our own standing claim.
        let own = broker
            .published
            .lock()
            .unwrap()
            .iter()
            .find(|(s, _)| s == "conv.v2.conv-r.attachment.attached")
            .map(|(s, p)| BrokerMessage {
                subject: s.clone(),
                payload: p.clone().into(),
                reply: None,
            })
            .expect("first service attached");
        seed_attachment(&broker, "conv-r", vec![own]);
        let second = super::handle_service(&host, "conv-r".into(), None, None).await;
        assert_eq!(
            reply_json(&second),
            serde_json::json!({ "rejected": true, "reason": "already_attached" })
        );
    }
}
