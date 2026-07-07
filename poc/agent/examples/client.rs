//! SCRATCH HARNESS — not part of the deliverable.
//!
//! Plays the client side over NATS: subscribes to an agent's events subject,
//! publishes `user_input`, and prints every event payload as it arrives.
//!
//! Usage:
//!   client <agent-id> <text> [--double]   run a turn; --double sends a second
//!                                         input 150ms in, to show the rejection
//!   client <agent-id> --history           request/reply on agent.{id}.history
//!   client --watch-announce <seconds>     print agent.announce traffic
//!                                         (heartbeats) for that long

use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let nats = async_nats::connect("nats://localhost:4223")
        .await
        .context("connecting to NATS on 4223")?;

    match args.as_slice() {
        [flag, secs] if flag == "--watch-announce" => watch_announce(nats, secs.parse()?).await,
        [id, flag] if flag == "--history" => history(nats, id).await,
        [id, text] => turn(nats, id, text, false).await,
        [id, text, flag] if flag == "--double" => turn(nats, id, text, true).await,
        _ => bail!(
            "usage: client <id> <text> [--double] | client <id> --history | client --watch-announce <seconds>"
        ),
    }
}

async fn watch_announce(nats: async_nats::Client, seconds: u64) -> Result<()> {
    let mut announces = nats.subscribe("agent.announce").await?;
    let deadline = tokio::time::sleep(Duration::from_secs(seconds));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            Some(msg) = announces.next() => {
                println!("{}", String::from_utf8_lossy(&msg.payload));
            }
            _ = &mut deadline => return Ok(()),
        }
    }
}

async fn history(nats: async_nats::Client, id: &str) -> Result<()> {
    let reply = tokio::time::timeout(
        Duration::from_secs(5),
        nats.request(format!("agent.{id}.history"), "".into()),
    )
    .await
    .context("history request timed out")??;
    println!("{}", String::from_utf8_lossy(&reply.payload));
    Ok(())
}

async fn turn(nats: async_nats::Client, id: &str, text: &str, double: bool) -> Result<()> {
    let mut events = nats.subscribe(format!("agent.{id}.events")).await?;

    let input = serde_json::json!({
        "type": "user_input",
        "from": { "kind": "human" },
        "text": text
    })
    .to_string();
    nats.publish(format!("agent.{id}.messages"), input.clone().into())
        .await?;
    if double {
        tokio::time::sleep(Duration::from_millis(150)).await;
        nats.publish(format!("agent.{id}.messages"), input.into())
            .await?;
    }
    nats.flush().await?;

    // Print events until the turn ends (plus a short grace for stragglers such
    // as the --double rejection), bounded by a hard overall timeout.
    let deadline = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(deadline);
    let mut ended = false;
    loop {
        tokio::select! {
            Some(msg) = events.next() => {
                let payload = String::from_utf8_lossy(&msg.payload);
                println!("{payload}");
                if payload.contains("\"turn_ended\"") {
                    ended = true;
                    // Grace period: catch any event still in flight.
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    while let Ok(Some(msg)) =
                        tokio::time::timeout(Duration::from_millis(100), events.next()).await
                    {
                        println!("{}", String::from_utf8_lossy(&msg.payload));
                    }
                    break;
                }
            }
            _ = &mut deadline => break,
        }
    }
    if !ended {
        bail!("timed out without seeing turn_ended");
    }
    Ok(())
}
