//! The say gateway (tower-v1-design.md, Gateway): an async shell around
//! wire's pure encode/parse.
//!
//! - No retry: the human re-sends; an automatic retry could double-send.
//! - Timeout/no-responders fold to `Unreachable`; distinguishing them would
//!   invent meaning.

use std::time::Duration;

use wire::{SayCommand, SayOutcome, encode_say, parse_say_reply};

use crate::broker::{Broker, BrokerReply, Clock};

pub async fn say<B: Broker, C: Clock>(broker: &B, clock: &C, cmd: SayCommand) -> SayOutcome {
    let subject = format!("conv.v1.{}.requests", cmd.conv.0);
    let payload = encode_say(&cmd, &clock.now_iso());
    match broker
        .request(&subject, payload, Duration::from_secs(5))
        .await
    {
        BrokerReply::Data(bytes) => parse_say_reply(&bytes),
        BrokerReply::Timeout | BrokerReply::NoResponders => SayOutcome::Unreachable,
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
        assert_eq!(seen[0].0, "conv.v1.conv-abc.requests");
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
}
