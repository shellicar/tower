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

use std::sync::Arc;

use crate::anthropic;
use crate::decisions::{CancelDecision, Conversation, Message, QueryEnd, SayDecision};
use crate::skills::Skills;

/// Tool rounds per query before the bridge gives up: a runaway tool loop
/// must not spin forever on someone's API bill.
const MAX_TURNS_PER_QUERY: usize = 16;

pub struct AgentConfig {
    pub conv: ConversationId,
    pub model: String,
    pub system: Option<String>,
    pub auth: crate::anthropic::Auth,
    /// Scanned at the conversation's FIRST message, then fixed: the
    /// catalogue must match the reminder committed into the record, and a
    /// skill added after boot still reaches the next conversation.
    pub skills_root: std::path::PathBuf,
}

pub async fn run(client: async_nats::Client, config: AgentConfig) {
    let subject = format!("conv.v2.{}.requests.>", config.conv.0);
    let prefix = format!("conv.v2.{}.requests.", config.conv.0);
    let mut requests = match client.subscribe(subject).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("bridge[{}]: subscribe failed: {e}", config.conv.0);
            return;
        }
    };
    eprintln!("bridge[{}]: serving", config.conv.0);

    let mut conversation = Conversation::default();
    // The live query's cancel signal, the shell's I/O half of what the
    // fold tracks; dropped when the query's end folds.
    let mut cancel_tx: Option<watch::Sender<bool>> = None;
    // None until the first message scans the catalogue.
    let mut skills: Option<Arc<Skills>> = None;
    let (done_tx, mut done_rx) = mpsc::channel::<(String, QueryEnd)>(8);

    loop {
        tokio::select! {
            // A query finished: fold its outcome into the tree.
            Some((query, end)) = done_rx.recv() => {
                conversation.on_query_end(query, end);
                cancel_tx = None;
            }
            maybe = requests.next() => {
                let Some(msg) = maybe else { break };
                let Some(reply_to) = msg.reply.clone() else { continue };
                // v2: the leaf spells the operation; read it off the subject.
                let leaf = msg.subject.strip_prefix(prefix.as_str()).unwrap_or("");
                let response = match parse_request(leaf, &msg.payload) {
                    ConvRequest::Say { text, tip, from } => {
                        match conversation.on_say(tip.as_ref().map(|t| t.0.as_str())) {
                            SayDecision::Stale => encode_rejected("stale"),
                            SayDecision::Accept => {
                                let query = uuid::Uuid::new_v4().to_string();
                                let turn = uuid::Uuid::new_v4().to_string();
                                let message_id = uuid::Uuid::new_v4().to_string();
                                // The first message takes the catalogue snapshot
                                // and carries the reminder as its FIRST block,
                                // the said text second. It lives in the committed
                                // record, so what the model saw is what is stored.
                                let skills = Arc::clone(skills.get_or_insert_with(|| {
                                    Arc::new(Skills::scan(config.skills_root.clone()))
                                }));
                                let mut content = Vec::new();
                                if conversation.is_empty()
                                    && let Some(reminder) = skills.reminder()
                                {
                                    content.push(json!({ "type": "text", "text": reminder }));
                                }
                                content.push(json!({ "type": "text", "text": text }));

                                // Commit the user half first; half a chat is not a chat.
                                publish_message(&client, &config.conv, &message_id, &query, &turn,
                                                "user", &from, &content).await;
                                conversation.start_query(query.clone(), Message {
                                    id: message_id,
                                    role: "user".into(),
                                    content,
                                });

                                // The query task, cooperatively cancellable.
                                let (tx, rx) = watch::channel(false);
                                cancel_tx = Some(tx);
                                let ctx = TurnContext {
                                    client: client.clone(),
                                    conv: config.conv.clone(),
                                    model: config.model.clone(),
                                    system: config.system.clone(),
                                    auth: config.auth.clone(),
                                    skills,
                                    query: query.clone(),
                                    turn,
                                };
                                let history = conversation.history();
                                let done = done_tx.clone();
                                let q = query.clone();
                                tokio::spawn(async move {
                                    let end = run_query(ctx, history, rx).await;
                                    let _ = done.send((q, end)).await;
                                });
                                encode_accepted(Some(&query))
                            }
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
                let _ = client.publish(reply_to, response.into()).await;
            }
        }
    }
}

struct TurnContext {
    client: async_nats::Client,
    conv: ConversationId,
    model: String,
    system: Option<String>,
    auth: crate::anthropic::Auth,
    skills: Arc<Skills>,
    query: String,
    turn: String,
}

/// Resolves when the cancel signal flips; never resolves if it never does
/// (a dropped sender means nobody can cancel any more, not "cancelled").
async fn cancelled(rx: &mut watch::Receiver<bool>) {
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
    } = &ctx;

    let tools: Vec<Value> = if skills.is_empty() {
        Vec::new()
    } else {
        vec![skills.tool_schema()]
    };

    let mut committed: Vec<Message> = Vec::new();
    let mut turn_id = turn.clone();

    for round in 0.. {
        publish(
            client,
            conv,
            "telemetry.turn.started",
            json!({
                "ts": now_iso(),
                "queryId": query, "turnId": turn_id,
                "service": "anthropic.messages", "model": model,
                "thinking": false, "maxTokens": anthropic::MAX_TOKENS,
            }),
        )
        .await;

        // The turn races the cancel signal: a mid-stream cancel abandons the
        // model call. Nothing of this turn committed, so the cancelled
        // marker (real turn id) tells the exact truth.
        let outcome = tokio::select! {
            outcome = anthropic::stream_turn(
                client,
                conv,
                auth,
                model,
                system.as_deref(),
                &history,
                &tools,
            ) => outcome,
            _ = cancelled(&mut cancel) => {
                publish(
                    client,
                    conv,
                    "telemetry.turn.cancelled",
                    json!({
                        "ts": now_iso(),
                        "queryId": query, "turnId": turn_id,
                    }),
                )
                .await;
                publish(
                    client,
                    conv,
                    "changes.query",
                    json!({
                        "ts": now_iso(),
                        "queryId": query,
                        "reason": "cancelled",
                    }),
                )
                .await;
                return QueryEnd::Cancelled {
                    messages: committed,
                };
            }
        };

        let done = match outcome {
            Ok(done) => done,
            Err(e) => {
                eprintln!("bridge[{}]: turn aborted: {e:#}", conv.0);
                publish(
                    client,
                    conv,
                    "telemetry.turn.aborted",
                    json!({
                        "ts": now_iso(),
                        "queryId": query, "turnId": turn_id,
                    }),
                )
                .await;
                publish(
                    client,
                    conv,
                    "changes.query",
                    json!({
                        "ts": now_iso(),
                        "queryId": query,
                        "reason": "aborted",
                    }),
                )
                .await;
                return QueryEnd::Aborted {
                    messages: committed,
                };
            }
        };

        publish(
            client,
            conv,
            "telemetry.turn.ended",
            json!({
                "ts": now_iso(),
                "queryId": query, "turnId": turn_id,
                "stopReason": done.stop_reason,
            }),
        )
        .await;
        publish(
            client,
            conv,
            "telemetry.usage",
            json!({
                "ts": now_iso(),
                "queryId": query, "turnId": turn_id,
                "service": "anthropic.messages", "model": model,
                "inputTokens": done.input_tokens,
                "cacheCreationTokens": done.cache_creation_tokens,
                "cacheReadTokens": done.cache_read_tokens,
                "outputTokens": done.output_tokens,
            }),
        )
        .await;

        // Commit the assistant message: whatever the stop reason, this
        // content is the record.
        let message_id = uuid::Uuid::new_v4().to_string();
        publish_message(
            client,
            conv,
            &message_id,
            query,
            &turn_id,
            "assistant",
            &json!({ "kind": "agent" }),
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
            publish(
                client,
                conv,
                "changes.query",
                json!({
                    "ts": now_iso(),
                    "queryId": query,
                    "reason": "completed",
                }),
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
            publish(
                client,
                conv,
                "changes.query",
                json!({
                    "ts": now_iso(),
                    "queryId": query,
                    "reason": "cancelled",
                }),
            )
            .await;
            return QueryEnd::Cancelled {
                messages: committed,
            };
        }

        if round + 1 >= MAX_TURNS_PER_QUERY {
            eprintln!(
                "bridge[{}]: query {query} exceeded {MAX_TURNS_PER_QUERY} tool rounds; aborting",
                conv.0
            );
            publish(
                client,
                conv,
                "changes.query",
                json!({
                    "ts": now_iso(),
                    "queryId": query,
                    "reason": "aborted",
                }),
            )
            .await;
            return QueryEnd::Aborted {
                messages: committed,
            };
        }

        // Execute every tool_use block and commit the results as one
        // user-role message from the agent: the harness produced them.
        let mut results: Vec<Value> = Vec::new();
        for block in done.content.iter().filter(|b| b["type"] == "tool_use") {
            let id = block["id"].as_str().unwrap_or("");
            let name = block["name"].as_str().unwrap_or("");
            let (content, is_error) = match name {
                "Skill" => {
                    let skill = block["input"]["skill"].as_str().unwrap_or("");
                    match skills.invoke(skill) {
                        Ok(body) => (body, false),
                        Err(e) => (e, true),
                    }
                }
                other => (format!("unknown tool {other:?}"), true),
            };
            results.push(json!({
                "type": "tool_result",
                "tool_use_id": id,
                "content": content,
                "is_error": is_error,
            }));
        }

        let message_id = uuid::Uuid::new_v4().to_string();
        publish_message(
            client,
            conv,
            &message_id,
            query,
            &turn_id,
            "user",
            &json!({ "kind": "agent" }),
            &results,
        )
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
    unreachable!("the tool loop always returns")
}

/// `leaf` is the class-and-event path after the id (`changes.message`,
/// `telemetry.turn.started`): v2's one-place discriminator.
async fn publish(client: &async_nats::Client, conv: &ConversationId, leaf: &str, payload: Value) {
    let subject = format!("conv.v2.{}.{leaf}", conv.0);
    eprintln!("bridge[{}]: → {subject}", conv.0);
    let bytes = serde_json::to_vec(&payload).expect("json! of plain values cannot fail");
    if let Err(e) = client.publish(subject, bytes.into()).await {
        eprintln!("bridge[{}]: publish failed: {e}", conv.0);
    }
}

#[allow(clippy::too_many_arguments)]
async fn publish_message(
    client: &async_nats::Client,
    conv: &ConversationId,
    id: &str,
    query: &str,
    turn: &str,
    role: &str,
    from: &Value,
    content: &[Value],
) {
    publish(
        client,
        conv,
        "changes.message",
        json!({
            "ts": now_iso(),
            "id": id, "queryId": query, "turnId": turn,
            "role": role, "from": from, "content": content,
        }),
    )
    .await;
}
