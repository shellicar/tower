//! SCRATCH HARNESS: plays two agents per the spec — announce, then a few
//! turns of turn_started / spaced text_deltas / turn_ended. Exits on its own.

use std::time::Duration;

use serde_json::json;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let nats_url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "nats://localhost:4226".to_owned());
    let client = async_nats::connect(&nats_url).await?;

    let a = tokio::spawn(run_agent(client.clone(), "stub-a"));
    let b = tokio::spawn(run_agent(client.clone(), "stub-b"));
    a.await??;
    b.await??;
    client.flush().await?;
    Ok(())
}

async fn run_agent(client: async_nats::Client, id: &'static str) -> anyhow::Result<()> {
    let events_subject = format!("agent.{id}.events");
    let ready = json!({ "type": "agent_ready", "agentId": id }).to_string();
    client
        .publish("agent.announce", ready.clone().into())
        .await?;
    client.publish(events_subject.clone(), ready.into()).await?;

    for turn in 0..2 {
        let turn_id = format!("t-{turn}");
        publish(
            &client,
            &events_subject,
            json!({ "type": "turn_started", "turnId": turn_id, "text": format!("Question {turn} for {id}?"), "from": { "kind": "human" } }),
        )
        .await?;
        for word in ["Reply ", "from ", id, " to ", "turn ", &turn.to_string()] {
            publish(
                &client,
                &events_subject,
                json!({ "type": "text_delta", "turnId": turn_id, "text": word }),
            )
            .await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        publish(
            &client,
            &events_subject,
            json!({ "type": "turn_ended", "turnId": turn_id, "stopReason": "end_turn" }),
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(())
}

async fn publish(
    client: &async_nats::Client,
    subject: &str,
    event: serde_json::Value,
) -> anyhow::Result<()> {
    client
        .publish(subject.to_owned(), event.to_string().into())
        .await?;
    Ok(())
}
