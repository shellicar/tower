//! helm: the standalone terminal client. Spawns its own bridge (or dials one
//! given by path), sends the one spawn control line, then folds whatever
//! arrives on the attach fd into the conversation document model. No
//! layout/compose/present/platform yet (tui-architecture.md's render side) —
//! this is transport + document model proven together, the seam the rest
//! builds on.

mod conversation;
mod transport;

use conversation::Conversation;
use transport::Session;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bridge_path = std::env::var("HELM_BRIDGE_PATH").unwrap_or_else(|_| "bridge".into());
    eprintln!("helm: spawning {bridge_path}");
    let mut session = Session::spawn(&bridge_path)?;

    let conv_id = session.spawn_conversation().await?;
    println!("helm: conversation {}", conv_id.0);

    let mut conv = Conversation::default();
    while let Some(event) = session.next_event().await? {
        let Some(wire::WireEvent::Conv(decoded)) = wire::parse_wire(&event.subject, &event.payload)
        else {
            continue; // not conv.v2 traffic, or a frame this build doesn't model
        };
        conv.fold(&decoded.kind);
        println!(
            "helm: {} messages, query {:?}, streaming {:?}",
            conv.messages.len(),
            conv.query_state,
            conv.streaming
        );
    }
    println!("helm: attach fd closed, exiting");
    Ok(())
}
