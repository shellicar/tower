//! SCRATCH HARNESS: connects to the backend WebSocket, collects envelopes
//! for a few seconds, and fails unless both stub agents' events arrived,
//! tagged with their ids.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::Context as _;
use futures::StreamExt as _;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "ws://localhost:8093/ws".to_owned());
    let (mut socket, _) = tokio_tungstenite::connect_async(&url)
        .await
        .with_context(|| format!("connect {url}"))?;

    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let message = tokio::select! {
            m = socket.next() => match m { Some(m) => m?, None => break },
            _ = tokio::time::sleep_until(deadline) => break,
        };
        if let tokio_tungstenite::tungstenite::Message::Text(text) = message {
            let envelope: serde_json::Value = serde_json::from_str(&text)?;
            let agent_id = envelope
                .get("agentId")
                .and_then(|id| id.as_str())
                .context("envelope missing agentId")?;
            *counts.entry(agent_id.to_owned()).or_default() += 1;
        }
    }

    println!("envelopes per agent: {counts:?}");
    anyhow::ensure!(
        counts.get("stub-a").copied().unwrap_or(0) > 5
            && counts.get("stub-b").copied().unwrap_or(0) > 5,
        "did not receive both stub agents' event streams"
    );
    println!("PASS: both agents' events relayed with ids");
    Ok(())
}
