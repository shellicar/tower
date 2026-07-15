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
    /// Reference blocks, verbatim (conversation-spec, `attachments`): bytes
    /// never ride a subject; the servicer resolves at its own edge.
    pub attachments: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SayOutcome {
    Accepted { query: QueryId },
    Rejected { reason: String },
    Unreachable,
}

/// The wire `say`: `from` stamped `{ kind: "human" }` bare — towerd knows a
/// human clicked and, in v1, no more; fabricating a userId is non-compliant.
/// v2: the subject leaf (`requests.say`) spells the type; the body carries
/// none (the discriminator lives in one place).
pub fn encode_say(cmd: &SayCommand, ts: &str) -> Vec<u8> {
    let mut payload = json!({
        "ts": ts,
        "from": { "kind": "human" },
        "text": cmd.text,
        "precondition": { "tip": cmd.tip.as_ref().map(|t| t.0.as_str()) },
    });
    if !cmd.attachments.is_empty() {
        payload["attachments"] = json!(cmd.attachments);
    }
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

/// The wire `cancel`: revoke a running query by its id — the id is the
/// cancel's premise (conversation-spec, Requests). `from` stamped
/// `{ kind: "human" }` bare, exactly as `say`. v2: the leaf
/// (`requests.cancel`) spells the type; the body carries none.
pub fn encode_cancel(query: &QueryId, ts: &str) -> Vec<u8> {
    let payload = json!({
        "ts": ts,
        "from": { "kind": "human" },
        "id": query.0,
    });
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

/// Reply → outcome for `cancel`. Same three-way honesty as `say`, but
/// acceptance mints nothing: `accepted` carries no id.
pub fn parse_cancel_reply(bytes: &[u8]) -> CancelOutcome {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return CancelOutcome::Rejected {
            reason: "unintelligible reply".into(),
        };
    };
    if value.get("accepted").and_then(Value::as_bool) == Some(true) {
        return CancelOutcome::Accepted;
    }
    if value.get("rejected").and_then(Value::as_bool) == Some(true) {
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .to_string();
        return CancelOutcome::Rejected { reason };
    }
    CancelOutcome::Rejected {
        reason: "unintelligible reply".into(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CancelOutcome {
    Accepted,
    Rejected { reason: String },
    Unreachable,
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
        /// Reference blocks, verbatim; empty when the say carried none.
        attachments: Vec<Value>,
    },
    Cancel {
        query: QueryId,
        from: serde_json::Value,
    },
    /// Anything else — answered `unsupported`, carrying the leaf for logs.
    Other { type_name: String },
}

/// (leaf, bytes) → request. v2: the subject leaf spells the operation
/// (`conv.v2.{id}.requests.say` → `"say"`), the body carries no type — the
/// explicit leaf→variant match, exactly as ingest parses events. Unparseable
/// bytes are `Other` (answered `unsupported`): a servicer must answer
/// everything addressed to it.
pub fn parse_request(leaf: &str, bytes: &[u8]) -> ConvRequest {
    let type_name = leaf.to_string();
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return ConvRequest::Other { type_name };
    };
    let from = value.get("from").cloned().unwrap_or(Value::Null);
    match leaf {
        "say" => {
            let Some(text) = value.get("text").and_then(Value::as_str) else {
                return ConvRequest::Other { type_name };
            };
            let tip = value
                .get("precondition")
                .and_then(|p| p.get("tip"))
                .and_then(Value::as_str)
                .map(|t| MessageId(t.to_string()));
            // Verbatim: the servicer decides what a source kind means.
            let attachments = value
                .get("attachments")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            ConvRequest::Say {
                text: text.to_string(),
                tip,
                from,
                attachments,
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
            attachments: Vec::new(),
        }
    }

    #[test]
    fn encodes_the_fixture_shape() {
        let bytes = encode_say(&cmd(Some("m4")), "2026-07-07T21:00:00+10:00");
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        // v2: no body type — the subject leaf (`requests.say`) spells it.
        assert!(v.get("type").is_none());
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
        let ConvRequest::Say {
            text,
            tip,
            from,
            attachments,
        } = parse_request("say", &bytes)
        else {
            panic!("expected say");
        };
        assert_eq!(text, "okay, delete it");
        assert_eq!(tip, Some(MessageId("m4".into())));
        assert_eq!(from, serde_json::json!({ "kind": "human" }));
        assert!(attachments.is_empty());

        // Attachments ride verbatim, both directions.
        let mut with_attach = cmd(Some("m4"));
        with_attach.attachments = vec![serde_json::json!({
            "type": "image",
            "source": { "type": "object", "id": "att-1", "mediaType": "image/png", "size": 42 }
        })];
        let bytes = encode_say(&with_attach, "2026-07-07T21:00:00+10:00");
        let ConvRequest::Say { attachments, .. } = parse_request("say", &bytes) else {
            panic!("expected say");
        };
        assert_eq!(attachments, with_attach.attachments);

        // Null tip decodes as the empty-conversation premise.
        let bytes = encode_say(&cmd(None), "2026-07-07T21:00:00+10:00");
        assert!(matches!(
            parse_request("say", &bytes),
            ConvRequest::Say { tip: None, .. }
        ));

        // Cancel, and the unsupported fallback (an unknown leaf is still
        // answered; the body needs no type to say so).
        let cancel = br#"{"ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human"},"id":"q2"}"#;
        assert!(matches!(
            parse_request("cancel", cancel),
            ConvRequest::Cancel { query: QueryId(q), .. } if q == "q2"
        ));
        assert!(matches!(
            parse_request("revise", br#"{"ts":"2026-07-07T21:00:00+10:00"}"#),
            ConvRequest::Other { .. }
        ));
        assert!(matches!(
            parse_request("say", b"not json"),
            ConvRequest::Other { .. }
        ));
    }

    #[test]
    fn cancel_encodes_and_both_directions_meet() {
        let bytes = encode_cancel(&QueryId("q7".into()), "2026-07-07T21:00:00+10:00");
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        // v2: no body type; the leaf (`requests.cancel`) spells it.
        assert!(v.get("type").is_none());
        assert_eq!(v["id"], "q7");
        assert_eq!(v["from"], serde_json::json!({ "kind": "human" }));

        // The servicer parses what the client encoded.
        assert!(matches!(
            parse_request("cancel", &bytes),
            ConvRequest::Cancel { query: QueryId(q), .. } if q == "q7"
        ));

        // Replies fold to the three-way outcome.
        assert_eq!(
            parse_cancel_reply(&encode_accepted(None)),
            CancelOutcome::Accepted
        );
        assert_eq!(
            parse_cancel_reply(&encode_rejected("already_complete")),
            CancelOutcome::Rejected {
                reason: "already_complete".into()
            }
        );
        assert!(matches!(
            parse_cancel_reply(b"not json"),
            CancelOutcome::Rejected { .. }
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
