//! HARNESS — throwaway stub, not the deliverable. Plays the agent side of the spec
//! just well enough to prove the TUI's wire round trip: announces, then for each
//! `user_input` emits turn_started / spaced text_deltas / turn_ended.

use std::time::Duration;

use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let agent_id = args.next().unwrap_or_else(|| "stub-1".to_string());
    let nats_url = args
        .next()
        .unwrap_or_else(|| "nats://localhost:4224".to_string());

    let client = async_nats::connect(&nats_url).await?;
    let events_subject = format!("agent.{agent_id}.events");
    let ready = format!(r#"{{"type":"agent_ready","agentId":"{agent_id}"}}"#);
    client
        .publish("agent.announce".to_string(), ready.clone().into())
        .await?;
    client.publish(events_subject.clone(), ready.into()).await?;
    client.flush().await?;

    let mut inputs = client
        .subscribe(format!("agent.{agent_id}.messages"))
        .await?;
    eprintln!("stub agent {agent_id} ready on {nats_url}");

    let mut turn = 0u32;
    // Backstop: the stub kills itself so nothing is left running.
    let deadline = tokio::time::sleep(Duration::from_secs(110));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => return Ok(()),
            message = inputs.next() => {
                let Some(message) = message else { return Ok(()) };
                let value: serde_json::Value = match serde_json::from_slice(&message.payload) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if value.get("type").and_then(|t| t.as_str()) != Some("user_input") {
                    continue;
                }
                let text = value.get("text").and_then(|t| t.as_str()).unwrap_or("");
                turn += 1;
                let turn_id = format!("t-{turn}");

                let started = serde_json::json!({
                    "type": "turn_started", "turnId": turn_id, "text": text,
                    "from": value.get("from").cloned().unwrap_or(serde_json::json!({"kind":"human"})),
                });
                client.publish(events_subject.clone(), started.to_string().into()).await?;

                let reply = format!("You said: {text} — noted.");
                for word in reply.split_inclusive(' ') {
                    let delta = serde_json::json!({
                        "type": "text_delta", "turnId": turn_id, "text": word,
                    });
                    client.publish(events_subject.clone(), delta.to_string().into()).await?;
                    client.flush().await?;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }

                let ended = serde_json::json!({
                    "type": "turn_ended", "turnId": turn_id, "stopReason": "end_turn",
                });
                client.publish(events_subject.clone(), ended.to_string().into()).await?;
                client.flush().await?;
            }
        }
    }
}
