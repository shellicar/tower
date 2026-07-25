//! The agent concern's types (docs/spec/agent-spec.md, "Message schemas —
//! normative"). Servicing facts — who serves which conversation, and whether
//! they are alive — keyed by world on the wire. Same discipline as `conv`: v2-
//! style leaf subjects, so no `type` field in the body; `ingest` selects the
//! struct from the subject leaf and deserialises it.
//!
//! Telemetry (event) types are what a reader ingests: `ready`, `pulse`,
//! `attached`, `detached`. Requests (`service`, `drain`, `chdir`) are the
//! sender's direction and never reach ingest (streams capture event subjects
//! only); their servicer-side parse and reply encoders live below, same shape
//! as `say.rs`'s conversation-request half.
//!
//! The liveness fold itself (alive / released / stranded) is *not* here: it is
//! time-dependent (stranded = pulse silent past ~3× its interval), so it needs
//! a clock and belongs to the stateful reader, not this pure crate.

use serde::Deserialize;
use serde_json::Value;

use crate::ids::{ConversationId, InstanceId};

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Ready {
    pub ts: String,
    #[serde(rename = "instanceId")]
    pub instance_id: InstanceId,
    /// Provenance about the world (which host it runs on); a field, never the id.
    #[serde(default)]
    pub host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Pulse {
    pub ts: String,
    #[serde(rename = "instanceId")]
    pub instance_id: InstanceId,
    /// The liveness promise: the cadence, so a consumer judges silence against
    /// what this instance itself declared. Whole seconds — a heartbeat over NATS
    /// is never sub-second.
    #[serde(rename = "intervalS")]
    pub interval_s: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Attached {
    pub ts: String,
    #[serde(rename = "instanceId")]
    pub instance_id: InstanceId,
    #[serde(rename = "conversationId")]
    pub conversation_id: ConversationId,
    /// cwd is causal (an input to how the conversation unfolds) — a named field.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The liveness promise, optionally carried here too (not just `pulse`) —
    /// optional for backward compatibility with producers that don't send it
    /// yet. Absent = no promise; the reader's fold applies its own default
    /// silence threshold rather than reading absence as "definitely alive"
    /// (docs/spec/agent-spec.md, Liveness is a fold, never declared).
    #[serde(default, rename = "intervalS")]
    pub interval_s: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Detached {
    pub ts: String,
    #[serde(rename = "instanceId")]
    pub instance_id: InstanceId,
    #[serde(rename = "conversationId")]
    pub conversation_id: ConversationId,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentTelemetry {
    Ready(Ready),
    Pulse(Pulse),
    Attached(Attached),
    Detached(Detached),
}

impl AgentTelemetry {
    pub fn type_name(&self) -> &'static str {
        match self {
            AgentTelemetry::Ready(_) => "ready",
            AgentTelemetry::Pulse(_) => "pulse",
            AgentTelemetry::Attached(_) => "attached",
            AgentTelemetry::Detached(_) => "detached",
        }
    }

    pub fn ts(&self) -> &str {
        match self {
            AgentTelemetry::Ready(t) => &t.ts,
            AgentTelemetry::Pulse(t) => &t.ts,
            AgentTelemetry::Attached(t) => &t.ts,
            AgentTelemetry::Detached(t) => &t.ts,
        }
    }
}

// ---------------------------------------------------------------------------
// The servicer direction: what an agent instance reads off
// `agent.v1.{world}.requests.>` and how it answers. Same tolerance as
// `say.rs`'s `ConvRequest`: an unrecognised leaf is `Other`, answered
// `unsupported`, never dropped — compliance is answering. Reply encoding
// (`encode_accepted`/`encode_rejected`) is shared with `say.rs` — the reply
// shape `{accepted:true}` / `{rejected:true,reason}` is the same across
// concerns, so it is not duplicated here.

/// A request as the world's servicer sees it. `from` is provenance, verbatim.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentRequest {
    Service {
        conversation_id: ConversationId,
        cwd: Option<String>,
        model: Option<String>,
        from: Option<Value>,
    },
    /// A known leaf whose body doesn't carry what that verb requires (e.g.
    /// `service` missing `conversationId`, or carrying an empty one —
    /// present but not a usable id) — answered `rejected: invalid`, distinct
    /// from `unsupported`: the verb is known, the shape isn't.
    Invalid { type_name: String },
    /// An unrecognised leaf, or bytes that don't parse as JSON at all —
    /// answered `unsupported`, carrying the leaf for logs.
    Other { type_name: String },
}

/// (leaf, bytes) → request. The subject leaf spells the operation
/// (`agent.v1.{world}.requests.service` → `"service"`); the body carries no
/// type. Unparseable bytes, or an unrecognised leaf, are `Other`
/// (`unsupported`); a recognised leaf whose body lacks what it requires —
/// `service` missing `conversationId`, or carrying an empty one — is
/// `Invalid` (`invalid`). A servicer must answer everything addressed to it
/// either way.
pub fn parse_agent_request(leaf: &str, bytes: &[u8]) -> AgentRequest {
    let type_name = leaf.to_string();
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return AgentRequest::Other { type_name };
    };
    match leaf {
        "service" => {
            let Some(conversation_id) = value
                .get("conversationId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return AgentRequest::Invalid { type_name };
            };
            AgentRequest::Service {
                conversation_id: ConversationId(conversation_id.to_string()),
                cwd: value.get("cwd").and_then(Value::as_str).map(str::to_string),
                model: value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                from: value.get("from").cloned(),
            }
        }
        _ => AgentRequest::Other { type_name },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn attached_deserialises_without_a_type_field() {
        let v = json!({
            "ts": "2026-07-07T21:00:00+10:00", "instanceId": "inst-1a2f",
            "conversationId": "conv-abc", "cwd": "~/repos/tower"
        });
        let a: Attached = serde_json::from_value(v).unwrap();
        assert_eq!(a.conversation_id, ConversationId("conv-abc".into()));
        assert_eq!(a.cwd.as_deref(), Some("~/repos/tower"));
        assert_eq!(a.interval_s, None); // an older producer omits it entirely
    }

    #[test]
    fn attached_carries_its_own_interval_when_a_producer_sends_one() {
        let v = json!({
            "ts": "2026-07-07T21:00:00+10:00", "instanceId": "inst-1a2f",
            "conversationId": "conv-abc", "intervalS": 15
        });
        let a: Attached = serde_json::from_value(v).unwrap();
        assert_eq!(a.interval_s, Some(15));
    }

    #[test]
    fn pulse_carries_its_own_cadence() {
        let v = json!({ "ts": "2026-07-07T21:00:00+10:00", "instanceId": "inst-1a2f", "intervalS": 30 });
        let p: Pulse = serde_json::from_value(v).unwrap();
        assert_eq!(p.interval_s, 30);
    }

    #[test]
    fn service_request_parses_its_environment_fields() {
        let bytes = br#"{"ts":"2026-07-07T21:00:00+10:00","from":{"kind":"orchestrator"},"conversationId":"conv-abc","cwd":"~/repos/tower","model":"claude-sonnet-5"}"#;
        let AgentRequest::Service {
            conversation_id,
            cwd,
            model,
            from,
        } = parse_agent_request("service", bytes)
        else {
            panic!("expected service");
        };
        assert_eq!(conversation_id, ConversationId("conv-abc".into()));
        assert_eq!(cwd.as_deref(), Some("~/repos/tower"));
        assert_eq!(model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(from, Some(json!({ "kind": "orchestrator" })));
    }

    #[test]
    fn service_request_without_environment_fields_parses_bare() {
        let bytes = br#"{"ts":"2026-07-07T21:00:00+10:00","conversationId":"conv-abc"}"#;
        assert!(matches!(
            parse_agent_request("service", bytes),
            AgentRequest::Service {
                cwd: None,
                model: None,
                from: None,
                ..
            }
        ));
    }

    #[test]
    fn service_request_missing_conversation_id_is_invalid() {
        let bytes = br#"{"ts":"2026-07-07T21:00:00+10:00"}"#;
        assert!(matches!(
            parse_agent_request("service", bytes),
            AgentRequest::Invalid { .. }
        ));
    }

    #[test]
    fn service_request_with_empty_conversation_id_is_not_serviced() {
        let bytes = br#"{"ts":"2026-07-07T21:00:00+10:00","conversationId":""}"#;
        assert!(!matches!(
            parse_agent_request("service", bytes),
            AgentRequest::Service { .. }
        ));
    }

    #[test]
    fn unknown_leaf_and_garbage_bytes_are_unsupported() {
        assert!(matches!(
            parse_agent_request("drain", br#"{"ts":"2026-07-07T21:00:00+10:00"}"#),
            AgentRequest::Other { .. }
        ));
        assert!(matches!(
            parse_agent_request("service", b"not json"),
            AgentRequest::Other { .. }
        ));
    }
}
