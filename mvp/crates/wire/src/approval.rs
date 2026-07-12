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
