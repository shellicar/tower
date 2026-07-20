//! helm: the standalone terminal client. Spawns its own bridge (or dials one
//! given by path), sends the one spawn control line, then folds whatever
//! arrives on the attach fd into the conversation document model. No
//! layout/compose/present/platform yet (tui-architecture.md's render side) —
//! this is transport + document model proven together, the seam the rest
//! builds on.

mod approvals;
mod conversation;
mod transport;
mod usage;

use approvals::Approvals;
use conversation::Conversation;
use transport::Session;
use usage::Usage;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bridge_path = std::env::var("HELM_BRIDGE_PATH").unwrap_or_else(|_| "bridge".into());
    let nats_url = std::env::var("NATS_URL").ok();
    eprintln!("helm: spawning {bridge_path}");
    let mut session = Session::spawn(&bridge_path, nats_url.as_deref()).await?;

    let conv_id = session.spawn_conversation().await?;
    println!("helm: conversation {}", conv_id.0);

    // Not interactivity yet (no editor concern, no stdin loop) — an optional
    // one-shot say, proving Session::say from real use before either exists.
    if let Some(text) = std::env::args().nth(1) {
        let outcome = session.say(&conv_id, &text).await?;
        println!("helm: say outcome {outcome:?}");
    }

    let auto_approve = std::env::var("HELM_AUTO_APPROVE").is_ok_and(|v| v == "1");
    let mut conv = Conversation::default();
    let mut usage = Usage::default();
    let mut approvals = Approvals::default();
    while let Some(event) = session.next_event().await? {
        match wire::parse_wire(&event.subject, &event.payload) {
            Some(wire::WireEvent::Conv(decoded)) => {
                conv.fold(&decoded.kind);
                usage.fold(&decoded.kind);
            }
            Some(wire::WireEvent::Approval(decoded)) => {
                approvals.fold(&decoded.id.0, &decoded.kind);
                // No editor yet, so nothing interactive can answer — surface
                // the live asks loudly instead of leaving the agent silently
                // blocked, and HELM_AUTO_APPROVE=1 answers them (the
                // non-interactive proof of the whole answer loop).
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let live: Vec<(String, serde_json::Value)> = approvals
                    .live(now_ms)
                    .into_iter()
                    .map(|(id, ask)| (id.to_string(), ask.ask.clone()))
                    .collect();
                for (id, ask) in live {
                    println!("helm: PENDING APPROVAL {id}: {ask}");
                    if auto_approve {
                        let outcome = session.answer(&id, true).await?;
                        println!("helm: auto-approved {id}: {outcome:?}");
                    }
                }
                continue;
            }
            _ => continue, // not traffic this build models
        }
        println!(
            "helm: {} messages, query {:?}, streaming {:?}, {} in / {} out{}",
            conv.messages.len(),
            conv.query_state,
            conv.streaming,
            usage.input_tokens + usage.cache_creation_tokens + usage.cache_read_tokens,
            usage.output_tokens,
            usage
                .cost_usd
                .map(|c| format!(", ${c:.4}"))
                .unwrap_or_default(),
        );
    }
    println!("helm: attach fd closed, exiting");
    Ok(())
}
