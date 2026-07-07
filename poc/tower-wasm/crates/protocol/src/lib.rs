//! Wire shapes for the agent-over-NATS POC, mirroring `spec.md` exactly,
//! plus the pure event-folding logic the dashboard renders from.
//!
//! Shared between the backend (native) and the frontend (WASM) — the whole
//! point of the all-Rust shape.

pub mod fold;

use serde::{Deserialize, Serialize};

/// Who sent a `user_input`; echoed on `turn_started` so every subscriber
/// sees both sides of the conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sender {
    pub kind: SenderKind,
}

/// The sender kinds the POC recognises.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SenderKind {
    Human,
    Orchestrator,
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    Error,
}

/// An event published by an agent on `agent.{id}.events`.
///
/// Deliberately has no catch-all variant: an unknown `type` fails to parse,
/// and the folding layer falls back to a generic representation so the event
/// is shown, not dropped (the spec's forward-compatibility rule).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentReady {
        #[serde(rename = "agentId")]
        agent_id: String,
    },
    TurnStarted {
        #[serde(rename = "turnId")]
        turn_id: String,
        text: String,
        from: Sender,
    },
    TextDelta {
        #[serde(rename = "turnId")]
        turn_id: String,
        text: String,
    },
    TurnEnded {
        #[serde(rename = "turnId")]
        turn_id: String,
        #[serde(rename = "stopReason")]
        stop_reason: StopReason,
    },
    Error {
        /// Present when a running turn failed mid-flight, absent when an
        /// input was rejected — which distinguishes the two.
        #[serde(rename = "turnId", default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        message: String,
    },
}

/// What the backend forwards over its WebSocket: the raw agent event,
/// tagged with the agent it came from.
///
/// The event stays a [`serde_json::Value`] so unknown event types survive
/// the relay intact instead of being lost at the backend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub event: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_events_round_trip() {
        let samples = [
            r#"{ "type": "agent_ready", "agentId": "agent-4f2a" }"#,
            r#"{ "type": "turn_started", "turnId": "t-1", "text": "What's 2+2?", "from": { "kind": "human" } }"#,
            r#"{ "type": "text_delta", "turnId": "t-1", "text": "hello" }"#,
            r#"{ "type": "turn_ended", "turnId": "t-1", "stopReason": "end_turn" }"#,
            r#"{ "type": "error", "message": "turn already in progress" }"#,
            r#"{ "type": "error", "turnId": "t-1", "message": "model call failed" }"#,
        ];
        for sample in samples {
            let event: AgentEvent = serde_json::from_str(sample).unwrap();
            let json = serde_json::to_value(&event).unwrap();
            let original: serde_json::Value = serde_json::from_str(sample).unwrap();
            assert_eq!(json, original, "round-trip differs for {sample}");
        }
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let event: AgentEvent = serde_json::from_str(
            r#"{ "type": "text_delta", "turnId": "t-1", "text": "hi", "extra": 42 }"#,
        )
        .unwrap();
        assert!(matches!(event, AgentEvent::TextDelta { .. }));
    }

    #[test]
    fn unknown_type_fails_to_parse() {
        let result: Result<AgentEvent, _> =
            serde_json::from_str(r#"{ "type": "telemetry", "cpu": 0.5 }"#);
        assert!(result.is_err());
    }
}
