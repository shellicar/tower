//! The edge fold: one wire frame (concrete subject + payload bytes) → one
//! `Event`. The subject is parsed here, once — nothing inward of this
//! function sees a subject string. Tolerance throughout: an unknown kind
//! token, an unknown message type, or an unparseable payload each become a
//! represented state, never an error — ingest must survive anything the wire
//! grows.

use serde_json::Value;

use crate::conv::{ConvChange, ConvDelta, ConvTelemetry, Tolerant};
use crate::ids::ConversationId;

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
    /// Anything the wire says that this build doesn't model: an unknown kind
    /// token, an unknown `type`, a misshaped known type, non-JSON bytes.
    /// Carried, not dropped — the staleness fold still counts it as a touch
    /// when a `ts` is readable; `label` names what it was for `lastKind`.
    Unknown {
        label: String,
        ts: Option<String>,
    },
}

/// `conv.v1.{conversationId}.{kind}` → Event. `None` = not conversation
/// traffic (a foreign concern, a malformed subject): not tower's to represent,
/// the caller skips the frame.
pub fn parse_wire(subject: &str, payload: &[u8]) -> Option<Event> {
    let mut parts = subject.split('.');
    let (concern, version, id, kind) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    if concern != "conv" || version != "v1" || id.is_empty() || parts.next().is_some() {
        return None;
    }
    let conv = ConversationId(id.to_string());

    let value: Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => {
            return Some(Event {
                conv,
                kind: EventKind::Unknown {
                    label: format!("{kind}:unparseable"),
                    ts: None,
                },
            });
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
        "deltas" => match serde_json::from_value::<ConvDelta>(value) {
            Ok(d) if type_name == "delta" => EventKind::Delta(d),
            _ => unknown(type_name),
        },
        // `.requests` never reaches ingest (streams capture event subjects
        // only); if a frame arrives anyway, or the wire grows a new kind
        // token, it is represented rather than refused.
        other => unknown(format!("{other}:{type_name}")),
    };
    Some(Event { conv, kind })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn change_message_parses() {
        let payload = br#"{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}"#;
        let event = parse_wire("conv.v1.conv-abc.changes", payload).unwrap();
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
        let event = parse_wire("conv.v1.conv-abc.telemetry", payload).unwrap();
        let EventKind::Telemetry(ConvTelemetry::TurnEnded { stop_reason, .. }) = event.kind else {
            panic!("expected turn_ended");
        };
        assert_eq!(stop_reason, "end_turn");
    }

    #[test]
    fn delta_parses() {
        let event = parse_wire(
            "conv.v1.conv-abc.deltas",
            br#"{"type":"delta","text":"File X contains"}"#,
        )
        .unwrap();
        assert_eq!(
            event.kind,
            EventKind::Delta(ConvDelta {
                text: "File X contains".into()
            })
        );
    }

    #[test]
    fn unknown_type_is_represented_with_ts() {
        let payload = br#"{"type":"vibe_shift","ts":"2026-07-07T21:00:00+10:00"}"#;
        let event = parse_wire("conv.v1.conv-abc.telemetry", payload).unwrap();
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
        let event = parse_wire("conv.v1.conv-abc.changes", b"not json").unwrap();
        assert!(matches!(event.kind, EventKind::Unknown { .. }));
    }

    #[test]
    fn foreign_concern_is_not_ours() {
        assert_eq!(parse_wire("approval.v1.apr-1.lifecycle", b"{}"), None);
        assert_eq!(parse_wire("conv.v2.conv-abc.changes", b"{}"), None);
        assert_eq!(parse_wire("conv.v1", b"{}"), None);
        assert_eq!(parse_wire("conv.v1.a.changes.extra", b"{}"), None);
    }
}
