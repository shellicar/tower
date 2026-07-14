//! The edge fold: one wire frame (concrete subject + payload bytes) → one
//! event. The subject is parsed here, once — nothing inward of this function
//! sees a subject string. Tolerance throughout: an unknown class token, an
//! unknown leaf, or an unparseable payload each become a represented state,
//! never an error — ingest must survive anything the wire grows.
//!
//! v2 spells the type in the subject leaf. For the leafed classes (conv v2's
//! `changes`/`telemetry`, agent v1's `telemetry`) the subject selects the
//! struct and we deserialise it directly — the body carries no `type`. The
//! flat subjects (`deltas`, approval v1's `lifecycle`/`telemetry`) keep their
//! `type` in the body and are dispatched on it.

use serde_json::Value;

use crate::agent::AgentTelemetry;
use crate::approval::ApprovalLifecycle;
use crate::conv::{ConvBlock, ConvChange, ConvDelta, ConvTelemetry, Tolerant};
use crate::ids::{ApprovalId, ConversationId, WorldId};

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub conv: ConversationId,
    pub kind: EventKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EventKind {
    Telemetry(ConvTelemetry),
    Change(ConvChange),
    Delta(ConvDelta),
    /// The stream changed character; the deltas that follow are `block_type`.
    Block(ConvBlock),
    /// Anything the wire says that this build doesn't model: an unknown class
    /// token, an unknown leaf, a misshaped known type, non-JSON bytes. Carried,
    /// not dropped — the staleness fold still counts it as a touch when a `ts`
    /// is readable; `label` names what it was for `lastKind`.
    Unknown {
        label: String,
        ts: Option<String>,
    },
}

/// One wire frame, whichever concern it belongs to. Conversation, approval and
/// agent are consumed; anything else is not tower's to represent.
#[derive(Debug, Clone, PartialEq)]
pub enum WireEvent {
    Conv(Event),
    Approval(ApprovalEvent),
    Agent(AgentEvent),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalEvent {
    pub id: ApprovalId,
    pub kind: ApprovalKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApprovalKind {
    Lifecycle(ApprovalLifecycle),
    /// The pending ask's own pulse (~15s while pending).
    Heartbeat {
        ts: String,
    },
    /// Represented, not refused — same tolerance as the conversation side.
    Unknown {
        label: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentEvent {
    pub world: WorldId,
    pub kind: AgentKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AgentKind {
    Telemetry(AgentTelemetry),
    /// An unknown leaf, a misshaped known one, or a non-telemetry class that
    /// somehow reached ingest — carried, never dropped.
    Unknown {
        label: String,
        ts: Option<String>,
    },
}

/// `{concern}.{version}.{id}.{class}[.{event}…]` → WireEvent. `None` = a
/// concern/version tower doesn't consume, or a malformed subject: the caller
/// skips the frame. Versions are per concern — `conv` is v2, `agent` and
/// `approval` are v1 — and coexist.
pub fn parse_wire(subject: &str, payload: &[u8]) -> Option<WireEvent> {
    // Walk the tokens with the iterator — no Vec per frame. Header first; the
    // event type is the remaining tokens joined with '_' (empty for a flat
    // subject), built without collecting the whole subject.
    let mut it = subject.split('.');
    let concern = it.next()?;
    let version = it.next()?;
    let id = it.next()?;
    let class = it.next()?;
    if id.is_empty() {
        return None;
    }
    let mut event_type = String::new();
    for tok in it {
        if !event_type.is_empty() {
            event_type.push('_');
        }
        event_type.push_str(tok);
    }
    match (concern, version) {
        ("conv", "v2") => Some(WireEvent::Conv(parse_conv(id, class, &event_type, payload))),
        ("agent", "v1") => Some(WireEvent::Agent(parse_agent(
            id,
            class,
            &event_type,
            payload,
        ))),
        ("approval", "v1") => Some(WireEvent::Approval(parse_approval(id, class, payload))),
        _ => None,
    }
}

fn parse_conv(id: &str, class: &str, event_type: &str, payload: &[u8]) -> Event {
    let conv = ConversationId(id.to_string());
    let value: Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => {
            return Event {
                conv,
                kind: EventKind::Unknown {
                    label: format!("{class}:unparseable"),
                    ts: None,
                },
            };
        }
    };
    let ts = value.get("ts").and_then(Value::as_str).map(str::to_string);

    // Precompute the fallback label before `value` may be moved into deserialise
    // (payloads are large — a tool result runs to ~500KB — so the parse must not
    // clone). deltas' type is in the body; leafed classes reconstruct it from
    // the subject.
    let label = if class == "deltas" {
        value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string()
    } else if event_type.is_empty() {
        class.to_string()
    } else {
        event_type.to_string()
    };

    let kind = conv_kind(class, event_type, value).unwrap_or(EventKind::Unknown { label, ts });
    Event { conv, kind }
}

/// The subject selects the struct (leafed classes) or the body `type` does
/// (`deltas`). `None` for an unknown class/leaf or a misshaped known type —
/// the caller represents it as `Unknown`.
fn conv_kind(class: &str, event_type: &str, value: Value) -> Option<EventKind> {
    Some(match class {
        "telemetry" => EventKind::Telemetry(match event_type {
            "turn_started" => ConvTelemetry::TurnStarted(serde_json::from_value(value).ok()?),
            "turn_ended" => ConvTelemetry::TurnEnded(serde_json::from_value(value).ok()?),
            "turn_cancelled" => ConvTelemetry::TurnCancelled(serde_json::from_value(value).ok()?),
            "turn_aborted" => ConvTelemetry::TurnAborted(serde_json::from_value(value).ok()?),
            "tool_use" => ConvTelemetry::ToolUse(serde_json::from_value(value).ok()?),
            "usage" => ConvTelemetry::Usage(serde_json::from_value(value).ok()?),
            _ => return None,
        }),
        "changes" => EventKind::Change(match event_type {
            "message" => ConvChange::Message(serde_json::from_value(value).ok()?),
            "revision" => ConvChange::Revision(serde_json::from_value(value).ok()?),
            "tip_moved" => ConvChange::TipMoved(serde_json::from_value(value).ok()?),
            "query" => ConvChange::Query(serde_json::from_value(value).ok()?),
            _ => return None,
        }),
        // The one flat conversation subject: `delta` and `block` share it and
        // discriminate on the body `type`. Read that out (a short string) before
        // moving `value` into deserialise, so nothing large is cloned.
        "deltas" => {
            let which = value
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string);
            match which.as_deref() {
                Some("delta") => EventKind::Delta(serde_json::from_value(value).ok()?),
                Some("block") => EventKind::Block(serde_json::from_value(value).ok()?),
                _ => return None,
            }
        }
        _ => return None,
    })
}

fn parse_agent(id: &str, class: &str, event_type: &str, payload: &[u8]) -> AgentEvent {
    let world = WorldId(id.to_string());
    let value: Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => {
            return AgentEvent {
                world,
                kind: AgentKind::Unknown {
                    label: format!("{class}:unparseable"),
                    ts: None,
                },
            };
        }
    };
    let ts = value.get("ts").and_then(Value::as_str).map(str::to_string);
    let label = if event_type.is_empty() {
        class.to_string()
    } else {
        event_type.to_string()
    };

    let kind = agent_kind(class, event_type, value).unwrap_or(AgentKind::Unknown { label, ts });
    AgentEvent { world, kind }
}

fn agent_kind(class: &str, event_type: &str, value: Value) -> Option<AgentKind> {
    Some(match class {
        "telemetry" => AgentKind::Telemetry(match event_type {
            "ready" => AgentTelemetry::Ready(serde_json::from_value(value).ok()?),
            "pulse" => AgentTelemetry::Pulse(serde_json::from_value(value).ok()?),
            "attached" => AgentTelemetry::Attached(serde_json::from_value(value).ok()?),
            "detached" => AgentTelemetry::Detached(serde_json::from_value(value).ok()?),
            _ => return None,
        }),
        // `.requests` never reaches ingest (streams capture event subjects
        // only); any other class is represented rather than refused.
        _ => return None,
    })
}

fn parse_approval(id: &str, kind: &str, payload: &[u8]) -> ApprovalEvent {
    let id = ApprovalId(id.to_string());

    let value: Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => {
            return ApprovalEvent {
                id,
                kind: ApprovalKind::Unknown {
                    label: format!("{kind}:unparseable"),
                },
            };
        }
    };
    let type_name = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string();
    let ts = value.get("ts").and_then(Value::as_str).map(str::to_string);

    let kind = match kind {
        "lifecycle" => match Tolerant::<ApprovalLifecycle>::parse(value) {
            Ok(Tolerant::Known(l)) => ApprovalKind::Lifecycle(l),
            Ok(Tolerant::Unknown(_)) | Err(_) => ApprovalKind::Unknown { label: type_name },
        },
        "telemetry" => match (type_name.as_str(), ts) {
            ("heartbeat", Some(ts)) => ApprovalKind::Heartbeat { ts },
            _ => ApprovalKind::Unknown { label: type_name },
        },
        other => ApprovalKind::Unknown {
            label: format!("{other}:{type_name}"),
        },
    };
    ApprovalEvent { id, kind }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::Attached;
    use crate::conv::Message;

    fn conv_event(subject: &str, payload: &[u8]) -> Event {
        match parse_wire(subject, payload) {
            Some(WireEvent::Conv(e)) => e,
            other => panic!("expected a conversation event, got {other:?}"),
        }
    }

    fn agent_event(subject: &str, payload: &[u8]) -> AgentEvent {
        match parse_wire(subject, payload) {
            Some(WireEvent::Agent(e)) => e,
            other => panic!("expected an agent event, got {other:?}"),
        }
    }

    fn approval_event(subject: &str, payload: &[u8]) -> ApprovalEvent {
        match parse_wire(subject, payload) {
            Some(WireEvent::Approval(e)) => e,
            other => panic!("expected an approval event, got {other:?}"),
        }
    }

    #[test]
    fn change_message_parses_from_the_subject_leaf() {
        let payload = br#"{"ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}"#;
        let event = conv_event("conv.v2.conv-abc.changes.message", payload);
        assert_eq!(event.conv, ConversationId("conv-abc".into()));
        let EventKind::Change(ConvChange::Message(Message { id, role, .. })) = event.kind else {
            panic!("expected message");
        };
        assert_eq!(id.0, "m1");
        assert_eq!(role, "user");
    }

    #[test]
    fn tip_moved_parses_from_the_multi_token_leaf() {
        // changes.tip.moved → "tip_moved"
        let payload = br#"{"ts":"2026-07-07T21:00:00+10:00","to":"m1"}"#;
        let event = conv_event("conv.v2.conv-abc.changes.tip.moved", payload);
        assert!(matches!(
            event.kind,
            EventKind::Change(ConvChange::TipMoved(_))
        ));
    }

    #[test]
    fn query_closure_parses() {
        let payload = br#"{"ts":"2026-07-07T21:00:00+10:00","queryId":"q1","reason":"completed"}"#;
        let event = conv_event("conv.v2.conv-abc.changes.query", payload);
        let EventKind::Change(ConvChange::Query(q)) = event.kind else {
            panic!("expected query");
        };
        assert_eq!(q.reason, "completed");
    }

    #[test]
    fn telemetry_parses_from_the_leaf() {
        let payload = br#"{"ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","stopReason":"end_turn"}"#;
        let event = conv_event("conv.v2.conv-abc.telemetry.turn.ended", payload);
        let EventKind::Telemetry(ConvTelemetry::TurnEnded(t)) = event.kind else {
            panic!("expected turn_ended");
        };
        assert_eq!(t.stop_reason, "end_turn");
    }

    #[test]
    fn deltas_discriminate_on_the_body_type() {
        let event = conv_event(
            "conv.v2.conv-abc.deltas",
            br#"{"type":"delta","text":"File X contains"}"#,
        );
        assert_eq!(
            event.kind,
            EventKind::Delta(ConvDelta {
                text: "File X contains".into()
            })
        );
        let event = conv_event(
            "conv.v2.conv-abc.deltas",
            br#"{"type":"block","blockType":"thinking"}"#,
        );
        assert_eq!(
            event.kind,
            EventKind::Block(ConvBlock {
                block_type: "thinking".into()
            })
        );
    }

    #[test]
    fn unknown_leaf_is_represented_with_ts() {
        let payload = br#"{"ts":"2026-07-07T21:00:00+10:00"}"#;
        let event = conv_event("conv.v2.conv-abc.telemetry.vibe.shift", payload);
        assert_eq!(
            event.kind,
            EventKind::Unknown {
                label: "vibe_shift".into(),
                ts: Some("2026-07-07T21:00:00+10:00".into())
            }
        );
    }

    #[test]
    fn misshaped_known_leaf_is_unknown() {
        // changes.tip.moved with no `to` — must not become a wrong TipMoved.
        let event = conv_event(
            "conv.v2.conv-abc.changes.tip.moved",
            br#"{"ts":"2026-07-07T21:00:00+10:00"}"#,
        );
        assert!(matches!(event.kind, EventKind::Unknown { .. }));
    }

    #[test]
    fn non_json_is_represented() {
        let event = conv_event("conv.v2.conv-abc.changes.message", b"not json");
        assert!(matches!(event.kind, EventKind::Unknown { .. }));
    }

    #[test]
    fn version_and_concern_gating() {
        // conv is v2 now; v1 is nobody's.
        assert_eq!(parse_wire("conv.v1.conv-abc.changes", b"{}"), None);
        // approval stays v1.
        assert_eq!(parse_wire("approval.v2.apr-1.lifecycle", b"{}"), None);
        // malformed: too few tokens.
        assert_eq!(parse_wire("conv.v2", b"{}"), None);
        assert_eq!(parse_wire("conv.v2.conv-abc", b"{}"), None);
    }

    #[test]
    fn agent_attached_parses() {
        let payload = br#"{"ts":"2026-07-07T21:00:00+10:00","instanceId":"inst-1a2f","conversationId":"conv-abc","cwd":"~/repos/tower"}"#;
        let event = agent_event("agent.v1.mac.telemetry.attached", payload);
        assert_eq!(event.world, WorldId("mac".into()));
        let AgentKind::Telemetry(AgentTelemetry::Attached(Attached {
            conversation_id, ..
        })) = event.kind
        else {
            panic!("expected attached");
        };
        assert_eq!(conversation_id.0, "conv-abc");
    }

    #[test]
    fn agent_unknown_leaf_is_represented() {
        let event = agent_event(
            "agent.v1.mac.telemetry.sparkle",
            br#"{"ts":"2026-07-07T21:00:00+10:00"}"#,
        );
        assert!(matches!(event.kind, AgentKind::Unknown { .. }));
    }

    #[test]
    fn approval_lifecycle_still_parses_on_body_type() {
        let payload = br#"{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./old.ts"]}}},"correlation":{"conversationId":"conv-abc","queryId":"q2","turnId":"t3","toolUseId":"toolu_02DEF"}}"#;
        let event = approval_event("approval.v1.apr-1.lifecycle", payload);
        assert_eq!(event.id.0, "apr-1");
        let ApprovalKind::Lifecycle(ApprovalLifecycle::Raised { ask, .. }) = event.kind else {
            panic!("expected raised");
        };
        assert_eq!(ask["name"], "DeleteFile");
    }

    #[test]
    fn approval_heartbeat_parses() {
        let event = approval_event(
            "approval.v1.apr-1.telemetry",
            br#"{"type":"heartbeat","ts":"2026-07-07T21:00:00+10:00"}"#,
        );
        assert_eq!(
            event.kind,
            ApprovalKind::Heartbeat {
                ts: "2026-07-07T21:00:00+10:00".into()
            }
        );
    }
}
