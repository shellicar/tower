//! Bridge's own seam onto NATS — its own trait, not towerd's `Broker`
//! (towerd only ever requests; bridge is always the servicer, so it only
//! ever publishes, subscribes, and replays a JetStream backlog. No
//! `request` verb: every "reply" here is a `publish` to the sender's own
//! reply subject, never a `send_request`). The two traits can merge later
//! if they converge ("a seam appears when a second implementation
//! exists") — today they don't.
//!
//! Scoped to what request handling touches: `main.rs`'s spawn/adopt/revise
//! control lines, `agent.rs`'s request loop and event publisher, and
//! `approval.rs`'s gate. Tool execution, the Anthropic SSE client
//! (`anthropic::stream_turn` publishes conv deltas directly and stays on
//! the raw `async_nats::Client`), and the object-store attachment fetch
//! (`objects.rs`) are deliberately untouched — see the PR report for why.

use std::future::Future;

/// One inbound message off a subscription: the subject it arrived on, its
/// bytes, and the reply subject to answer on, if any (a request always
/// carries one; a broadcast-style subscribe like a delta tee never does).
#[derive(Debug, Clone, PartialEq)]
pub struct BrokerMessage {
    pub subject: String,
    pub payload: Vec<u8>,
    pub reply: Option<String>,
}

/// A live subscription: pull the next message, or `None` when the
/// subscription has ended (the broker dropped it, or — for a fake — the
/// scripted messages are exhausted).
pub trait BrokerSubscription: Send {
    fn next(&mut self) -> impl Future<Output = Option<BrokerMessage>> + Send;
}

pub trait Broker: Clone + Send + Sync + 'static {
    type Subscription: BrokerSubscription;

    fn publish(
        &self,
        subject: String,
        payload: Vec<u8>,
    ) -> impl Future<Output = Result<(), String>> + Send;

    fn subscribe(
        &self,
        subject: String,
    ) -> impl Future<Output = Result<Self::Subscription, String>> + Send;

    /// The full backlog of a JetStream capture stream, filtered to
    /// `filter_subject`, in stream order — adopt's replay. Bounded: reads
    /// exactly the backlog pending at consumer creation, once.
    fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> impl Future<Output = Result<Vec<BrokerMessage>, String>> + Send;
}

// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct NatsBroker {
    pub client: async_nats::Client,
}

pub struct NatsSubscription(async_nats::Subscriber);

impl BrokerSubscription for NatsSubscription {
    async fn next(&mut self) -> Option<BrokerMessage> {
        use futures::StreamExt;
        self.0.next().await.map(|m| BrokerMessage {
            subject: m.subject.to_string(),
            payload: m.payload.to_vec(),
            reply: m.reply.map(|r| r.to_string()),
        })
    }
}

impl Broker for NatsBroker {
    type Subscription = NatsSubscription;

    async fn publish(&self, subject: String, payload: Vec<u8>) -> Result<(), String> {
        self.client
            .publish(subject, payload.into())
            .await
            .map_err(|e| e.to_string())
    }

    async fn subscribe(&self, subject: String) -> Result<Self::Subscription, String> {
        self.client
            .subscribe(subject)
            .await
            .map(NatsSubscription)
            .map_err(|e| e.to_string())
    }

    async fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> Result<Vec<BrokerMessage>, String> {
        use futures::StreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let handle = js
            .get_stream(&stream)
            .await
            .map_err(|e| format!("capture stream {stream:?} unavailable: {e}"))?;
        let consumer = handle
            .create_consumer(async_nats::jetstream::consumer::pull::Config {
                filter_subject,
                deliver_policy: async_nats::jetstream::consumer::DeliverPolicy::All,
                ..Default::default()
            })
            .await
            .map_err(|e| e.to_string())?;
        // num_pending at creation is the full backlog: read exactly that many.
        let pending = consumer.cached_info().num_pending as usize;
        let mut out = Vec::with_capacity(pending);
        if pending == 0 {
            return Ok(out);
        }
        let mut batch = consumer
            .fetch()
            .max_messages(pending)
            .messages()
            .await
            .map_err(|e| e.to_string())?;
        while let Some(msg) = batch.next().await {
            let msg = msg.map_err(|e| format!("replay read failed: {e}"))?;
            out.push(BrokerMessage {
                subject: msg.subject.to_string(),
                payload: msg.payload.to_vec(),
                reply: None,
            });
        }
        Ok(out)
    }
}
