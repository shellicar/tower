//! Wire shapes from the spec, mirrored exactly. JSON over NATS, one object per
//! message. Unknown `type` values are skipped by [`Event::parse`] rather than by a
//! catch-all enum arm, so known variants stay exhaustively matchable.

use serde::{Deserialize, Serialize};

/// Events the agent broadcasts on `agent.{id}.events`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
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
        stop_reason: StopReason,
    },
    Error {
        #[serde(rename = "turnId")]
        turn_id: Option<String>,
        message: String,
    },
}

impl Event {
    /// Parse an event from raw bytes. Returns `None` for unknown `type` values
    /// (forward compatibility, per the spec) and for malformed payloads.
    pub fn parse(bytes: &[u8]) -> Option<Event> {
        let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
        let known = matches!(
            value.get("type")?.as_str()?,
            "agent_ready" | "turn_started" | "text_delta" | "turn_ended" | "error"
        );
        if !known {
            return None;
        }
        serde_json::from_value(value).ok()
    }
}

/// Why a turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    Error,
}

/// Who a message came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct From {
    pub kind: Kind,
}

/// The only identity the POC carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Human,
    Orchestrator,
}

/// The message a client publishes on `agent.{id}.messages`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    UserInput { from: From, text: String },
}

impl ClientMessage {
    /// A `user_input` from a human, ready to publish.
    pub fn human_input(text: impl Into<String>) -> Self {
        ClientMessage::UserInput {
            from: From { kind: Kind::Human },
            text: text.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_round_trip_from_spec_json() {
        let cases: &[(&str, Event)] = &[
            (
                r#"{ "type": "agent_ready", "agentId": "agent-4f2a" }"#,
                Event::AgentReady {
                    agent_id: "agent-4f2a".into(),
                },
            ),
            (
                r#"{ "type": "turn_started", "turnId": "t-1", "text": "What's 2+2?", "from": { "kind": "human" } }"#,
                Event::TurnStarted {
                    turn_id: "t-1".into(),
                    text: "What's 2+2?".into(),
                    from: From { kind: Kind::Human },
                },
            ),
            (
                r#"{ "type": "text_delta", "turnId": "t-1", "text": "hello" }"#,
                Event::TextDelta {
                    turn_id: "t-1".into(),
                    text: "hello".into(),
                },
            ),
            (
                r#"{ "type": "turn_ended", "turnId": "t-1", "stopReason": "end_turn" }"#,
                Event::TurnEnded {
                    turn_id: "t-1".into(),
                    stop_reason: StopReason::EndTurn,
                },
            ),
            (
                r#"{ "type": "error", "message": "turn already in progress" }"#,
                Event::Error {
                    turn_id: None,
                    message: "turn already in progress".into(),
                },
            ),
            (
                r#"{ "type": "error", "turnId": "t-1", "message": "model call failed" }"#,
                Event::Error {
                    turn_id: Some("t-1".into()),
                    message: "model call failed".into(),
                },
            ),
        ];
        for (json, expected) in cases {
            assert_eq!(Event::parse(json.as_bytes()).as_ref(), Some(expected));
        }
    }

    #[test]
    fn unknown_type_is_skipped() {
        assert_eq!(
            Event::parse(br#"{ "type": "shiny_new_thing", "x": 1 }"#),
            None
        );
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let parsed = Event::parse(
            br#"{ "type": "text_delta", "turnId": "t-1", "text": "hi", "extra": true }"#,
        );
        assert_eq!(
            parsed,
            Some(Event::TextDelta {
                turn_id: "t-1".into(),
                text: "hi".into(),
            })
        );
    }

    #[test]
    fn user_input_serialises_to_spec_shape() {
        let json = serde_json::to_value(ClientMessage::human_input("What's 2+2?")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "user_input",
                "from": { "kind": "human" },
                "text": "What's 2+2?"
            })
        );
    }
}
