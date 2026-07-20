//! helm: the standalone terminal client. Spawns its own bridge (or dials one
//! given by path), sends the one spawn control line, then folds whatever
//! arrives on the attach fd into the conversation document model. No
//! layout/compose/present/platform yet (tui-architecture.md's render side) —
//! this is transport + document model proven together, the seam the rest
//! builds on.

mod conversation;
mod transport;
mod usage;

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

    let mut conv = Conversation::default();
    let mut usage = Usage::default();
    while let Some(event) = session.next_event().await? {
        let Some(wire::WireEvent::Conv(decoded)) = wire::parse_wire(&event.subject, &event.payload)
        else {
            continue; // not conv.v2 traffic, or a frame this build doesn't model
        };
        conv.fold(&decoded.kind);
        usage.fold(&decoded.kind);
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
