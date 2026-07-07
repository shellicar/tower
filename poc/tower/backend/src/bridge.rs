//! NATS → broadcast bridge.
//!
//! Subscribes to `agent.announce` and `agent.*.events`, tags every event with
//! the agent id it came from, and fans it out on a tokio broadcast channel that
//! each WebSocket connection subscribes to. Discovery is a side effect of
//! tagging: the frontend treats any event from a new id as discovery, so the
//! backend does not need to keep an agent registry — it forwards, tagged.

use anyhow::Result;
use futures::StreamExt;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::protocol::AgentEvent;

/// What goes over the WebSocket: the agent id plus the raw event untouched.
///
/// The raw JSON is forwarded (not a re-serialisation of the parsed enum) so
/// unknown event types and unknown fields reach the frontend intact.
#[derive(Debug, Clone, Serialize)]
pub struct TaggedEvent {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub event: serde_json::Value,
}

/// Extract the agent id for an incoming NATS message.
///
/// On `agent.{id}.events` the id is in the subject. On `agent.announce` the
/// only source is the event body (`agent_ready.agentId`).
pub fn agent_id_for(subject: &str, event: &AgentEvent) -> Option<String> {
    let parts: Vec<&str> = subject.split('.').collect();
    match parts.as_slice() {
        ["agent", id, "events"] => Some((*id).to_string()),
        ["agent", "announce"] => match event {
            AgentEvent::AgentReady { agent_id } => Some(agent_id.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// Run the bridge until the NATS connection ends. Lagging or absent WebSocket
/// subscribers must not stall NATS consumption, which is what broadcast gives us.
pub async fn run(client: async_nats::Client, tx: broadcast::Sender<TaggedEvent>) -> Result<()> {
    let announce = client.subscribe("agent.announce").await?;
    let events = client.subscribe("agent.*.events").await?;
    let mut merged = futures::stream::select(announce, events);

    while let Some(msg) = merged.next().await {
        let Ok(event) = serde_json::from_slice::<AgentEvent>(&msg.payload) else {
            // Not JSON in the spec's shape at all: skip, per forward compatibility.
            continue;
        };
        let Some(agent_id) = agent_id_for(msg.subject.as_str(), &event) else {
            continue;
        };
        let Ok(raw) = serde_json::from_slice::<serde_json::Value>(&msg.payload) else {
            continue;
        };
        // Send fails only when there are no subscribers; that is fine.
        let _ = tx.send(TaggedEvent {
            agent_id,
            event: raw,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(id: &str) -> AgentEvent {
        AgentEvent::AgentReady {
            agent_id: id.to_string(),
        }
    }

    #[test]
    fn id_from_events_subject() {
        let e = AgentEvent::Unknown;
        assert_eq!(
            agent_id_for("agent.a-1.events", &e),
            Some("a-1".to_string())
        );
    }

    #[test]
    fn id_from_announce_body() {
        assert_eq!(
            agent_id_for("agent.announce", &ready("agent-4f2a")),
            Some("agent-4f2a".to_string())
        );
    }

    #[test]
    fn announce_without_ready_has_no_id() {
        assert_eq!(agent_id_for("agent.announce", &AgentEvent::Unknown), None);
    }

    #[test]
    fn unrelated_subject_has_no_id() {
        assert_eq!(agent_id_for("other.subject", &ready("a-1")), None);
    }
}
