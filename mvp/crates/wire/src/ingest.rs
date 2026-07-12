//! The edge fold: one wire frame (concrete subject + payload bytes) → one
//! `Event`. The subject is parsed here, once — nothing inward of this
//! function sees a subject string. Tolerance throughout: an unknown kind
//! token, an unknown message type, or an unparseable payload each become a
//! represented state, never an error — ingest must survive anything the wire
//! grows.

use serde_json::Value;

use crate::approval::ApprovalLifecycle;
use crate::conv::{ConvBlock, ConvChange, ConvDelta, ConvTelemetry, Tolerant};
use crate::ids::{ApprovalId, ConversationId};

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
    /// Anything the wire says that this build doesn't model: an unknown kind
    /// token, an unknown `type`, a misshaped known type, non-JSON bytes.
    /// Carried, not dropped — the staleness fold still counts it as a touch
    /// when a `ts` is readable; `label` names what it was for `lastKind`.
    Unknown {
        label: String,
        ts: Option<String>,
    },
}

/// One wire frame, whichever concern it belongs to. The conversation and
/// approval concerns are consumed; anything else is not tower's to represent.
#[derive(Debug, Clone, PartialEq)]
pub enum WireEvent {
    Conv(Event),
    Approval(ApprovalEvent),
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

/// `{concern}.v1.{id}.{kind}` → WireEvent. `None` = a concern tower doesn't
/// consume, or a malformed subject: the caller skips the frame.
pub fn parse_wire(subject: &str, payload: &[u8]) -> Option<WireEvent> {
    let mut parts = subject.split('.');
    let (concern, version, id, kind) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if version != "v1" || id.is_empty() || parts.next().is_some() {
        return None;
    }
    match concern {
        "conv" => Some(WireEvent::Conv(parse_conv(id, kind, payload))),
        "approval" => Some(WireEvent::Approval(parse_approval(id, kind, payload))),
        _ => None,
    }
}

fn parse_conv(id: &str, kind: &str, payload: &[u8]) -> Event {
    let conv = ConversationId(id.to_string());

    let value: Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => {
            return Event {
                conv,
                kind: EventKind::Unknown {
                    label: format!("{kind}:unparseable"),
                    ts: None,
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
    let unknown = |label: String| EventKind::Unknown {
        label,
        ts: ts.clone(),
    };

    let kind = match kind {
        "telemetry" => match Tolerant::<ConvTelemetry>::parse(value) {
            Ok(Tolerant::Known(t)) => EventKind::Telemetry(t),
            Ok(Tolerant::Unknown(_)) | Err(_) => unknown(type_name),
        },
        "changes" => match Tolerant::<ConvChange>::parse(value) {
            Ok(Tolerant::Known(c)) => EventKind::Change(c),
            Ok(Tolerant::Unknown(_)) | Err(_) => unknown(type_name),
        },
        "deltas" => match type_name.as_str() {
            "delta" => match serde_json::from_value::<ConvDelta>(value) {
                Ok(d) => EventKind::Delta(d),
                Err(_) => unknown(type_name),
            },
            "block" => match serde_json::from_value::<ConvBlock>(value) {
                Ok(b) => EventKind::Block(b),
                Err(_) => unknown(type_name),
            },
            _ => unknown(type_name),
        },
        // `.requests` never reaches ingest (streams capture event subjects
        // only); if a frame arrives anyway, or the wire grows a new kind
        // token, it is represented rather than refused.
        other => unknown(format!("{other}:{type_name}")),
    };
    Event { conv, kind }
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

    /// Unwrap the conversation half; panics make test failures readable.
    fn conv_event(subject: &str, payload: &[u8]) -> Event {
        match parse_wire(subject, payload) {
            Some(WireEvent::Conv(e)) => e,
            other => panic!("expected a conversation event, got {other:?}"),
        }
    }

    fn approval_event(subject: &str, payload: &[u8]) -> ApprovalEvent {
        match parse_wire(subject, payload) {
            Some(WireEvent::Approval(e)) => e,
            other => panic!("expected an approval event, got {other:?}"),
        }
    }

    #[test]
    fn change_message_parses() {
        let payload = br#"{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}"#;
        let event = conv_event("conv.v1.conv-abc.changes", payload);
        assert_eq!(event.conv, ConversationId("conv-abc".into()));
        let EventKind::Change(ConvChange::Message { id, role, .. }) = event.kind else {
            panic!("expected message");
        };
        assert_eq!(id.0, "m1");
        assert_eq!(role, "user");
    }

    #[test]
    fn telemetry_parses() {
        let payload = br#"{"type":"turn_ended","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","stopReason":"end_turn"}"#;
        let event = conv_event("conv.v1.conv-abc.telemetry", payload);
        let EventKind::Telemetry(ConvTelemetry::TurnEnded { stop_reason, .. }) = event.kind else {
            panic!("expected turn_ended");
        };
        assert_eq!(stop_reason, "end_turn");
    }

    #[test]
    fn delta_parses() {
        let event = conv_event(
            "conv.v1.conv-abc.deltas",
            br#"{"type":"delta","text":"File X contains"}"#,
        );
        assert_eq!(
            event.kind,
            EventKind::Delta(ConvDelta {
                text: "File X contains".into()
            })
        );
    }

    #[test]
    fn block_marker_parses() {
        let event = conv_event(
            "conv.v1.conv-abc.deltas",
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
    fn unknown_type_is_represented_with_ts() {
        let payload = br#"{"type":"vibe_shift","ts":"2026-07-07T21:00:00+10:00"}"#;
        let event = conv_event("conv.v1.conv-abc.telemetry", payload);
        assert_eq!(
            event.kind,
            EventKind::Unknown {
                label: "vibe_shift".into(),
                ts: Some("2026-07-07T21:00:00+10:00".into())
            }
        );
    }

    #[test]
    fn non_json_is_represented() {
        let event = conv_event("conv.v1.conv-abc.changes", b"not json");
        assert!(matches!(event.kind, EventKind::Unknown { .. }));
    }

    #[test]
    fn foreign_concern_is_not_ours() {
        assert_eq!(parse_wire("agent.v1.w-1.telemetry", b"{}"), None);
        assert_eq!(parse_wire("conv.v2.conv-abc.changes", b"{}"), None);
        assert_eq!(parse_wire("conv.v1", b"{}"), None);
        assert_eq!(parse_wire("conv.v1.a.changes.extra", b"{}"), None);
    }

    #[test]
    fn approval_lifecycle_parses() {
        // Scenario 6a's raised line, through the edge fold.
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

    #[test]
    fn approval_unknown_is_represented() {
        let event = approval_event("approval.v1.apr-1.lifecycle", b"not json");
        assert!(matches!(event.kind, ApprovalKind::Unknown { .. }));
    }
}
