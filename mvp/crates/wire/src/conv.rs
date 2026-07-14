//! The conversation concern's message types (docs/spec/conversation-spec.md,
//! "Message schemas — normative"). Serde mirrors the zod: no
//! `deny_unknown_fields` anywhere (unknown fields pass — add-only), and
//! unknown message types are a represented state (`EventKind::Unknown` at the
//! ingest edge), never an error.
//!
//! v2 spells the type in the subject leaf, so these types carry no `type`
//! field: `ingest` selects the struct from the subject and deserialises it.
//! `deltas` is the one flat subject — `delta` and `block` share it and keep a
//! `type` field in the body, the single place the subject does not spell it.
//!
//! `from`, `content`, `input` are deliberately `serde_json::Value`: tower
//! renders, never interprets, and stores them verbatim. Typing them would make
//! every wire addition a tower change for no gain.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{MessageId, QueryId, TurnId};

/// The tolerance rule for the *flat* concerns that still carry `type` in the
/// body (approval v1, and conversation `deltas` via a direct match): try the
/// known shapes, and an unrecognised `type` still deserialises — as `Unknown`,
/// carrying the raw value. A misshaped *known* type still fails (leniency must
/// not conceal divergence). v2's leafed classes do not use this — the subject
/// selects the struct — but approval v1 does.
#[derive(Debug, Clone, PartialEq)]
pub enum Tolerant<T> {
    Known(T),
    Unknown(Value),
}

impl<T: for<'de> Deserialize<'de> + KnownTypes> Tolerant<T> {
    /// Route on `type`: a listed type must parse; an unlisted one is `Unknown`.
    pub fn parse(value: Value) -> Result<Self, serde_json::Error> {
        let known = value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| T::KNOWN.contains(&t));
        if known {
            Ok(Tolerant::Known(T::deserialize(value)?))
        } else {
            Ok(Tolerant::Unknown(value))
        }
    }
}

/// The `type` values a union defines today. Additions on the wire arrive as
/// `Unknown` until listed here — add-only, never breaking.
pub trait KnownTypes {
    const KNOWN: &'static [&'static str];
}

// ---------------------------------------------------------------------------
// conv.v2.{id}.telemetry.> — one struct per leaf; the subject selects it.

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnStarted {
    pub ts: String,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    #[serde(rename = "turnId")]
    pub turn_id: TurnId,
    pub service: String,
    pub model: String,
    pub thinking: bool,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(rename = "maxTokens")]
    pub max_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnEnded {
    pub ts: String,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    #[serde(rename = "turnId")]
    pub turn_id: TurnId,
    /// The service's own value, verbatim — an open set.
    #[serde(rename = "stopReason")]
    pub stop_reason: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnCancelled {
    pub ts: String,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    #[serde(rename = "turnId")]
    pub turn_id: TurnId,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TurnAborted {
    pub ts: String,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    #[serde(rename = "turnId")]
    pub turn_id: TurnId,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ToolUse {
    pub ts: String,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    #[serde(rename = "turnId")]
    pub turn_id: TurnId,
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Usage {
    pub ts: String,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    #[serde(rename = "turnId")]
    pub turn_id: TurnId,
    pub service: String,
    pub model: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "cacheCreationTokens")]
    pub cache_creation_tokens: i64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    #[serde(rename = "costUsd", default)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConvTelemetry {
    TurnStarted(TurnStarted),
    TurnEnded(TurnEnded),
    TurnCancelled(TurnCancelled),
    TurnAborted(TurnAborted),
    ToolUse(ToolUse),
    Usage(Usage),
}

impl ConvTelemetry {
    pub fn type_name(&self) -> &'static str {
        match self {
            ConvTelemetry::TurnStarted(_) => "turn_started",
            ConvTelemetry::TurnEnded(_) => "turn_ended",
            ConvTelemetry::TurnCancelled(_) => "turn_cancelled",
            ConvTelemetry::TurnAborted(_) => "turn_aborted",
            ConvTelemetry::ToolUse(_) => "tool_use",
            ConvTelemetry::Usage(_) => "usage",
        }
    }

    pub fn ts(&self) -> &str {
        match self {
            ConvTelemetry::TurnStarted(t) => &t.ts,
            ConvTelemetry::TurnEnded(t) => &t.ts,
            ConvTelemetry::TurnCancelled(t) => &t.ts,
            ConvTelemetry::TurnAborted(t) => &t.ts,
            ConvTelemetry::ToolUse(t) => &t.ts,
            ConvTelemetry::Usage(t) => &t.ts,
        }
    }
}

// ---------------------------------------------------------------------------
// conv.v2.{id}.changes.> — one struct per leaf.

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Message {
    pub ts: String,
    pub id: MessageId,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    #[serde(rename = "turnId")]
    pub turn_id: TurnId,
    pub role: String,
    /// Provenance, verbatim — forwarded, stored, never interpreted.
    pub from: Value,
    pub content: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Revision {
    pub ts: String,
    #[serde(rename = "messageId")]
    pub message_id: MessageId,
    pub content: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TipMoved {
    pub ts: String,
    pub to: MessageId,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Query {
    pub ts: String,
    #[serde(rename = "queryId")]
    pub query_id: QueryId,
    /// The system's own vocabulary (completed | cancelled | aborted), open set.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConvChange {
    Message(Message),
    Revision(Revision),
    TipMoved(TipMoved),
    Query(Query),
}

impl ConvChange {
    pub fn type_name(&self) -> &'static str {
        match self {
            ConvChange::Message(_) => "message",
            ConvChange::Revision(_) => "revision",
            ConvChange::TipMoved(_) => "tip_moved",
            ConvChange::Query(_) => "query",
        }
    }

    pub fn ts(&self) -> &str {
        match self {
            ConvChange::Message(c) => &c.ts,
            ConvChange::Revision(c) => &c.ts,
            ConvChange::TipMoved(c) => &c.ts,
            ConvChange::Query(c) => &c.ts,
        }
    }
}

// ---------------------------------------------------------------------------
// conv.v2.{id}.deltas — the one flat subject: `delta` and `block` share it and
// keep a `type` field in the body (the single home the subject does not spell).
// Deliberately bare otherwise: no ts, no correlation ids. One token stream, in
// order: `delta` is always the next chunk of it, `block` marks the stream
// changing character (thinking, text, tool_use — an open set). Order carries
// the structure; markers precede the deltas they describe.

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ConvDelta {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ConvBlock {
    #[serde(rename = "blockType")]
    pub block_type: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_change_struct_deserialises_without_a_type_field() {
        // v2 body carries no `type`: the subject selected TipMoved, we deserialise.
        let v = json!({ "ts": "2026-07-07T21:00:00+10:00", "to": "m1", "futureField": 42 });
        let parsed: TipMoved = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.to, MessageId("m1".into()));
    }

    #[test]
    fn a_misshaped_struct_fails() {
        // Missing required `to` — a known leaf that does not fit must error,
        // so ingest represents it as Unknown rather than a wrong TipMoved.
        let v = json!({ "ts": "2026-07-07T21:00:00+10:00" });
        assert!(serde_json::from_value::<TipMoved>(v).is_err());
    }

    #[test]
    fn usage_optional_fields() {
        let v = json!({
            "ts": "2026-07-07T21:00:00+10:00", "queryId": "q1", "turnId": "t1",
            "service": "anthropic.messages", "model": "claude-sonnet-4-5",
            "inputTokens": 1200, "cacheCreationTokens": 0, "cacheReadTokens": 0,
            "outputTokens": 80, "costUsd": 0.005, "thinkingTokens": 40
        });
        let parsed: Usage = serde_json::from_value(v).unwrap();
        assert_eq!(parsed.cost_usd, Some(0.005));
    }

    #[test]
    fn delta_and_block_discriminate_by_shape_in_the_body() {
        let d: ConvDelta = serde_json::from_value(json!({ "text": "hi" })).unwrap();
        assert_eq!(d.text, "hi");
        let b: ConvBlock = serde_json::from_value(json!({ "blockType": "thinking" })).unwrap();
        assert_eq!(b.block_type, "thinking");
    }
}
