//! The say gateway (tower-v1-design.md, Gateway): an async shell around
//! wire's pure encode/parse.
//!
//! - No retry: the human re-sends; an automatic retry could double-send.
//! - Timeout/no-responders fold to `Unreachable`; distinguishing them would
//!   invent meaning.

use std::time::Duration;

use wire::{
    AnswerOutcome, ApprovalId, SayCommand, SayOutcome, encode_answer, encode_say,
    parse_answer_reply, parse_say_reply,
};

use crate::broker::{Broker, BrokerReply, Clock};

pub async fn say<B: Broker, C: Clock>(broker: &B, clock: &C, cmd: SayCommand) -> SayOutcome {
    // v2: the leaf spells the operation; the body carries no type.
    let subject = format!("conv.v2.{}.requests.say", cmd.conv.0);
    let payload = encode_say(&cmd, &clock.now_iso());
    match broker
        .request(&subject, payload, Duration::from_secs(5))
        .await
    {
        BrokerReply::Data(bytes) => parse_say_reply(&bytes),
        BrokerReply::Timeout | BrokerReply::NoResponders => SayOutcome::Unreachable,
    }
}

/// `say`'s sibling: answer a pending approval. Same disciplines — no retry
/// (a double answer would race itself; `already_settled` is the honest loss),
/// transport silence folds to unreachable.
pub async fn answer<B: Broker, C: Clock>(
    broker: &B,
    clock: &C,
    approval: &ApprovalId,
    approved: bool,
) -> AnswerOutcome {
    let subject = format!("approval.v1.{}.requests", approval.0);
    let payload = encode_answer(approved, &clock.now_iso());
    match broker
        .request(&subject, payload, Duration::from_secs(5))
        .await
    {
        BrokerReply::Data(bytes) => parse_answer_reply(&bytes),
        BrokerReply::Timeout | BrokerReply::NoResponders => AnswerOutcome::Unreachable,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use wire::{ConversationId, MessageId, QueryId};

    type Seen = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

    /// The only fake in the tests is the Broker.
    #[derive(Clone)]
    struct FakeBroker {
        reply: BrokerReply,
        seen: Seen,
    }

    impl Broker for FakeBroker {
        async fn request(&self, subject: &str, payload: Vec<u8>, _t: Duration) -> BrokerReply {
            self.seen
                .lock()
                .unwrap()
                .push((subject.to_string(), payload));
            self.reply.clone()
        }
    }

    #[derive(Clone)]
    struct FixedClock;
    impl Clock for FixedClock {
        fn now_iso(&self) -> String {
            "2026-07-07T21:00:00+10:00".into()
        }
    }

    fn cmd() -> SayCommand {
        SayCommand {
            conv: ConversationId("conv-abc".into()),
            text: "okay, delete it".into(),
            tip: Some(MessageId("m4".into())),
        }
    }

    #[tokio::test]
    async fn addresses_the_conversation_and_parses_acceptance() {
        let broker = FakeBroker {
            reply: BrokerReply::Data(br#"{"accepted":true,"id":"q7"}"#.to_vec()),
            seen: Arc::default(),
        };
        let outcome = say(&broker, &FixedClock, cmd()).await;
        assert_eq!(
            outcome,
            SayOutcome::Accepted {
                query: QueryId("q7".into())
            }
        );

        let seen = broker.seen.lock().unwrap();
        assert_eq!(seen[0].0, "conv.v2.conv-abc.requests.say");
        let v: serde_json::Value = serde_json::from_slice(&seen[0].1).unwrap();
        assert_eq!(v["precondition"]["tip"], "m4");
        assert_eq!(v["from"], serde_json::json!({ "kind": "human" }));
    }

    #[tokio::test]
    async fn transport_silence_is_unreachable() {
        for reply in [BrokerReply::Timeout, BrokerReply::NoResponders] {
            let broker = FakeBroker {
                reply,
                seen: Arc::default(),
            };
            assert_eq!(
                say(&broker, &FixedClock, cmd()).await,
                SayOutcome::Unreachable
            );
        }
    }

    #[tokio::test]
    async fn answer_addresses_the_approval_and_parses_the_reply() {
        let broker = FakeBroker {
            reply: BrokerReply::Data(br#"{"rejected":true,"reason":"already_settled"}"#.to_vec()),
            seen: Arc::default(),
        };
        let outcome = answer(&broker, &FixedClock, &ApprovalId("apr-9f3".into()), true).await;
        assert_eq!(
            outcome,
            AnswerOutcome::Rejected {
                reason: "already_settled".into()
            }
        );

        let seen = broker.seen.lock().unwrap();
        assert_eq!(seen[0].0, "approval.v1.apr-9f3.requests");
        let v: serde_json::Value = serde_json::from_slice(&seen[0].1).unwrap();
        assert_eq!(v["type"], "answer");
        assert_eq!(v["approved"], true);
        assert_eq!(v["from"], serde_json::json!({ "kind": "human" }));
    }

    #[tokio::test]
    async fn answer_transport_silence_is_unreachable() {
        let broker = FakeBroker {
            reply: BrokerReply::NoResponders,
            seen: Arc::default(),
        };
        assert_eq!(
            answer(&broker, &FixedClock, &ApprovalId("apr-1".into()), false).await,
            AnswerOutcome::Unreachable
        );
    }
}
