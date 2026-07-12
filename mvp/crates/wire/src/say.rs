//! The `say` request and its reply (conversation-spec, Requests). Encoding is
//! a pure function so the gateway stays an async shell around it.

use serde_json::{Value, json};

use crate::ids::{ConversationId, MessageId, QueryId};

/// sessions → broker. `tip` is the *client's* view of the latest message id —
/// the premise belongs to the sender, forwarded verbatim; `None` is the claim
/// "this conversation is empty" and is encoded as `tip: null`, never omitted
/// (there is no anchor-free case).
#[derive(Debug, Clone, PartialEq)]
pub struct SayCommand {
    pub conv: ConversationId,
    pub text: String,
    pub tip: Option<MessageId>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SayOutcome {
    Accepted { query: QueryId },
    Rejected { reason: String },
    Unreachable,
}

/// The wire `say`: `from` stamped `{ kind: "human" }` bare — towerd knows a
/// human clicked and, in v1, no more; fabricating a userId is non-compliant.
pub fn encode_say(cmd: &SayCommand, ts: &str) -> Vec<u8> {
    let payload = json!({
        "type": "say",
        "ts": ts,
        "from": { "kind": "human" },
        "text": cmd.text,
        "precondition": { "tip": cmd.tip.as_ref().map(|t| t.0.as_str()) },
    });
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

/// Reply → outcome. A reply that fits neither shape is a servicer speaking a
/// newer contract; honesty is "rejected, reason unintelligible", not a crash.
pub fn parse_say_reply(bytes: &[u8]) -> SayOutcome {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return SayOutcome::Rejected {
            reason: "unintelligible reply".into(),
        };
    };
    if value.get("accepted").and_then(Value::as_bool) == Some(true) {
        // `id` is what acceptance minted — the query. Absent id is a servicer
        // bug we surface honestly rather than inventing an id.
        return match value.get("id").and_then(Value::as_str) {
            Some(id) => SayOutcome::Accepted {
                query: QueryId(id.to_string()),
            },
            None => SayOutcome::Rejected {
                reason: "accepted without id".into(),
            },
        };
    }
    if value.get("rejected").and_then(Value::as_bool) == Some(true) {
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .to_string();
        return SayOutcome::Rejected { reason };
    }
    SayOutcome::Rejected {
        reason: "unintelligible reply".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn cmd(tip: Option<&str>) -> SayCommand {
        SayCommand {
            conv: ConversationId("conv-abc".into()),
            text: "okay, delete it".into(),
            tip: tip.map(|t| MessageId(t.into())),
        }
    }

    #[test]
    fn encodes_the_fixture_shape() {
        let bytes = encode_say(&cmd(Some("m4")), "2026-07-07T21:00:00+10:00");
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["type"], "say");
        assert_eq!(v["from"], serde_json::json!({ "kind": "human" }));
        assert_eq!(v["text"], "okay, delete it");
        assert_eq!(v["precondition"]["tip"], "m4");
    }

    #[test]
    fn empty_conversation_states_tip_null() {
        let bytes = encode_say(&cmd(None), "2026-07-07T21:00:00+10:00");
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(v["precondition"].get("tip").unwrap().is_null());
    }

    #[test]
    fn parses_accepted() {
        assert_eq!(
            parse_say_reply(br#"{"accepted":true,"id":"q7"}"#),
            SayOutcome::Accepted {
                query: QueryId("q7".into())
            }
        );
    }

    #[test]
    fn parses_rejected() {
        assert_eq!(
            parse_say_reply(br#"{"rejected":true,"reason":"stale"}"#),
            SayOutcome::Rejected {
                reason: "stale".into()
            }
        );
    }

    #[test]
    fn tolerates_garbage_replies() {
        for bytes in [
            &b"not json"[..],
            br#"{"shrug":true}"#,
            br#"{"accepted":true}"#,
        ] {
            assert!(matches!(
                parse_say_reply(bytes),
                SayOutcome::Rejected { .. }
            ));
        }
    }
}
