//! The conversation concern's message types (docs/spec/conversation-spec.md,
//! "Message schemas — normative"). Serde mirrors the zod: no
//! `deny_unknown_fields` anywhere (unknown fields pass — add-only), and
//! unknown message types are a represented state (`Tolerant::Unknown`), never
//! an error.
//!
//! `from` and `content` are deliberately `serde_json::Value`: tower renders,
//! never interprets, and stores them verbatim. Typing them would make every
//! wire addition a tower change for no gain.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::{MessageId, QueryId, TurnId};

/// The tolerance rule for discriminated unions: try the known shapes, and an
/// unrecognised `type` still deserialises — as `Unknown`, carrying the raw
/// value. A misshaped *known* type still fails (leniency must not conceal
/// divergence), which untagged fallback alone would break; `route` below
/// checks the discriminator first for exactly that reason.
#[derive(Debug, Clone, PartialEq)]
pub enum Tolerant<T> {
    Known(T),
    Unknown(Value),
}

impl<T: for<'de> Deserialize<'de> + KnownTypes> Tolerant<T> {
    /// Route on `type`: a listed type must parse (error surfaces upward as a
    /// skipped, logged frame); an unlisted one is `Unknown` by definition.
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
// conv.v1.{id}.telemetry

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum ConvTelemetry {
    #[serde(rename = "turn_started")]
    TurnStarted {
        ts: String,
        #[serde(rename = "queryId")]
        query_id: QueryId,
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        service: String,
        model: String,
        thinking: bool,
        #[serde(default)]
        effort: Option<String>,
        #[serde(rename = "maxTokens")]
        max_tokens: i64,
    },
    #[serde(rename = "turn_ended")]
    TurnEnded {
        ts: String,
        #[serde(rename = "queryId")]
        query_id: QueryId,
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        /// The service's own value, verbatim — an open set.
        #[serde(rename = "stopReason")]
        stop_reason: String,
    },
    #[serde(rename = "turn_cancelled")]
    TurnCancelled {
        ts: String,
        #[serde(rename = "queryId")]
        query_id: QueryId,
        #[serde(rename = "turnId")]
        turn_id: TurnId,
    },
    #[serde(rename = "turn_aborted")]
    TurnAborted {
        ts: String,
        #[serde(rename = "queryId")]
        query_id: QueryId,
        #[serde(rename = "turnId")]
        turn_id: TurnId,
    },
    #[serde(rename = "tool_use")]
    ToolUse {
        ts: String,
        #[serde(rename = "queryId")]
        query_id: QueryId,
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        id: String,
        name: String,
        input: Value,
    },
    #[serde(rename = "usage")]
    Usage {
        ts: String,
        #[serde(rename = "queryId")]
        query_id: QueryId,
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        service: String,
        model: String,
        #[serde(rename = "inputTokens")]
        input_tokens: i64,
        #[serde(rename = "cacheCreationTokens")]
        cache_creation_tokens: i64,
        #[serde(rename = "cacheReadTokens")]
        cache_read_tokens: i64,
        #[serde(rename = "outputTokens")]
        output_tokens: i64,
        #[serde(rename = "costUsd", default)]
        cost_usd: Option<f64>,
    },
}

impl KnownTypes for ConvTelemetry {
    const KNOWN: &'static [&'static str] = &[
        "turn_started",
        "turn_ended",
        "turn_cancelled",
        "turn_aborted",
        "tool_use",
        "usage",
    ];
}

impl ConvTelemetry {
    pub fn type_name(&self) -> &'static str {
        match self {
            ConvTelemetry::TurnStarted { .. } => "turn_started",
            ConvTelemetry::TurnEnded { .. } => "turn_ended",
            ConvTelemetry::TurnCancelled { .. } => "turn_cancelled",
            ConvTelemetry::TurnAborted { .. } => "turn_aborted",
            ConvTelemetry::ToolUse { .. } => "tool_use",
            ConvTelemetry::Usage { .. } => "usage",
        }
    }

    pub fn ts(&self) -> &str {
        match self {
            ConvTelemetry::TurnStarted { ts, .. }
            | ConvTelemetry::TurnEnded { ts, .. }
            | ConvTelemetry::TurnCancelled { ts, .. }
            | ConvTelemetry::TurnAborted { ts, .. }
            | ConvTelemetry::ToolUse { ts, .. }
            | ConvTelemetry::Usage { ts, .. } => ts,
        }
    }
}

// ---------------------------------------------------------------------------
// conv.v1.{id}.changes

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum ConvChange {
    #[serde(rename = "message")]
    Message {
        ts: String,
        id: MessageId,
        #[serde(rename = "queryId")]
        query_id: QueryId,
        #[serde(rename = "turnId")]
        turn_id: TurnId,
        role: String,
        /// Provenance, verbatim — forwarded, stored, never interpreted.
        from: Value,
        content: Vec<Value>,
    },
    #[serde(rename = "revision")]
    Revision {
        ts: String,
        #[serde(rename = "messageId")]
        message_id: MessageId,
        content: Vec<Value>,
    },
    #[serde(rename = "tip_moved")]
    TipMoved { ts: String, to: MessageId },
}

impl KnownTypes for ConvChange {
    const KNOWN: &'static [&'static str] = &["message", "revision", "tip_moved"];
}

impl ConvChange {
    pub fn type_name(&self) -> &'static str {
        match self {
            ConvChange::Message { .. } => "message",
            ConvChange::Revision { .. } => "revision",
            ConvChange::TipMoved { .. } => "tip_moved",
        }
    }

    pub fn ts(&self) -> &str {
        match self {
            ConvChange::Message { ts, .. }
            | ConvChange::Revision { ts, .. }
            | ConvChange::TipMoved { ts, .. } => ts,
        }
    }
}

// ---------------------------------------------------------------------------
// conv.v1.{id}.deltas — deliberately bare: no ts, no correlation ids.
// One token stream, in order: `delta` is always the next chunk of it, and
// `block` marks the stream changing character (thinking, text, tool_use —
// an open set mirroring the committed content block types). Order carries
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
    fn unknown_type_is_a_represented_state() {
        let v = json!({ "type": "usage_v2_shiny", "ts": "2026-07-07T21:00:00+10:00" });
        let parsed = Tolerant::<ConvTelemetry>::parse(v.clone()).unwrap();
        assert_eq!(parsed, Tolerant::Unknown(v));
    }

    #[test]
    fn misshaped_known_type_fails() {
        // A known type missing required fields must NOT slide into Unknown.
        let v = json!({ "type": "turn_ended", "ts": "2026-07-07T21:00:00+10:00" });
        assert!(Tolerant::<ConvTelemetry>::parse(v).is_err());
    }

    #[test]
    fn unknown_fields_pass() {
        let v = json!({
            "type": "tip_moved", "ts": "2026-07-07T21:00:00+10:00",
            "to": "m1", "futureField": 42
        });
        let parsed = Tolerant::<ConvChange>::parse(v).unwrap();
        assert!(matches!(
            parsed,
            Tolerant::Known(ConvChange::TipMoved { .. })
        ));
    }

    #[test]
    fn usage_optional_fields() {
        let v = json!({
            "type": "usage", "ts": "2026-07-07T21:00:00+10:00",
            "queryId": "q1", "turnId": "t1",
            "service": "anthropic.messages", "model": "claude-sonnet-4-5",
            "inputTokens": 1200, "cacheCreationTokens": 0, "cacheReadTokens": 0,
            "outputTokens": 80, "costUsd": 0.005,
            "thinkingTokens": 40
        });
        let parsed = Tolerant::<ConvTelemetry>::parse(v).unwrap();
        let Tolerant::Known(ConvTelemetry::Usage { cost_usd, .. }) = parsed else {
            panic!("expected usage");
        };
        assert_eq!(cost_usd, Some(0.005));
    }
}
