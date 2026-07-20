//! helm: the standalone terminal client. Spawns its own bridge (or dials one
//! given by path), sends the one spawn control line, then prints whatever
//! arrives on the attach fd. No document model, no rendering yet — this is
//! the transport proven from helm's own crate, the seam the rest builds on.

mod transport;

use transport::Session;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bridge_path = std::env::var("HELM_BRIDGE_PATH").unwrap_or_else(|_| "bridge".into());
    eprintln!("helm: spawning {bridge_path}");
    let mut session = Session::spawn(&bridge_path)?;

    let conv = session.spawn_conversation().await?;
    println!("helm: conversation {}", conv.0);

    while let Some(event) = session.next_event().await? {
        println!("helm: <- {} {}", event.subject, event.payload);
    }
    println!("helm: attach fd closed, exiting");
    Ok(())
}
