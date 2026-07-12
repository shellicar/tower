//! The `say` request and its reply (conversation-spec, Requests). Encoding is
//! a pure function so the gateway stays an async shell around it.

use serde_json::{Value, json};

use crate::ids::{ConversationId, MessageId, QueryId};

// (Client direction first, servicer direction below.)

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

// ---------------------------------------------------------------------------
// The servicer direction: what a bridge agent reads off `.requests` and how
// it answers. The inverse of the client half above, same tolerance: an
// unknown operation is answered `rejected: unsupported`, never dropped —
// compliance is answering.

/// A request as the servicer sees it. `from` is provenance, verbatim.
#[derive(Debug, Clone, PartialEq)]
pub enum ConvRequest {
    Say {
        text: String,
        /// The sender's premise: the tip they believe is latest (None = "the
        /// conversation is empty").
        tip: Option<MessageId>,
        from: serde_json::Value,
    },
    Cancel {
        query: QueryId,
        from: serde_json::Value,
    },
    /// Anything else — answered `unsupported`, carrying the type for logs.
    Other { type_name: String },
}

/// Bytes → request. Unparseable bytes are `Other` (answered `unsupported`):
/// a servicer must answer everything addressed to it.
pub fn parse_request(bytes: &[u8]) -> ConvRequest {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return ConvRequest::Other {
            type_name: "unparseable".into(),
        };
    };
    let type_name = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("?")
        .to_string();
    let from = value.get("from").cloned().unwrap_or(Value::Null);
    match type_name.as_str() {
        "say" => {
            let Some(text) = value.get("text").and_then(Value::as_str) else {
                return ConvRequest::Other { type_name };
            };
            let tip = value
                .get("precondition")
                .and_then(|p| p.get("tip"))
                .and_then(Value::as_str)
                .map(|t| MessageId(t.to_string()));
            ConvRequest::Say {
                text: text.to_string(),
                tip,
                from,
            }
        }
        "cancel" => match value.get("id").and_then(Value::as_str) {
            Some(id) => ConvRequest::Cancel {
                query: QueryId(id.to_string()),
                from,
            },
            None => ConvRequest::Other { type_name },
        },
        _ => ConvRequest::Other { type_name },
    }
}

/// `{ accepted: true }`, with the minted id when acceptance mints one.
pub fn encode_accepted(id: Option<&str>) -> Vec<u8> {
    let payload = match id {
        Some(id) => json!({ "accepted": true, "id": id }),
        None => json!({ "accepted": true }),
    };
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

pub fn encode_rejected(reason: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({ "rejected": true, "reason": reason }))
        .expect("json! of plain values cannot fail")
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
    fn requests_parse_both_directions() {
        // The client encoder and the servicer parser meet in the middle.
        let bytes = encode_say(&cmd(Some("m4")), "2026-07-07T21:00:00+10:00");
        let ConvRequest::Say { text, tip, from } = parse_request(&bytes) else {
            panic!("expected say");
        };
        assert_eq!(text, "okay, delete it");
        assert_eq!(tip, Some(MessageId("m4".into())));
        assert_eq!(from, serde_json::json!({ "kind": "human" }));

        // Null tip decodes as the empty-conversation premise.
        let bytes = encode_say(&cmd(None), "2026-07-07T21:00:00+10:00");
        assert!(matches!(
            parse_request(&bytes),
            ConvRequest::Say { tip: None, .. }
        ));

        // Cancel, and the unsupported fallback.
        let cancel = br#"{"type":"cancel","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human"},"id":"q2"}"#;
        assert!(matches!(
            parse_request(cancel),
            ConvRequest::Cancel { query: QueryId(q), .. } if q == "q2"
        ));
        assert!(matches!(
            parse_request(br#"{"type":"revise"}"#),
            ConvRequest::Other { .. }
        ));
        assert!(matches!(
            parse_request(b"not json"),
            ConvRequest::Other { .. }
        ));
    }

    #[test]
    fn replies_round_trip() {
        assert_eq!(
            parse_say_reply(&encode_accepted(Some("q7"))),
            SayOutcome::Accepted {
                query: QueryId("q7".into())
            }
        );
        assert_eq!(
            parse_say_reply(&encode_rejected("stale")),
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
