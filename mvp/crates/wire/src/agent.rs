//! The agent concern's telemetry types (docs/spec/agent-spec.md, "Message
//! schemas — normative"). Servicing facts — who serves which conversation,
//! and whether they are alive — keyed by world on the wire. Same discipline as
//! `conv`: v2-style leaf subjects, so no `type` field in the body; `ingest`
//! selects the struct from the subject leaf and deserialises it.
//!
//! Only the telemetry (event) side lives here: `ready`, `pulse`, `attached`,
//! `detached` are what a reader ingests. The requests (`service`, `drain`,
//! `chdir`) are the sender's direction and never reach ingest (streams capture
//! event subjects only) — their encoders land when a sender needs them.
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
    }

    #[test]
    fn pulse_carries_its_own_cadence() {
        let v = json!({ "ts": "2026-07-07T21:00:00+10:00", "instanceId": "inst-1a2f", "intervalS": 30 });
        let p: Pulse = serde_json::from_value(v).unwrap();
        assert_eq!(p.interval_s, 30);
    }
}
