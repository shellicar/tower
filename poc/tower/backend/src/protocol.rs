//! Wire shapes from the POC spec.
//!
//! Tower only *reads* events, and the spec requires unknown `type` values to be
//! skipped and unknown fields ignored. Deserialisation therefore keeps the raw
//! JSON alongside the parsed shape: parsing is for discovery logic (which needs
//! `agent_ready` and agent ids), while forwarding to the frontend sends the raw
//! event untouched so nothing is dropped on the floor.

use serde::Deserialize;

/// Who initiated a turn.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct From {
    pub kind: String,
}

/// An event published by an agent on `agent.{id}.events` or `agent.announce`.
///
/// `#[serde(other)]` on `Unknown` implements the spec's forward-compatibility
/// rule: an unrecognised `type` parses as `Unknown` rather than erroring.
#[derive(Debug, Clone, Deserialize)]
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
        from: From,
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
        stop_reason: String,
    },
    Error {
        #[serde(rename = "turnId")]
        turn_id: Option<String>,
        message: String,
    },
    #[serde(other)]
    Unknown,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_ready() {
        let e: AgentEvent =
            serde_json::from_str(r#"{ "type": "agent_ready", "agentId": "agent-4f2a" }"#).unwrap();
        match e {
            AgentEvent::AgentReady { agent_id } => assert_eq!(agent_id, "agent-4f2a"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn parses_turn_started_with_from() {
        let e: AgentEvent = serde_json::from_str(
            r#"{ "type": "turn_started", "turnId": "t-1", "text": "hi", "from": { "kind": "human" } }"#,
        )
        .unwrap();
        match e {
            AgentEvent::TurnStarted {
                turn_id,
                text,
                from,
            } => {
                assert_eq!(turn_id, "t-1");
                assert_eq!(text, "hi");
                assert_eq!(from.kind, "human");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn error_turn_id_is_optional() {
        let e: AgentEvent =
            serde_json::from_str(r#"{ "type": "error", "message": "turn already in progress" }"#)
                .unwrap();
        match e {
            AgentEvent::Error { turn_id, message } => {
                assert!(turn_id.is_none());
                assert_eq!(message, "turn already in progress");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn unknown_type_is_skipped_not_error() {
        let e: AgentEvent =
            serde_json::from_str(r#"{ "type": "warp_drive", "flux": 42 }"#).unwrap();
        assert!(matches!(e, AgentEvent::Unknown));
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let e: AgentEvent = serde_json::from_str(
            r#"{ "type": "agent_ready", "agentId": "a-1", "extra": "ignored" }"#,
        )
        .unwrap();
        assert!(matches!(e, AgentEvent::AgentReady { .. }));
    }
}
