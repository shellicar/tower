//! The bridge as approval holder (approval-spec): raise the ask, pulse it
//! while pending (~15s; raised + pulse = pending, pulse silence displays as
//! void), take the first valid answer off `.requests`, settle with the
//! answerer's provenance echoed verbatim.
//!
//! The waiting is the holder's own state; nothing is held open on the bus,
//! so an ask can pend for an hour at no cost. There is no timeout: the
//! pending ask is visible in tower and the query is cancellable; a cancel
//! abandons the ask (heartbeats stop, nobody settles it, watchers grey it
//! as void).

use futures::StreamExt;
use serde_json::Value;
use tokio::sync::watch;
use wire::{encode_heartbeat, encode_raised, encode_settled, now_iso, parse_answer};

const HEARTBEAT_SECS: u64 = 15;

/// How the gate resolved.
pub enum Verdict {
    Approved,
    /// Denied, by whom; reaches the conversation as content (the denied
    /// tool_result), the only way anything reaches a conversation.
    Denied {
        by: Value,
    },
    /// The query was cancelled while the ask pended; the ask is abandoned.
    Cancelled,
}

async fn publish(
    client: &async_nats::Client,
    attach: &Option<bridge::attach::AttachHandle>,
    approval_id: &str,
    leaf: &str,
    bytes: Vec<u8>,
) {
    let subject = format!("approval.v1.{approval_id}.{leaf}");
    eprintln!("{} bridge: → {subject} ({} B)", now_iso(), bytes.len());
    if let Err(e) = client.publish(subject.clone(), bytes.clone().into()).await {
        eprintln!("bridge: approval publish failed: {e}");
    }
    // The attach fd is the local TUI's complete direct feed — approvals are
    // the most interactive thing it exists to answer, so they mirror exactly
    // like conv events do. Addressed replies (msg.reply) are not broadcast
    // lifecycle and are never teed.
    bridge::attach::tee(attach, &subject, &bytes).await;
}

/// Raise the ask and wait for the human. First valid answer wins and is
/// settled; unintelligible requests are answered `rejected` (a holder must
/// answer everything addressed to it); the cancel signal abandons the ask.
pub async fn gate(
    client: &async_nats::Client,
    attach: &Option<bridge::attach::AttachHandle>,
    approval_id: &str,
    ask: &Value,
    correlation: &Value,
    cancel: &mut watch::Receiver<bool>,
) -> Verdict {
    // Subscribe before raising: an answer must never race the raise.
    let mut answers = match client
        .subscribe(format!("approval.v1.{approval_id}.requests"))
        .await
    {
        Ok(s) => s,
        Err(e) => {
            // A gate that cannot hear answers must not run the tool.
            eprintln!("bridge: approval subscribe failed: {e}");
            return Verdict::Denied {
                by: Value::String("unraisable: approval subscribe failed".into()),
            };
        }
    };

    publish(
        client,
        attach,
        approval_id,
        "lifecycle",
        encode_raised(ask, correlation, &now_iso()),
    )
    .await;

    let mut pulse = tokio::time::interval(std::time::Duration::from_secs(HEARTBEAT_SECS));
    pulse.tick().await; // the first tick is immediate; the raise just spoke

    loop {
        tokio::select! {
            _ = pulse.tick() => {
                publish(client, attach, approval_id, "telemetry", encode_heartbeat(&now_iso())).await;
            }
            _ = crate::agent::cancelled(cancel) => {
                return Verdict::Cancelled;
            }
            maybe = answers.next() => {
                let Some(msg) = maybe else {
                    // Subscription gone (client dropped): treat as abandoned.
                    return Verdict::Cancelled;
                };
                let Some((approved, from)) = parse_answer(&msg.payload) else {
                    if let Some(reply) = msg.reply {
                        let _ = client
                            .publish(reply, wire::encode_rejected("unsupported").into())
                            .await;
                    }
                    continue;
                };
                // First valid answer wins: accept, settle with the
                // answerer's provenance, and the gate is decided.
                if let Some(reply) = msg.reply {
                    let _ = client
                        .publish(reply, wire::encode_accepted(None).into())
                        .await;
                }
                publish(
                    client,
                    attach,
                    approval_id,
                    "lifecycle",
                    encode_settled(approved, &from, &now_iso()),
                )
                .await;
                return if approved {
                    Verdict::Approved
                } else {
                    Verdict::Denied { by: from }
                };
            }
        }
    }
}
