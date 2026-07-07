//! Wire shapes, mirroring `spec.md` exactly. Serialized field names follow the
//! spec's camelCase; Rust names are idiomatic snake_case.

use serde::{Deserialize, Serialize};

/// Who a piece of input came from — the `from` object on `user_input` and `turn_started`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Origin {
    pub kind: OriginKind,
}

/// The only identity the POC carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OriginKind {
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

/// Events the agent publishes on `agent.{id}.events` (and `agent_ready` also on
/// `agent.announce`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    AgentReady { agent_id: String },
    #[serde(rename_all = "camelCase")]
    TurnStarted {
        turn_id: String,
        text: String,
        from: Origin,
    },
    #[serde(rename_all = "camelCase")]
    TextDelta { turn_id: String, text: String },
    #[serde(rename_all = "camelCase")]
    TurnEnded {
        turn_id: String,
        stop_reason: StopReason,
    },
    /// `turn_id` present: a running turn failed mid-flight. Absent: an input was
    /// rejected. The spec uses that presence to distinguish the two.
    #[serde(rename_all = "camelCase")]
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        message: String,
    },
}

/// A `user_input` message received on `agent.{id}.messages`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct UserInput {
    pub from: Origin,
    pub text: String,
}

/// Result of parsing one client message. The spec requires unknown `type` values
/// to be skipped without error, so "unknown" is a value here, not an `Err`.
#[derive(Debug, PartialEq)]
pub enum ClientMessage {
    UserInput(UserInput),
    Unknown,
}

impl ClientMessage {
    /// Parse one NATS payload. `Err` only for malformed JSON or a malformed
    /// known-type message; an unrecognized `type` is `Ok(Unknown)`.
    pub fn parse(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        #[derive(Deserialize)]
        struct Tagged {
            #[serde(rename = "type")]
            kind: String,
        }
        let tag: Tagged = serde_json::from_slice(bytes)?;
        match tag.kind.as_str() {
            "user_input" => Ok(Self::UserInput(serde_json::from_slice(bytes)?)),
            _ => Ok(Self::Unknown),
        }
    }
}

/// Role of one message in the model API conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One entry in the model request's `messages` array.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// Reply payload for the `agent.{id}.history` request/reply (desirable in the
/// spec): the conversation so far, so a late-attaching client can catch up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryReply {
    pub messages: Vec<ChatMessage>,
}

/// Body of `POST /v1/messages` on the fake model.
#[derive(Debug, Clone, Serialize)]
pub struct ModelRequest {
    pub model: String,
    pub stream: bool,
    pub max_tokens: u32,
    pub messages: Vec<ChatMessage>,
}

/// The `data` payload of a `content_block_delta` SSE event — only the part the
/// agent consumes.
#[derive(Debug, Deserialize)]
pub struct ContentBlockDelta {
    pub delta: DeltaPayload,
}

/// The inner delta of a `content_block_delta`.
#[derive(Debug, Deserialize)]
pub struct DeltaPayload {
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_to_spec_shapes() {
        let cases = [
            (
                Event::AgentReady {
                    agent_id: "agent-4f2a".into(),
                },
                r#"{"type":"agent_ready","agentId":"agent-4f2a"}"#,
            ),
            (
                Event::TurnStarted {
                    turn_id: "t-1".into(),
                    text: "What's 2+2?".into(),
                    from: Origin {
                        kind: OriginKind::Human,
                    },
                },
                r#"{"type":"turn_started","turnId":"t-1","text":"What's 2+2?","from":{"kind":"human"}}"#,
            ),
            (
                Event::TextDelta {
                    turn_id: "t-1".into(),
                    text: "hello".into(),
                },
                r#"{"type":"text_delta","turnId":"t-1","text":"hello"}"#,
            ),
            (
                Event::TurnEnded {
                    turn_id: "t-1".into(),
                    stop_reason: StopReason::EndTurn,
                },
                r#"{"type":"turn_ended","turnId":"t-1","stopReason":"end_turn"}"#,
            ),
            (
                Event::Error {
                    turn_id: None,
                    message: "turn already in progress".into(),
                },
                r#"{"type":"error","message":"turn already in progress"}"#,
            ),
            (
                Event::Error {
                    turn_id: Some("t-1".into()),
                    message: "model call failed".into(),
                },
                r#"{"type":"error","turnId":"t-1","message":"model call failed"}"#,
            ),
        ];
        for (event, expected) in cases {
            assert_eq!(serde_json::to_string(&event).unwrap(), expected);
            assert_eq!(serde_json::from_str::<Event>(expected).unwrap(), event);
        }
    }

    #[test]
    fn user_input_parses() {
        let parsed =
            ClientMessage::parse(br#"{"type":"user_input","from":{"kind":"human"},"text":"hi"}"#)
                .unwrap();
        assert_eq!(
            parsed,
            ClientMessage::UserInput(UserInput {
                from: Origin {
                    kind: OriginKind::Human
                },
                text: "hi".into()
            })
        );
    }

    #[test]
    fn unknown_type_is_skipped_not_an_error() {
        let parsed = ClientMessage::parse(br#"{"type":"mystery","payload":42}"#).unwrap();
        assert_eq!(parsed, ClientMessage::Unknown);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let parsed = ClientMessage::parse(
            br#"{"type":"user_input","from":{"kind":"human"},"text":"hi","extra":true}"#,
        )
        .unwrap();
        assert!(matches!(parsed, ClientMessage::UserInput(_)));
    }

    #[test]
    fn malformed_json_is_an_error() {
        assert!(ClientMessage::parse(b"not json").is_err());
    }
}
