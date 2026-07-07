//! Wire shapes for the Messages-API subset, mirroring `spec.md` exactly.

use serde::{Deserialize, Serialize};

/// Role of a conversation message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

/// One entry in the request `messages` array. `content` is a plain string per spec.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

/// Request body for `POST /v1/messages`.
///
/// Unknown fields are ignored (serde's default), per the spec's forward-compatibility
/// rule.
#[derive(Debug, Deserialize)]
pub struct MessagesRequest {
    pub model: String,
    #[serde(default)]
    pub stream: bool,
    pub max_tokens: u32,
    pub messages: Vec<ChatMessage>,
}

/// The `message` object carried by `message_start`.
#[derive(Debug, Serialize)]
pub struct MessageStart {
    pub id: String,
    pub role: Role,
}

/// A content-block delta payload.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Delta {
    TextDelta { text: String },
}

/// SSE `data:` payloads, tagged by `type`. The SSE `event:` name matches the tag;
/// [`StreamEvent::name`] provides it.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    MessageStart { message: MessageStart },
    ContentBlockDelta { index: u32, delta: Delta },
    MessageStop,
}

impl StreamEvent {
    /// The SSE `event:` name for this payload.
    pub fn name(&self) -> &'static str {
        match self {
            StreamEvent::MessageStart { .. } => "message_start",
            StreamEvent::ContentBlockDelta { .. } => "content_block_delta",
            StreamEvent::MessageStop => "message_stop",
        }
    }
}

/// Error body for a `400` response.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_deserializes_and_ignores_unknown_fields() {
        let json = r#"{
            "model": "fake-1",
            "stream": true,
            "max_tokens": 1024,
            "temperature": 0.7,
            "messages": [ { "role": "user", "content": "What's 2+2?", "extra": 1 } ]
        }"#;
        let req: MessagesRequest = serde_json::from_str(json).expect("valid request");
        assert_eq!(req.model, "fake-1");
        assert!(req.stream);
        assert_eq!(req.max_tokens, 1024);
        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].role, Role::User);
    }

    #[test]
    fn request_with_wrong_role_is_rejected() {
        let json = r#"{
            "model": "fake-1",
            "max_tokens": 10,
            "messages": [ { "role": "robot", "content": "hi" } ]
        }"#;
        assert!(serde_json::from_str::<MessagesRequest>(json).is_err());
    }

    #[test]
    fn stream_events_serialize_to_spec_shapes() {
        let start = StreamEvent::MessageStart {
            message: MessageStart {
                id: "msg_1".into(),
                role: Role::Assistant,
            },
        };
        assert_eq!(
            serde_json::to_string(&start).expect("serialize"),
            r#"{"type":"message_start","message":{"id":"msg_1","role":"assistant"}}"#
        );
        assert_eq!(start.name(), "message_start");

        let delta = StreamEvent::ContentBlockDelta {
            index: 0,
            delta: Delta::TextDelta { text: "4".into() },
        };
        assert_eq!(
            serde_json::to_string(&delta).expect("serialize"),
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"4"}}"#
        );
        assert_eq!(delta.name(), "content_block_delta");

        let stop = StreamEvent::MessageStop;
        assert_eq!(
            serde_json::to_string(&stop).expect("serialize"),
            r#"{"type":"message_stop"}"#
        );
        assert_eq!(stop.name(), "message_stop");
    }
}
