//! One conversation: the servicer discipline on `.requests.>`, the v2 event
//! subjects produced per the conversation spec (the leaf spells the type;
//! bodies carry none), an in-memory tree with a tip. The turn runs as its
//! own task so `cancel` can abort it honestly.

use serde_json::{Value, json};
use tokio::sync::mpsc;

use futures::StreamExt;
use wire::{ConvRequest, ConversationId, encode_accepted, encode_rejected, now_iso, parse_request};

use std::sync::Arc;

use crate::anthropic;
use crate::skills::Skills;

/// Tool rounds per query before the bridge gives up — a runaway tool loop
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

/// A committed message: id + the API-shaped halves the model call needs.
struct Message {
    id: String,
    role: String,
    content: Vec<Value>,
}

struct Live {
    query: String,
    abort: tokio::task::AbortHandle,
}

/// What a finished query task reports back for the tree. Both ends carry
/// every message the query committed (assistant turns AND tool results) —
/// they are on the wire, so the tree must hold them whatever else happened.
enum TurnEnd {
    Completed { messages: Vec<Message> },
    Aborted { messages: Vec<Message> },
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

    let mut tree: Vec<Message> = Vec::new();
    let mut live: Option<Live> = None;
    // None until the first message scans the catalogue.
    let mut skills: Option<Arc<Skills>> = None;
    let (done_tx, mut done_rx) = mpsc::channel::<(String, TurnEnd)>(8);

    loop {
        tokio::select! {
            // A turn finished: fold its outcome into the tree.
            Some((query, end)) = done_rx.recv() => {
                fold_turn_end(&mut tree, &mut live, query, end);
            }
            maybe = requests.next() => {
                let Some(msg) = maybe else { break };
                let Some(reply_to) = msg.reply.clone() else { continue };
                // v2: the leaf spells the operation — read it off the subject.
                let leaf = msg.subject.strip_prefix(prefix.as_str()).unwrap_or("");
                let response = match parse_request(leaf, &msg.payload) {
                    ConvRequest::Say { text, tip, from } => {
                        // The premise check: the sender's tip must be the tree's,
                        // and no query may be live against it (scenario 5: a live
                        // acceptance makes the same premise stale).
                        let current = tree.last().map(|m| m.id.as_str());
                        if tip.as_ref().map(|t| t.0.as_str()) != current || live.is_some() {
                            encode_rejected("stale")
                        } else {
                            let query = uuid::Uuid::new_v4().to_string();
                            let turn = uuid::Uuid::new_v4().to_string();
                            let message_id = uuid::Uuid::new_v4().to_string();
                            // The first message takes the catalogue snapshot
                            // and carries the reminder as its FIRST block,
                            // the said text second — in the committed record,
                            // so what the model saw is what is stored.
                            let skills = Arc::clone(skills.get_or_insert_with(|| {
                                Arc::new(Skills::scan(config.skills_root.clone()))
                            }));
                            let mut content = Vec::new();
                            if tree.is_empty()
                                && let Some(reminder) = skills.reminder()
                            {
                                content.push(json!({ "type": "text", "text": reminder }));
                            }
                            content.push(json!({ "type": "text", "text": text }));

                            // Commit the user half first — half a chat is not a chat.
                            publish_message(&client, &config.conv, &message_id, &query, &turn,
                                            "user", &from, &content).await;
                            tree.push(Message { id: message_id, role: "user".into(), content });

                            // The query, abortable.
                            let history: Vec<Value> = tree.iter()
                                .map(|m| json!({ "role": m.role, "content": m.content }))
                                .collect();
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
                            let done = done_tx.clone();
                            let q = query.clone();
                            let handle = tokio::spawn(async move {
                                let end = run_query(ctx, history).await;
                                let _ = done.send((q, end)).await;
                            });
                            live = Some(Live { query: query.clone(), abort: handle.abort_handle() });
                            encode_accepted(Some(&query))
                        }
                    }
                    ConvRequest::Cancel { query, .. } => {
                        // A turn's publishes land on the wire before its
                        // completion reaches this loop — fold anything
                        // buffered first, so a turn that finished a beat ago
                        // reads as complete, never as cancellable. Between
                        // the drain and the finished check, the answer for a
                        // done turn is `already_complete` (the spec's word),
                        // and no turn_cancelled contradicts the turn_ended
                        // already published.
                        while let Ok((q, end)) = done_rx.try_recv() {
                            fold_turn_end(&mut tree, &mut live, q, end);
                        }
                        match &live {
                            Some(l) if l.query == query.0 && l.abort.is_finished() => {
                                encode_rejected("already_complete")
                            }
                            Some(l) if l.query == query.0 => {
                                // KNOWN RACE (v0-acceptable, not fixed here): if
                                // run_turn has already published its committed
                                // message but its done.send has not yet reached
                                // the drain above, the task still reads as live
                                // and is aborted. Two harms follow — a
                                // turn_cancelled for a turn whose message is
                                // already on the wire, and the abort kills the
                                // task before done.send, so fold_turn_end never
                                // runs and this bridge's tree loses a message the
                                // wire has (the desync fold_turn_end swears off).
                                // The real fix is cooperative cancellation: no
                                // hard abort; run_turn always completes done.send.
                                l.abort.abort();
                                publish(&client, &config.conv, "telemetry.turn.cancelled", json!({
                                    "ts": now_iso(),
                                    "queryId": l.query,
                                    // The turn id lives in the aborted task; the
                                    // cancelled marker carries the query's identity.
                                    "turnId": l.query,
                                })).await;
                                // The committal closure: the query ended, reason
                                // cancelled (conversation-spec, changes.query).
                                publish(&client, &config.conv, "changes.query", json!({
                                    "ts": now_iso(),
                                    "queryId": l.query,
                                    "reason": "cancelled",
                                })).await;
                                live = None;
                                encode_accepted(None)
                            }
                            _ => encode_rejected("not_found"),
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

/// Fold one finished query into the loop's state. The tree-push is
/// unconditional on purpose: every carried message is already on the wire —
/// every consumer has it — so the tree must carry it too, whatever raced it;
/// dropping one would desync the tip from the world forever.
fn fold_turn_end(tree: &mut Vec<Message>, live: &mut Option<Live>, query: String, end: TurnEnd) {
    if live.as_ref().is_some_and(|l| l.query == query) {
        *live = None;
    }
    let (TurnEnd::Completed { messages } | TurnEnd::Aborted { messages }) = end;
    tree.extend(messages);
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

/// One query: turns until the model stops asking for tools. A `tool_use`
/// stop commits the assistant message, executes the tools, commits the
/// results as a user-role message (from the agent — the harness produced
/// them), and runs the next turn; the query closes committally on the turn
/// that ends any other way. Failure is `turn_aborted` + `changes.query`
/// aborted — honesty over silence.
async fn run_query(ctx: TurnContext, mut history: Vec<Value>) -> TurnEnd {
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

        let outcome = anthropic::stream_turn(
            client,
            conv,
            auth,
            model,
            system.as_deref(),
            &history,
            &tools,
        )
        .await;

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
                return TurnEnd::Aborted {
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

        // Commit the assistant message — whatever the stop reason, this
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
            return TurnEnd::Completed {
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
            return TurnEnd::Aborted {
                messages: committed,
            };
        }

        // Execute every tool_use block and commit the results as one
        // user-role message from the agent — the harness produced them.
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

/// `leaf` is the class-and-event path after the id — `changes.message`,
/// `telemetry.turn.started` — v2's one-place discriminator.
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

// Cancelled queries never reach fold_turn_end: the abort kills the task
// before its done.send, and the cancel arm publishes turn_cancelled and the
// query closure directly — which is also why TurnEnd has no Cancelled
// variant to carry.
