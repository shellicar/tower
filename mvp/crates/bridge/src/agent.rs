//! One conversation: the servicer discipline on `.requests.>`, the v2 event
//! subjects produced per the conversation spec (the leaf spells the type;
//! bodies carry none). The decisions live in the pure `Conversation` fold
//! (decisions.rs); this loop is the shell that carries them out.
//!
//! Cancellation is cooperative: no hard abort, ever. The cancel arm only
//! signals (a `watch` flip) and replies `accepted`: acceptance is all a
//! reply means; the outcome is observed on the record like everything else.
//! The query task winds down at its next safe point, publishes its own
//! ending (`turn_cancelled` with the real turn id, then the `changes.query`
//! closure), and ALWAYS completes its `done.send`, so the tree can never
//! lose a message the wire has.

use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};

use futures::StreamExt;
use wire::{ConvRequest, ConversationId, encode_accepted, encode_rejected, now_iso, parse_request};

use std::collections::HashMap;
use std::sync::Arc;

use crate::anthropic;
use crate::decisions::{CancelDecision, Conversation, Message, QueryEnd, SayDecision};
use crate::skills::Skills;

/// Every tool schema offered on every turn, except `Skill` (gated on a
/// non-empty catalogue — conversation-specific, not static). The one source
/// both `run_query`'s per-turn tool list and main.rs's startup log read
/// from, so what's printed at boot and what's actually offered can never
/// drift apart. Bash is deliberately absent (kept in exec.rs, not deleted).
pub fn static_tool_schemas() -> Vec<Value> {
    vec![
        crate::exec::exec_schema(),
        crate::read::read_schema(),
        crate::find::find_schema(),
        crate::matcher::match_schema(),
        crate::slice::head_schema(),
        crate::slice::tail_schema(),
        crate::slice::range_schema(),
        crate::pipe::pipe_schema(),
        crate::readfile::read_file_schema(),
        crate::refs::ref_schema(),
        crate::mutate::create_file_schema(),
        crate::mutate::append_file_schema(),
        crate::editfile::edit_file_schema(),
        crate::delete::delete_schema(),
        crate::memtools::write_memory_schema(),
        crate::memtools::read_memory_schema(),
        crate::memtools::search_memory_schema(),
        crate::memtools::delete_memory_schema(),
        crate::memtools::memory_types_schema(),
        crate::historytools::search_history_schema(),
        crate::historytools::read_history_schema(),
    ]
}

pub struct AgentConfig {
    pub conv: ConversationId,
    /// The model cell. A spawn that named no model shares the host's live
    /// default, so a stdio `model` line reaches its next turn; a spawn that
    /// named one is pinned to its own cell. The model is an instance fact,
    /// not a conversation attribute — `turn.started` states what served each
    /// turn.
    pub model: Arc<std::sync::RwLock<String>>,
    /// The system prompt cell, shared and read fresh each turn so a stdio
    /// `system` control line reaches even a running conversation. Never
    /// persisted to the record.
    pub system: Arc<std::sync::RwLock<Option<String>>>,
    /// The user-context cell, shared; read once at a conversation's birth and
    /// committed to the record as a reminder block. A later change reaches only
    /// conversations spawned after it.
    pub context: Arc<std::sync::RwLock<Option<String>>>,
    pub auth: crate::anthropic::Auth,
    /// The skills directory, shared and mutable so a stdio `skills` control
    /// line can repoint it live. Re-scanned per say: the first say commits the
    /// full catalogue and records the delta baseline; later says commit a
    /// delta when a SKILL.md changed. A repoint surfaces as a delta on the
    /// next say of every running conversation.
    pub skills_root: Arc<std::sync::RwLock<std::path::PathBuf>>,
    /// The oversized-tool-output store (refs.rs) the `Ref` tool fetches from.
    pub refs: crate::refs::RefStore,
    /// The shared memory engine (memory.rs) the five Memory tools read/write.
    pub memory: crate::memory::MemoryStore,
    /// The shared history index (history.rs), best-effort-written on every
    /// committed message and read by SearchHistory/ReadHistory.
    pub history: crate::history::HistoryStore,
    /// Extended thinking budget; None = thinking off.
    pub thinking_budget: Option<i64>,
    /// The local TUI's attach handle, if this instance was spawned with one.
    /// None for every tower-spawned instance — NATS carries every event
    /// regardless; this is purely an additional local mirror.
    pub attach: Option<bridge::attach::AttachHandle>,
}

/// Subscribe to the conversation's requests. main calls this BEFORE
/// publishing `attached` and before reporting the spawn: a conversation
/// that cannot hear requests is not spawned in any meaningful sense, so
/// the claim and the reply both wait for this fact.
pub async fn subscribe(
    client: &async_nats::Client,
    conv: &ConversationId,
) -> Result<async_nats::Subscriber, async_nats::SubscribeError> {
    client
        .subscribe(format!("conv.v2.{}.requests.>", conv.0))
        .await
}

/// A publisher bound to one conversation: every event carries the same
/// client and id, so the call sites spell only the leaf and the body. This
/// is the shell's one door onto the wire for a served conversation.
struct Publisher {
    client: async_nats::Client,
    conv: ConversationId,
    history: crate::history::HistoryStore,
    attach: Option<bridge::attach::AttachHandle>,
}

impl Publisher {
    fn new(
        client: &async_nats::Client,
        conv: &ConversationId,
        history: &crate::history::HistoryStore,
        attach: Option<bridge::attach::AttachHandle>,
    ) -> Self {
        Self {
            client: client.clone(),
            conv: conv.clone(),
            history: crate::history::HistoryStore::clone(history),
            attach,
        }
    }

    fn client(&self) -> &async_nats::Client {
        &self.client
    }

    fn conv(&self) -> &ConversationId {
        &self.conv
    }

    fn attach(&self) -> &Option<bridge::attach::AttachHandle> {
        &self.attach
    }

    /// `leaf` is the class-and-event path after the id (`changes.message`,
    /// `telemetry.turn.started`): v2's one-place discriminator.
    async fn event(&self, leaf: &str, payload: Value) {
        let subject = format!("conv.v2.{}.{leaf}", self.conv.0);
        let bytes = serde_json::to_vec(&payload).expect("json! of plain values cannot fail");
        eprintln!(
            "{} bridge[{}]: → {subject} ({} B)",
            now_iso(),
            self.conv.0,
            bytes.len()
        );
        // Tee first: it only borrows, so the NATS publish can take the bytes
        // by move — no per-event clone on the hot path (tool results run to
        // hundreds of KB; a tower-only instance must not pay for a mirror it
        // doesn't have).
        bridge::attach::tee(&self.attach, &subject, &bytes).await;
        if let Err(e) = self.client.publish(subject, bytes.into()).await {
            eprintln!("bridge[{}]: publish failed: {e}", self.conv.0);
        }
    }

    /// Commit a message to the record (`changes.message`): the change stream
    /// constitutes the conversation, so this is the only publish that moves
    /// the tip.
    /// `from` is the sender's provenance — present for an utterance (a say,
    /// an assistant turn), absent for a tool_result: it is a mechanical
    /// delivery of a tool's output, not something anyone sent, so it carries
    /// no sender at all rather than a fabricated one.
    async fn message(
        &self,
        id: &str,
        query: &str,
        turn: &str,
        role: &str,
        from: Option<&Value>,
        content: &[Value],
    ) {
        let mut payload = json!({
            "ts": now_iso(),
            "id": id, "queryId": query, "turnId": turn,
            "role": role, "content": content,
        });
        if let Some(from) = from {
            payload["from"] = from.clone();
        }
        self.event("changes.message", payload).await;

        // Best-effort projection into the shared history index (AuditWriter.ts's
        // own discipline): the record on the wire is the source of truth, so a
        // history-write failure is logged and swallowed here, never propagated —
        // the history record must never break the conversation it records. A
        // gap left by a failure here is a rebuildable projection, healed later
        // by a JetStream-replay import, not by retrying inline.
        let history_message = crate::history::HistoryMessage {
            id: id.to_string(),
            conversation_id: self.conv.0.clone(),
            turn_id: turn.to_string(),
            query_id: query.to_string(),
            timestamp: now_iso(),
            role: if role == "user" {
                crate::history::Role::User
            } else {
                crate::history::Role::Assistant
            },
            blocks: crate::history::to_history_blocks(content),
        };
        if let Err(e) = crate::history::insert(&self.history, &history_message) {
            eprintln!(
                "bridge[{}]: history index projection failed (swallowed): {e}",
                self.conv.0
            );
        }
    }
}

/// `conversation` is the servicer's starting tree: `Conversation::default()`
/// for a spawn, an adopted record for a revival - the loop is identical
/// either way, because the record constitutes the conversation.
pub async fn run(
    client: async_nats::Client,
    requests: async_nats::Subscriber,
    config: AgentConfig,
    conversation: Conversation,
) {
    let prefix = format!("conv.v2.{}.requests.", config.conv.0);
    let mut requests = requests;
    eprintln!("bridge[{}]: serving", config.conv.0);

    let mut conversation = conversation;
    // The live query's cancel signal, the shell's I/O half of what the
    // fold tracks; dropped when the query's end folds.
    let mut cancel_tx: Option<watch::Sender<bool>> = None;
    // The delta baseline: name→content-hash from the last scan. None until the
    // first say records it (which stays silent; the full catalogue leads instead).
    let mut skill_hashes: Option<HashMap<String, u64>> = None;
    let (done_tx, mut done_rx) = mpsc::channel::<(String, QueryEnd)>(8);

    loop {
        tokio::select! {
            // A query finished: fold its outcome into the tree.
            Some((query, end)) = done_rx.recv() => {
                conversation.on_query_end(query, end);
                cancel_tx = None;
            }
            maybe = requests.next() => {
                let Some(msg) = maybe else {
                    // A lapsed subscription is a dead conversation: events
                    // would keep streaming from live query tasks while every
                    // request times out — say it loudly.
                    eprintln!(
                        "bridge[{}]: requests subscription ended — no longer serving",
                        config.conv.0
                    );
                    break;
                };
                let Some(reply_to) = msg.reply.clone() else { continue };
                // v2: the leaf spells the operation; read it off the subject.
                let leaf = msg.subject.strip_prefix(prefix.as_str()).unwrap_or("");
                eprintln!(
                    "{} bridge[{}]: ← request {leaf} ({} B)",
                    now_iso(),
                    config.conv.0,
                    msg.payload.len()
                );
                let response = match parse_request(leaf, &msg.payload) {
                    ConvRequest::Say { text, tip, from, attachments } => {
                        let has_new_content = !text.trim().is_empty() || !attachments.is_empty();
                        match conversation.on_say(tip.as_ref().map(|t| t.0.as_str()), has_new_content) {
                            SayDecision::Stale => encode_rejected("stale"),
                            // The sender's tip was correct; there was just
                            // nothing to send and nothing to resume (the tip
                            // is an assistant message, or the conversation
                            // is empty) — honest and distinct from `stale`.
                            SayDecision::Empty => encode_rejected("empty"),
                            SayDecision::Accept => match accept_say(
                                &client,
                                &config,
                                &mut conversation,
                                &mut skill_hashes,
                                &done_tx,
                                text,
                                from,
                                attachments,
                            )
                            .await
                            {
                                Ok((query, tx)) => {
                                    cancel_tx = Some(tx);
                                    encode_accepted(Some(&query))
                                }
                                Err(reason) => encode_rejected(&reason),
                            },
                        }
                    }
                    ConvRequest::Cancel { query, .. } => {
                        // A query's publishes land on the wire before its
                        // completion reaches this loop, so fold anything
                        // buffered first: a query that finished a beat ago
                        // reads as complete, never as cancellable.
                        while let Ok((q, end)) = done_rx.try_recv() {
                            conversation.on_query_end(q, end);
                            cancel_tx = None;
                        }
                        match conversation.on_cancel(&query.0) {
                            CancelDecision::Signal => {
                                // Signal and reply accepted; acceptance is
                                // all a reply means. The task publishes the
                                // outcome (turn_cancelled + the query
                                // closure) itself, with the real turn id.
                                if let Some(tx) = &cancel_tx {
                                    let _ = tx.send(true);
                                }
                                encode_accepted(None)
                            }
                            CancelDecision::AlreadyComplete => {
                                encode_rejected("already_complete")
                            }
                            CancelDecision::NotFound => encode_rejected("not_found"),
                        }
                    }
                    ConvRequest::Other { type_name } => {
                        eprintln!("bridge[{}]: unsupported request {type_name}", config.conv.0);
                        encode_rejected("unsupported")
                    }
                };
                if let Err(e) = client.publish(reply_to, response.into()).await {
                    eprintln!("bridge[{}]: reply publish failed: {e}", config.conv.0);
                }
            }
        }
    }
}

/// Accept a say: mint the query's ids, snapshot the skills catalogue on the
/// first message, build the pending user turn, resolve its attachments for
/// the model, and spawn the query task. Returns the query id (echoed to the
/// sender as `accepted`) and its cancel sender (the shell's I/O half of the
/// fold's cancel tracking).
///
/// The user half is PENDING, not committed: the spec's recommended
/// declaration. It commits with the first turn's result; a query cancelled
/// before then leaves the record untouched - the cancel revoked the say, not
/// just the turn.
#[allow(clippy::too_many_arguments)]
async fn accept_say(
    client: &async_nats::Client,
    config: &AgentConfig,
    conversation: &mut Conversation,
    skill_hashes: &mut Option<HashMap<String, u64>>,
    done_tx: &mpsc::Sender<(String, QueryEnd)>,
    text: String,
    from: Value,
    attachments: Vec<Value>,
) -> Result<(String, watch::Sender<bool>), String> {
    // Validate every fresh attachment BEFORE anything commits: unlike a
    // replayed history block (objects.rs), a failure here is never ageing —
    // it means the object this say just referenced genuinely isn't there
    // (wrong bucket, dropped upload, unreachable store), so the say rejects
    // outright rather than let the model see a placeholder in place of what
    // the sender actually attached.
    if let Err(detail) = crate::objects::validate_fresh(client, &attachments).await {
        // The wire's reason is a short canonical token, same footing as
        // `stale`/`empty`/`already_complete`; the detail (which bucket, which
        // id, which error) is diagnostic and belongs in the log, not the reply.
        eprintln!("bridge[{}]: attachment validation failed: {detail}", config.conv.0);
        return Err("attachment_unavailable".to_string());
    }
    let query = uuid::Uuid::new_v4().to_string();
    let turn = uuid::Uuid::new_v4().to_string();
    let message_id = uuid::Uuid::new_v4().to_string();

    // Re-scan the (possibly repointed) skills directory for this say. The scan
    // is what this query's Skill tool resolves against, so a repoint takes
    // effect immediately. The reminder committed lives in the record, so what
    // the model saw is what is stored: the first say leads with the full
    // catalogue (a genuinely empty conversation — an adopted record's replayed
    // first message already carries it) and records the delta baseline silently;
    // later says carry a delta when a SKILL.md changed since the last scan.
    let root = config.skills_root.read().unwrap().clone();
    let skills = Arc::new(Skills::scan(root));
    // Birth: a genuinely empty conversation. The full skills catalogue and the
    // user-context block both ride the opening message, and only at birth.
    let birth = conversation.is_empty();
    let reminder: Option<String> = match skill_hashes.as_ref() {
        None => {
            if birth {
                skills.reminder()
            } else {
                None
            }
        }
        Some(prev) => skills.delta(prev),
    };
    *skill_hashes = Some(skills.baseline());
    let mut content = Vec::new();
    // Self-heal a broken tip. A prior servicer that died after committing a
    // tool_use but before its tool_result leaves the record ending on a
    // dangling tool_use, which the API rejects. Answer each with an abandoned
    // result, carried on this say's user message ahead of its text (tool_result
    // blocks lead): one honest, valid message - the outcome of the tool_use
    // (no result), never a claim about what the tool did.
    for id in conversation.dangling_tool_uses() {
        content.push(json!({
            "type": "tool_result",
            "tool_use_id": id,
            "content": "abandoned: the servicer was restarted before this tool completed",
            "is_error": true,
        }));
    }
    if let Some(reminder) = reminder {
        content.push(json!({ "type": "text", "text": reminder }));
    }
    // The user-context block sits after the catalogue and, like it, only at
    // birth; committed to the record, so revive replays it and no restart can
    // invalidate it.
    if birth && let Some(ctx) = config.context.read().unwrap().clone() {
        content.push(json!({
            "type": "text",
            "text": format!("<system-reminder>\n{ctx}\n</system-reminder>\n\n"),
        }));
    }
    // Reference blocks verbatim: the COMMITTED message carries these, never
    // bytes. The model-facing render resolves them below, over the WHOLE
    // history - the tree and any adopted record hold reference blocks too,
    // and the API must never see one.
    content.extend(attachments);
    // The API rejects an empty text block outright ("text content blocks
    // must be non-empty") — an empty say only reaches accept_say at all when
    // the tip is a dangling user-role message that resumes with no new
    // content (SayDecision::Accept, decisions.rs), so the block is simply
    // omitted rather than sent empty.
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }

    let user = Message {
        id: message_id,
        role: "user".into(),
        content,
    };
    conversation.start_query(query.clone());

    // The query task, cooperatively cancellable.
    let (tx, rx) = watch::channel(false);
    // The model sees the pending say; the record does not, yet.
    let mut history = conversation.history();
    history.push(json!({ "role": "user", "content": user.content }));

    let ctx = TurnContext {
        client: client.clone(),
        conv: config.conv.clone(),
        // Read fresh per query: a stdio `model` line reaches even a running
        // conversation, here, on its next say.
        model: config.model.read().unwrap().clone(),
        system: Arc::clone(&config.system),
        auth: config.auth.clone(),
        skills,
        query: query.clone(),
        turn,
        user,
        user_from: from,
        refs: crate::refs::RefStore::clone(&config.refs),
        memory: crate::memory::MemoryStore::clone(&config.memory),
        history_store: crate::history::HistoryStore::clone(&config.history),
        thinking_budget: config.thinking_budget,
        attach: config.attach.clone(),
    };
    let done = done_tx.clone();
    let q = query.clone();
    tokio::spawn(async move {
        // Resolution (object fetches + image conditioning) runs over the full
        // render at this edge (objects.rs) — inside the task, never ahead of
        // the say's reply: on a long image-laden history it takes seconds, and
        // the sender's request deadline must not pay for it.
        crate::objects::resolve_history(&ctx.client, &mut history).await;
        let end = run_query(ctx, history, rx).await;
        let _ = done.send((q, end)).await;
    });
    Ok((query, tx))
}

struct TurnContext {
    client: async_nats::Client,
    conv: ConversationId,
    model: String,
    system: Arc<std::sync::RwLock<Option<String>>>,
    auth: crate::anthropic::Auth,
    skills: Arc<Skills>,
    query: String,
    turn: String,
    /// The say: turn 1's user half, pending until that turn commits.
    user: Message,
    user_from: Value,
    refs: crate::refs::RefStore,
    memory: crate::memory::MemoryStore,
    history_store: crate::history::HistoryStore,
    thinking_budget: Option<i64>,
    attach: Option<bridge::attach::AttachHandle>,
}

/// Resolves when the cancel signal flips; never resolves if it never does
/// (a dropped sender means nobody can cancel any more, not "cancelled").
/// Shared with exec (a running command races it) and approval (a pending
/// ask races it): one cancel semantics everywhere.
pub(crate) async fn cancelled(rx: &mut watch::Receiver<bool>) {
    loop {
        if *rx.borrow_and_update() {
            return;
        }
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// One query: turns until the model stops asking for tools. A `tool_use`
/// stop commits the assistant message, executes the tools, commits the
/// results as a user-role message (from the agent, whose harness produced
/// them), and runs the next turn; the query closes committally on the turn
/// that ends any other way.
///
/// Cancellation checkpoints: mid-stream (the model call is abandoned;
/// nothing of that turn was committed, so `turn_cancelled` is exact) and
/// between rounds (the finished turn's commits are on the wire and stand;
/// only the remaining work is cancelled). Failure is `turn_aborted` + the
/// aborted closure: honesty over silence.
async fn run_query(
    ctx: TurnContext,
    mut history: Vec<Value>,
    mut cancel: watch::Receiver<bool>,
) -> QueryEnd {
    let TurnContext {
        client,
        conv,
        model,
        system,
        auth,
        skills,
        query,
        turn,
        user,
        user_from,
        refs,
        memory,
        history_store,
        thinking_budget,
        attach,
    } = &ctx;
    let pubr = Publisher::new(client, conv, history_store, attach.clone());

    // Skill only when a catalogue exists; every other tool is always this
    // same list (static_tool_schemas) — the one source main.rs's startup log
    // reads from too, so what's printed and what's actually offered can never
    // drift apart.
    let mut tools: Vec<Value> = static_tool_schemas();
    if !skills.is_empty() {
        tools.push(skills.tool_schema());
    }

    let mut committed: Vec<Message> = Vec::new();
    // The say rides pending and commits with the FIRST turn's result: words
    // are revocable while nothing depends on them, so a query cancelled
    // before its first commit leaves the record untouched. Tool results are
    // different (see the tool round below): a committed tool_use without its
    // tool_result is an INVALID conversation no servicer can continue, so
    // results commit at execution and a later cancel leaves the record
    // resting validly on the tool_result - the next say appends after it.
    let mut pending_user = Some(user.clone());
    let mut turn_id = turn.clone();

    loop {
        pubr.event(
            "telemetry.turn.started",
            json!({
                "ts": now_iso(),
                "queryId": query, "turnId": turn_id,
                "service": "anthropic.messages", "model": model,
                "thinking": thinking_budget.is_some(), "maxTokens": anthropic::MAX_TOKENS,
            }),
        )
        .await;

        // The turn races the cancel signal: a mid-stream cancel abandons the
        // model call. Nothing of this turn committed, so the cancelled
        // marker (real turn id) tells the exact truth.
        // Read the system prompt fresh each turn: a stdio `system` change
        // reaches even a running conversation, here, on its next turn.
        let system = system.read().unwrap().clone();
        let outcome = tokio::select! {
            outcome = anthropic::stream_turn(
                client,
                conv,
                auth,
                model,
                system.as_deref(),
                &history,
                &tools,
                *thinking_budget,
                attach,
            ) => outcome,
            _ = cancelled(&mut cancel) => {
                pubr.event(
                    "telemetry.turn.cancelled",
                    json!({ "ts": now_iso(), "queryId": query, "turnId": turn_id }),
                )
                .await;
                pubr.event(
                    "changes.query",
                    json!({ "ts": now_iso(), "queryId": query, "reason": "cancelled" }),
                )
                .await;
                return QueryEnd::Cancelled { messages: committed };
            }
        };

        let done = match outcome {
            Ok(done) => done,
            Err(e) => {
                eprintln!("bridge[{}]: turn aborted: {e:#}", conv.0);
                pubr.event(
                    "telemetry.turn.aborted",
                    json!({ "ts": now_iso(), "queryId": query, "turnId": turn_id }),
                )
                .await;
                pubr.event(
                    "changes.query",
                    json!({ "ts": now_iso(), "queryId": query, "reason": "aborted" }),
                )
                .await;
                return QueryEnd::Aborted {
                    messages: committed,
                };
            }
        };

        pubr.event(
            "telemetry.turn.ended",
            json!({
                "ts": now_iso(),
                "queryId": query, "turnId": turn_id,
                "stopReason": done.stop_reason,
            }),
        )
        .await;
        pubr.event(
            "telemetry.usage",
            json!({
                "ts": now_iso(),
                "queryId": query, "turnId": turn_id,
                "service": "anthropic.messages", "model": model,
                "inputTokens": done.input_tokens,
                "cacheCreationTokens": done.cache_creation_tokens,
                "cacheCreation5mTokens": done.cache_creation_5m_tokens,
                "cacheCreation1hTokens": done.cache_creation_1h_tokens,
                "cacheReadTokens": done.cache_read_tokens,
                "outputTokens": done.output_tokens,
            }),
        )
        .await;

        // The first successful turn commits the pending say, then the
        // assistant message: the record gains the pair together, and a query
        // that never got this far left the record untouched.
        if let Some(u) = pending_user.take() {
            pubr.message(&u.id, query, &turn_id, "user", Some(user_from), &u.content)
                .await;
            committed.push(u);
        }

        // Commit the assistant message: whatever the stop reason, this
        // content is the record.
        let message_id = uuid::Uuid::new_v4().to_string();
        pubr.message(
            &message_id,
            query,
            &turn_id,
            "assistant",
            Some(&json!({ "kind": "agent" })),
            &done.content,
        )
        .await;
        history.push(json!({ "role": "assistant", "content": done.content }));
        committed.push(Message {
            id: message_id,
            role: "assistant".into(),
            content: done.content.clone(),
        });

        if done.stop_reason != "tool_use" {
            // The query's committal closure (conversation-spec, changes.query).
            pubr.event(
                "changes.query",
                json!({ "ts": now_iso(), "queryId": query, "reason": "completed" }),
            )
            .await;
            return QueryEnd::Completed {
                messages: committed,
            };
        }

        // Between rounds: a cancel here stops the remaining work; the turn
        // that just ended stands (its commits are on the wire), so there is
        // no turn to mark cancelled, only the query's closure.
        if *cancel.borrow() {
            pubr.event(
                "changes.query",
                json!({ "ts": now_iso(), "queryId": query, "reason": "cancelled" }),
            )
            .await;
            return QueryEnd::Cancelled {
                messages: committed,
            };
        }

        // Execute the tool_use blocks and commit the results as one
        // user-role message from the agent: the harness produced them. The
        // results commit at execution, unlike the say: the committed
        // tool_use above is unanswerable without them - a record resting on
        // a bare tool_use is invalid for every future turn.
        let results = run_tool_round(
            &pubr,
            skills,
            refs,
            memory,
            history_store,
            &tools,
            query,
            &turn_id,
            &done.content,
            &mut cancel,
        )
        .await;

        let message_id = uuid::Uuid::new_v4().to_string();
        // No `from`: a tool_result is the mechanical delivery of a tool's
        // output, not an utterance — nobody sent it, so nobody is stamped as
        // having sent it (conversation-spec, 19 Jul correction).
        pubr.message(&message_id, query, &turn_id, "user", None, &results)
            .await;
        history.push(json!({ "role": "user", "content": results.clone() }));
        committed.push(Message {
            id: message_id,
            role: "user".into(),
            content: results,
        });

        // The next round is a new turn of the same query.
        turn_id = uuid::Uuid::new_v4().to_string();
    }
}

/// One tool round: execute every `tool_use` block in the just-committed
/// assistant turn and return the `tool_result` blocks, in order. The action
/// is published as telemetry before it runs (`input` included - the action
/// is unreviewable without the payload). The slot is ALWAYS filled: a
/// committed tool_use without its result is an invalid conversation the
/// caller must still be able to close.
#[allow(clippy::too_many_arguments)]
async fn run_tool_round(
    pubr: &Publisher,
    skills: &Skills,
    refs: &crate::refs::RefStore,
    memory: &crate::memory::MemoryStore,
    history_store: &crate::history::HistoryStore,
    offered: &[Value],
    query: &str,
    turn_id: &str,
    content: &[Value],
    cancel: &mut watch::Receiver<bool>,
) -> Vec<Value> {
    // The gate: a tool_use for anything not in THIS turn's offered set is
    // refused before any dispatch touches it, never executed. A schema
    // absent from `tools` is not a suggestion the model might ignore — it is
    // the only enforcement disabling a tool has. A model calling a name it
    // was never offered (stale context, a hallucinated retry, an adopted
    // conversation's history) must never reach a match arm that still knows
    // how to run it.
    let offered_names: std::collections::HashSet<&str> =
        offered.iter().filter_map(|t| t["name"].as_str()).collect();
    let mut results: Vec<Value> = Vec::new();
    for block in content.iter().filter(|b| b["type"] == "tool_use") {
        let id = block["id"].as_str().unwrap_or("");
        let name = block["name"].as_str().unwrap_or("");
        // The action, observed before it runs (conversation-spec, Telemetry).
        pubr.event(
            "telemetry.tool.use",
            json!({
                "ts": now_iso(),
                "queryId": query, "turnId": turn_id,
                "id": id, "name": name, "input": block["input"],
            }),
        )
        .await;
        if !offered_names.contains(name) {
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": format!("unknown tool {name:?}"),
                "is_error": true,
            }));
            continue;
        }
        // ReadFile is the one tool whose result isn't text (a binary attachment
        // is a content block array) — handled before the common match, which
        // assumes every other tool's result is a plain String.
        if name == "ReadFile" {
            let (result_content, is_error) = crate::readfile::run_read_file(&block["input"]).await;
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": result_content,
                "is_error": is_error,
            }));
            continue;
        }
        let (content, is_error) = match name {
            "Skill" => {
                let skill = block["input"]["skill"].as_str().unwrap_or("");
                match skills.invoke(skill) {
                    Ok(body) => (body, false),
                    Err(e) => (e, true),
                }
            }
            // Every Bash call gates behind a human approval in v1 -
            // `echo hello` included. Policy (auto-approve, blocklists) is
            // future work; wait-forever is sane precisely because the ask
            // is visible and the query cancellable.
            "Bash" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        let command = block["input"]["command"].as_str().unwrap_or("");
                        crate::exec::run_bash(command, cancel).await
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    // The slot still gets its result: a committed tool_use
                    // without one is an invalid conversation. The cancel
                    // flag is set, so the caller's between-rounds check
                    // closes the query cancelled right after these commit.
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            // Exec gates behind the same human approval as Bash — same gate,
            // structured input instead of a shell string.
            "Exec" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        match crate::exec::parse_commands(&block["input"]) {
                            Ok(commands) => {
                                let results = crate::exec::run_commands(&commands, cancel).await;
                                crate::exec::format_results(&commands, &results)
                            }
                            Err(e) => (format!("invalid Exec input: {e}"), true),
                        }
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            // Read is read-only: no approval gate.
            "Read" => match crate::read::run_read(&block["input"]).await {
                Ok((stream, any_error)) => (crate::stream::format_stream(&stream), any_error),
                Err(e) => (format!("invalid Read input: {e}"), true),
            },
            // Find is discovery, read-only: no approval gate (composition-model.md
            // — nothing it finds is acted on, so there is nothing to bound).
            "Find" => match crate::find::run_find(&block["input"]).await {
                Ok(stream) => (crate::stream::format_stream(&stream), false),
                Err(e) => (format!("invalid Find input: {e}"), true),
            },
            // Match is read-only: no approval gate.
            "Match" => match crate::matcher::run_match(&block["input"]).await {
                Ok((stream, any_error)) => (crate::stream::format_stream(&stream), any_error),
                Err(e) => (format!("invalid Match input: {e}"), true),
            },
            // Head/Tail/Range are read-only: no approval gate.
            "Head" => match crate::slice::run_head(&block["input"]).await {
                Ok((stream, any_error)) => (crate::stream::format_stream(&stream), any_error),
                Err(e) => (format!("invalid Head input: {e}"), true),
            },
            "Tail" => match crate::slice::run_tail(&block["input"]).await {
                Ok((stream, any_error)) => (crate::stream::format_stream(&stream), any_error),
                Err(e) => (format!("invalid Tail input: {e}"), true),
            },
            "Range" => match crate::slice::run_range(&block["input"]).await {
                Ok((stream, any_error)) => (crate::stream::format_stream(&stream), any_error),
                Err(e) => (format!("invalid Range input: {e}"), true),
            },
            // Pipe is read-only: no approval gate. Every step it dispatches
            // to is itself read-only, so composing them adds no privilege.
            "Pipe" => match crate::pipe::run_pipe(&block["input"]).await {
                Ok((stream, any_error)) => (crate::stream::format_stream(&stream), any_error),
                Err(e) => (format!("invalid Pipe input: {e}"), true),
            },
            // Ref is read-only: no approval gate.
            "Ref" => crate::refs::run_ref(refs, &block["input"]),
            // CreateFile/AppendFile gate behind the same human approval as
            // Bash/Exec — a mutation, same discipline.
            "CreateFile" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        crate::mutate::run_create_file(&block["input"]).await
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            "AppendFile" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        crate::mutate::run_append_file(&block["input"]).await
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            "EditFile" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        crate::editfile::run_edit_file(&block["input"]).await
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            "Delete" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        crate::delete::run_delete(&block["input"]).await
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            // WriteMemory/DeleteMemory mutate: gated like every other mutation.
            "WriteMemory" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        crate::memtools::run_write_memory(memory, &block["input"]).await
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            "DeleteMemory" => {
                let approval_id = uuid::Uuid::new_v4().to_string();
                let ask = json!({ "type": "tool_use", "name": name, "input": block["input"] });
                let correlation = json!({
                    "conversationId": pubr.conv().0,
                    "queryId": query,
                    "turnId": turn_id,
                    "toolUseId": id,
                });
                match crate::approval::gate(
                    pubr.client(),
                    pubr.attach(),
                    &approval_id,
                    &ask,
                    &correlation,
                    cancel,
                )
                .await
                {
                    crate::approval::Verdict::Approved => {
                        crate::memtools::run_delete_memory(memory, &block["input"])
                    }
                    crate::approval::Verdict::Denied { by } => (format!("denied by {by}"), true),
                    crate::approval::Verdict::Cancelled => {
                        ("cancelled by user before approval".to_string(), true)
                    }
                }
            }
            // ReadMemory/SearchMemory/MemoryTypes are read-only: no approval gate.
            "ReadMemory" => crate::memtools::run_read_memory(memory, &block["input"]),
            "SearchMemory" => crate::memtools::run_search_memory(memory, &block["input"]),
            "MemoryTypes" => crate::memtools::run_memory_types(memory),
            // SearchHistory/ReadHistory are read-only: no approval gate.
            "SearchHistory" => {
                crate::historytools::run_search_history(history_store, &block["input"])
            }
            "ReadHistory" => crate::historytools::run_read_history(history_store, &block["input"]),
            other => (format!("unknown tool {other:?}"), true),
        };
        // Walk and replace: anything over the oversized threshold is stashed
        // whole (never discarded) and swapped for a small { ref, size, hint }
        // pointer the model pages back in with the Ref tool.
        let content = crate::refs::finalize(refs, content, name);
        results.push(json!({
            "type": "tool_result",
            "tool_use_id": id,
            "content": content,
            "is_error": is_error,
        }));
    }
    results
}
