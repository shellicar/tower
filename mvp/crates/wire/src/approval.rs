//! The approval concern's message types (docs/spec/approval-spec.md,
//! "Message schemas — normative"). Same tolerance discipline as `conv`:
//! no `deny_unknown_fields`, unknown lifecycle types are represented, and
//! `ask`/`correlation`/`by` stay `serde_json::Value` — tower renders,
//! never interprets (ask types are an open set by design).

use serde::Deserialize;
use serde_json::{Value, json};

use crate::conv::KnownTypes;

// approval.v1.{approvalId}.lifecycle
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum ApprovalLifecycle {
    #[serde(rename = "raised")]
    Raised {
        ts: String,
        /// The ask, verbatim: `{ type, ... }` — `tool_use` carries name and
        /// input; unknown ask types still validate (add-only data inside a
        /// known message, per the spec).
        ask: Value,
        #[serde(default)]
        correlation: Option<Value>,
    },
    #[serde(rename = "settled")]
    Settled {
        ts: String,
        approved: bool,
        /// Pass-through provenance, verbatim.
        by: Value,
    },
}

impl KnownTypes for ApprovalLifecycle {
    const KNOWN: &'static [&'static str] = &["raised", "settled"];
}

impl ApprovalLifecycle {
    pub fn ts(&self) -> &str {
        match self {
            ApprovalLifecycle::Raised { ts, .. } | ApprovalLifecycle::Settled { ts, .. } => ts,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AnswerOutcome {
    Accepted,
    Rejected { reason: String },
    Unreachable,
}

// ---------------------------------------------------------------------------
// The holder direction: what an agent that raises asks publishes, and how it
// reads the answers addressed to it. The consumer side above folds these.
// ---------------------------------------------------------------------------

/// The raise: the ask verbatim (a `tool_use` ask carries name and input — an
/// ask is unreviewable without its payload) plus correlation to the work it
/// interrupts.
pub fn encode_raised(ask: &Value, correlation: &Value, ts: &str) -> Vec<u8> {
    let payload = json!({
        "type": "raised",
        "ts": ts,
        "ask": ask,
        "correlation": correlation,
    });
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

/// The settlement: `by` is pass-through provenance — the answerer's `from`,
/// echoed verbatim, never authored by the holder.
pub fn encode_settled(approved: bool, by: &Value, ts: &str) -> Vec<u8> {
    let payload = json!({
        "type": "settled",
        "ts": ts,
        "approved": approved,
        "by": by,
    });
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

/// The pending ask's own pulse (~15s while pending): raised + pulse =
/// pending; pulse silence = stale, displayed void. The ask asserts its own
/// liveness, whoever holds it.
pub fn encode_heartbeat(ts: &str) -> Vec<u8> {
    let payload = json!({ "type": "heartbeat", "ts": ts });
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

/// An answer as the holder reads it off `.requests`: `approved` is the
/// verdict, `from` the answerer's provenance (echoed onto `settled`).
/// `None` = not an intelligible answer — reply rejected, never crash: a
/// holder must answer everything addressed to it.
pub fn parse_answer(bytes: &[u8]) -> Option<(bool, Value)> {
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("answer") {
        return None;
    }
    let approved = value.get("approved").and_then(Value::as_bool)?;
    let from = value.get("from").cloned().unwrap_or(Value::Null);
    Some((approved, from))
}

/// The wire `answer`: `approved` verbatim, `from` stamped `{ kind: "human" }`
/// bare — tower knows a human clicked and, in v1, no more.
pub fn encode_answer(approved: bool, ts: &str) -> Vec<u8> {
    let payload = json!({
        "type": "answer",
        "ts": ts,
        "from": { "kind": "human" },
        "approved": approved,
    });
    serde_json::to_vec(&payload).expect("json! of plain values cannot fail")
}

/// Reply → outcome. Transport truth, never verdict; an unintelligible reply
/// is reported honestly rather than crashed on.
pub fn parse_answer_reply(bytes: &[u8]) -> AnswerOutcome {
    let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
        return AnswerOutcome::Rejected {
            reason: "unintelligible reply".into(),
        };
    };
    if value.get("accepted").and_then(Value::as_bool) == Some(true) {
        return AnswerOutcome::Accepted;
    }
    if value.get("rejected").and_then(Value::as_bool) == Some(true) {
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unspecified")
            .to_string();
        return AnswerOutcome::Rejected { reason };
    }
    AnswerOutcome::Rejected {
        reason: "unintelligible reply".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::conv::Tolerant;
    use serde_json::json;

    #[test]
    fn holder_side_meets_the_consumer_side() {
        // What the holder raises, the consumer parses — the two directions
        // meet on the wire.
        let ask = json!({ "type": "tool_use", "name": "Bash", "input": { "command": "echo hi" } });
        let correlation = json!({ "conversationId": "conv-abc", "queryId": "q1" });
        let bytes = encode_raised(&ask, &correlation, "2026-07-07T15:03:00+10:00");
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        let parsed = Tolerant::<ApprovalLifecycle>::parse(value).unwrap();
        assert!(matches!(
            parsed,
            Tolerant::Known(ApprovalLifecycle::Raised { ask: ref a, .. }) if a == &ask
        ));

        let by = json!({ "kind": "human", "userId": "stephen" });
        let bytes = encode_settled(false, &by, "2026-07-07T15:03:40+10:00");
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(matches!(
            Tolerant::<ApprovalLifecycle>::parse(value).unwrap(),
            Tolerant::Known(ApprovalLifecycle::Settled {
                approved: false,
                ..
            })
        ));

        // The holder reads what the gateway sends.
        let answer = encode_answer(true, "2026-07-07T15:03:38+10:00");
        let (approved, from) = parse_answer(&answer).unwrap();
        assert!(approved);
        assert_eq!(from, json!({ "kind": "human" }));

        // Non-answers are None, never a crash.
        assert!(parse_answer(b"not json").is_none());
        assert!(parse_answer(br#"{"type":"other"}"#).is_none());
    }

    #[test]
    fn raised_parses_with_ask_and_correlation_verbatim() {
        // Scenario 6a's raised line.
        let v = json!({
            "type": "raised", "ts": "2026-07-07T21:00:00+10:00",
            "ask": { "type": "tool_use", "name": "DeleteFile",
                     "input": { "content": { "type": "files", "values": ["./old.ts"] } } },
            "correlation": { "conversationId": "conv-abc", "queryId": "q2",
                             "turnId": "t3", "toolUseId": "toolu_02DEF" }
        });
        let parsed = Tolerant::<ApprovalLifecycle>::parse(v).unwrap();
        let Tolerant::Known(ApprovalLifecycle::Raised {
            ask, correlation, ..
        }) = parsed
        else {
            panic!("expected raised");
        };
        assert_eq!(ask["name"], "DeleteFile");
        assert_eq!(correlation.unwrap()["conversationId"], "conv-abc");
    }

    #[test]
    fn raised_without_correlation_is_lawful() {
        let v = json!({
            "type": "raised", "ts": "2026-07-07T21:00:00+10:00",
            "ask": { "type": "something_new" }
        });
        let parsed = Tolerant::<ApprovalLifecycle>::parse(v).unwrap();
        assert!(matches!(
            parsed,
            Tolerant::Known(ApprovalLifecycle::Raised {
                correlation: None,
                ..
            })
        ));
    }

    #[test]
    fn settled_parses_with_by_verbatim() {
        let v = json!({
            "type": "settled", "ts": "2026-07-07T21:00:00+10:00",
            "approved": true, "by": { "kind": "human", "userId": "stephen" }
        });
        let parsed = Tolerant::<ApprovalLifecycle>::parse(v).unwrap();
        let Tolerant::Known(ApprovalLifecycle::Settled { approved, by, .. }) = parsed else {
            panic!("expected settled");
        };
        assert!(approved);
        assert_eq!(by["userId"], "stephen");
    }

    #[test]
    fn answer_encodes_the_spec_shape() {
        let v: Value =
            serde_json::from_slice(&encode_answer(false, "2026-07-07T21:00:00+10:00")).unwrap();
        assert_eq!(v["type"], "answer");
        assert_eq!(v["approved"], false);
        assert_eq!(v["from"], json!({ "kind": "human" }));
    }

    #[test]
    fn answer_replies_parse_honestly() {
        assert_eq!(
            parse_answer_reply(br#"{"accepted":true}"#),
            AnswerOutcome::Accepted
        );
        assert_eq!(
            parse_answer_reply(br#"{"rejected":true,"reason":"already_settled"}"#),
            AnswerOutcome::Rejected {
                reason: "already_settled".into()
            }
        );
        assert!(matches!(
            parse_answer_reply(b"not json"),
            AnswerOutcome::Rejected { .. }
        ));
    }
}
