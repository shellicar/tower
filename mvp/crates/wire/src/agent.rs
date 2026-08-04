//! The agent concern's telemetry types (docs/spec/agent.md, "Message
//! schemas — normative"). Servicing facts — who serves which conversation,
//! and whether they are alive — keyed by world on the wire. Same discipline as
//! `conv`: v2-style leaf subjects, so no `type` field in the body; `ingest`
//! selects the struct from the subject leaf and deserialises it.
//!
//! Telemetry (`ready`, `pulse`, `attached`, `detached`) is what a reader
//! ingests; requests never reach ingest (streams capture event subjects
//! only). The request side here is the SERVICER'S parse: `parse_agent_request`
//! turns a `agent.v1.{world}.requests.{leaf}` body into what bridge's request
//! loop dispatches on — the encoders for a sender land when a sender needs
//! them.
//!
//! The liveness fold itself (alive / released / stranded) is *not* here: it is
//! time-dependent (stranded = pulse silent past ~3× its interval), so it needs
//! a clock and belongs to the stateful reader, not this pure crate.

use serde::Deserialize;

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
    /// (docs/spec/agent.md, Liveness is a fold, never declared).
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

/// One inbound `agent.v1.{world}.requests.{leaf}` request, keyed by the
/// subject leaf (the subject spells the type; the body carries none). The
/// spec's reply discipline maps each variant to its answer: `Service` is
/// dispatched on the premise, `Invalid` is a recognised leaf whose body
/// doesn't carry what it needs (`rejected: invalid`), `Other` is any leaf
/// this servicer doesn't implement (`rejected: unsupported` — compliance is
/// answering, not implementing).
#[derive(Debug, Clone, PartialEq)]
pub enum AgentRequest {
    Service {
        conversation_id: ConversationId,
        cwd: Option<String>,
        model: Option<String>,
    },
    Invalid {
        leaf: String,
    },
    Other {
        leaf: String,
    },
}

pub fn parse_agent_request(leaf: &str, payload: &[u8]) -> AgentRequest {
    if leaf != "service" {
        return AgentRequest::Other {
            leaf: leaf.to_string(),
        };
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return AgentRequest::Invalid {
            leaf: leaf.to_string(),
        };
    };
    // A missing or empty conversationId is `invalid`, not `unsupported`: the
    // request is recognised, its body just doesn't carry what it needs
    // (agent.md, Requests).
    let conversation_id = match value
        .get("conversationId")
        .and_then(serde_json::Value::as_str)
    {
        Some(id) if !id.is_empty() => ConversationId(id.to_string()),
        _ => {
            return AgentRequest::Invalid {
                leaf: leaf.to_string(),
            };
        }
    };
    let field = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    AgentRequest::Service {
        conversation_id,
        cwd: field("cwd"),
        model: field("model"),
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
    fn a_service_request_parses_its_named_fields() {
        let payload = serde_json::to_vec(&json!({
            "ts": "2026-07-07T21:00:00+10:00", "from": {"kind": "orchestrator"},
            "conversationId": "conv-abc", "cwd": "~/repos/tower"
        }))
        .unwrap();
        let expected = AgentRequest::Service {
            conversation_id: ConversationId("conv-abc".into()),
            cwd: Some("~/repos/tower".into()),
            model: None,
        };
        assert_eq!(parse_agent_request("service", &payload), expected);
    }

    #[test]
    fn a_service_request_missing_conversation_id_is_invalid() {
        let payload = serde_json::to_vec(&json!({ "ts": "2026-07-07T21:00:00+10:00" })).unwrap();
        let expected = AgentRequest::Invalid {
            leaf: "service".into(),
        };
        assert_eq!(parse_agent_request("service", &payload), expected);
    }

    #[test]
    fn a_service_request_with_an_empty_conversation_id_is_invalid() {
        let payload = serde_json::to_vec(&json!({ "conversationId": "" })).unwrap();
        let expected = AgentRequest::Invalid {
            leaf: "service".into(),
        };
        assert_eq!(parse_agent_request("service", &payload), expected);
    }

    #[test]
    fn an_unimplemented_leaf_parses_as_other() {
        let expected = AgentRequest::Other {
            leaf: "drain".into(),
        };
        assert_eq!(parse_agent_request("drain", b"{}"), expected);
    }

    #[test]
    fn an_unparseable_service_body_is_invalid() {
        let expected = AgentRequest::Invalid {
            leaf: "service".into(),
        };
        assert_eq!(parse_agent_request("service", b"not json"), expected);
    }

    #[test]
    fn pulse_carries_its_own_cadence() {
        let v = json!({ "ts": "2026-07-07T21:00:00+10:00", "instanceId": "inst-1a2f", "intervalS": 30 });
        let p: Pulse = serde_json::from_value(v).unwrap();
        assert_eq!(p.interval_s, 30);
    }
}
