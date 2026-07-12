//! One conversation: the servicer discipline on `.requests`, the event
//! subjects produced per the conversation spec, an in-memory tree with a tip.
//! The turn runs as its own task so `cancel` can abort it honestly.

use serde_json::{Value, json};
use tokio::sync::mpsc;

use futures::StreamExt;
use wire::{ConvRequest, ConversationId, encode_accepted, encode_rejected, now_iso, parse_request};

use crate::anthropic;

pub struct AgentConfig {
    pub conv: ConversationId,
    pub model: String,
    pub system: Option<String>,
    pub auth: crate::anthropic::Auth,
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

/// What a finished turn task reports back for the tree.
enum TurnEnd {
    /// Committed content for the assistant message (already published).
    Completed {
        message_id: String,
        content: Vec<Value>,
    },
    Cancelled,
    Aborted,
}

pub async fn run(client: async_nats::Client, config: AgentConfig) {
    let subject = format!("conv.v1.{}.requests", config.conv.0);
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
                let response = match parse_request(&msg.payload) {
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
                            let content = vec![json!({ "type": "text", "text": text })];

                            // Commit the user half first — half a chat is not a chat.
                            publish_message(&client, &config.conv, &message_id, &query, &turn,
                                            "user", &from, &content).await;
                            tree.push(Message { id: message_id, role: "user".into(), content });

                            // The turn, abortable.
                            let history: Vec<Value> = tree.iter()
                                .map(|m| json!({ "role": m.role, "content": m.content }))
                                .collect();
                            let ctx = TurnContext {
                                client: client.clone(),
                                conv: config.conv.clone(),
                                model: config.model.clone(),
                                system: config.system.clone(),
                                auth: config.auth.clone(),
                                query: query.clone(),
                                turn,
                            };
                            let done = done_tx.clone();
                            let q = query.clone();
                            let handle = tokio::spawn(async move {
                                let end = run_turn(ctx, history).await;
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
                                l.abort.abort();
                                publish(&client, &config.conv, "telemetry", json!({
                                    "type": "turn_cancelled", "ts": now_iso(),
                                    "queryId": l.query,
                                    // The turn id lives in the aborted task; the
                                    // cancelled marker carries the query's identity.
                                    "turnId": l.query,
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

/// Fold one finished turn into the loop's state. The tree-push is
/// unconditional on purpose: a completed turn's message is already on the
/// wire — every consumer has it — so the tree must carry it too, whatever
/// raced it; dropping it would desync the tip from the world forever.
fn fold_turn_end(tree: &mut Vec<Message>, live: &mut Option<Live>, query: String, end: TurnEnd) {
    if live.as_ref().is_some_and(|l| l.query == query) {
        *live = None;
    }
    if let TurnEnd::Completed {
        message_id,
        content,
    } = end
    {
        tree.push(Message {
            id: message_id,
            role: "assistant".into(),
            content,
        });
    }
}

struct TurnContext {
    client: async_nats::Client,
    conv: ConversationId,
    model: String,
    system: Option<String>,
    auth: crate::anthropic::Auth,
    query: String,
    turn: String,
}

/// One model round: telemetry, the block/delta stream, the commit. Failure is
/// `turn_aborted` on telemetry — honesty over silence.
async fn run_turn(ctx: TurnContext, history: Vec<Value>) -> TurnEnd {
    let TurnContext {
        client,
        conv,
        model,
        system,
        auth,
        query,
        turn,
    } = &ctx;

    publish(
        client,
        conv,
        "telemetry",
        json!({
            "type": "turn_started", "ts": now_iso(),
            "queryId": query, "turnId": turn,
            "service": "anthropic.messages", "model": model,
            "thinking": false, "maxTokens": anthropic::MAX_TOKENS,
        }),
    )
    .await;

    let outcome =
        anthropic::stream_turn(client, conv, auth, model, system.as_deref(), &history).await;

    match outcome {
        Ok(done) => {
            publish(
                client,
                conv,
                "telemetry",
                json!({
                    "type": "turn_ended", "ts": now_iso(),
                    "queryId": query, "turnId": turn,
                    "stopReason": done.stop_reason,
                }),
            )
            .await;
            publish(
                client,
                conv,
                "telemetry",
                json!({
                    "type": "usage", "ts": now_iso(),
                    "queryId": query, "turnId": turn,
                    "service": "anthropic.messages", "model": model,
                    "inputTokens": done.input_tokens,
                    "cacheCreationTokens": done.cache_creation_tokens,
                    "cacheReadTokens": done.cache_read_tokens,
                    "outputTokens": done.output_tokens,
                }),
            )
            .await;

            let message_id = uuid::Uuid::new_v4().to_string();
            publish_message(
                client,
                conv,
                &message_id,
                query,
                turn,
                "assistant",
                &json!({ "kind": "agent" }),
                &done.content,
            )
            .await;
            TurnEnd::Completed {
                message_id,
                content: done.content,
            }
        }
        Err(e) => {
            eprintln!("bridge[{}]: turn aborted: {e:#}", conv.0);
            publish(
                client,
                conv,
                "telemetry",
                json!({
                    "type": "turn_aborted", "ts": now_iso(),
                    "queryId": query, "turnId": turn,
                }),
            )
            .await;
            TurnEnd::Aborted
        }
    }
}

async fn publish(client: &async_nats::Client, conv: &ConversationId, kind: &str, payload: Value) {
    let subject = format!("conv.v1.{}.{kind}", conv.0);
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
        "changes",
        json!({
            "type": "message", "ts": now_iso(),
            "id": id, "queryId": query, "turnId": turn,
            "role": role, "from": from, "content": content,
        }),
    )
    .await;
}

// Cancelled turns land here via task abort — the variant exists for the
// fold's completeness; the abort path publishes turn_cancelled directly.
#[allow(dead_code)]
fn _cancelled() -> TurnEnd {
    TurnEnd::Cancelled
}
