//! Bridge's own seam onto NATS — its own trait, not towerd's `Broker`
//! (towerd only ever requests; bridge is always the servicer, so it only
//! ever publishes, subscribes, replays a JetStream backlog, and fetches an
//! attachment out of the transit object store. No `request` verb: every
//! "reply" here is a `publish` to the sender's own reply subject, never a
//! `send_request`). The two traits can merge later if they converge ("a
//! seam appears when a second implementation exists") — today they don't.
//!
//! Scoped to what request handling touches: `main.rs`'s spawn/adopt/revise
//! control lines, `agent.rs`'s request loop and event publisher,
//! `approval.rs`'s gate, and `objects.rs`'s attachment fetch (widened onto
//! this seam once a test needed to reach it). The Anthropic SSE client's own
//! delta-publish is deliberately NOT here — see `anthropic::DeltaSink`, its
//! own narrow boundary, since a turn's delta stream is not request-handling
//! traffic even though it shares a transport in production.

use std::future::Future;

/// One inbound message off a subscription or a replay: the subject it
/// arrived on, its bytes, and the reply subject to answer on, if any (a
/// request always carries one; a broadcast-style subscribe or a replayed
/// frame never does).
#[derive(Debug, Clone, PartialEq)]
pub struct BrokerMessage {
    pub subject: String,
    pub payload: Vec<u8>,
    pub reply: Option<String>,
}

/// The seam's own error type: every operation names what it was doing, and
/// carries its cause (`#[source]`) so the chain survives through `?` and
/// `anyhow` rather than flattening to a message-only string.
#[derive(Debug, thiserror::Error)]
pub enum BrokerError {
    #[error("publish failed")]
    Publish(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("subscribe failed")]
    Subscribe(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("capture stream {stream:?} unavailable")]
    StreamUnavailable {
        stream: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("replay consumer setup failed")]
    ReplaySetup(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("replay read failed")]
    ReplayRead(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("attachment reference carries no id")]
    ObjectNoId,
    #[error("attachment reference carries no bucket")]
    ObjectNoBucket,
    #[error("no object store client configured")]
    ObjectStoreAbsent,
    #[error("object store {bucket:?} unavailable")]
    ObjectStoreUnavailable {
        bucket: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("attachment {id:?} not found in {bucket:?}")]
    ObjectNotFound {
        id: String,
        bucket: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("attachment {id:?} read failed")]
    ObjectReadFailed {
        id: String,
        #[source]
        source: std::io::Error,
    },
    /// A fake's own scripted failure — never produced by `NatsBroker`.
    #[error("{0}")]
    Fake(String),
}

/// A live subscription: pull the next message, or `None` when it has ended
/// (the broker dropped it, or — for a fake — the scripted messages are used
/// up). Ordinary pub/sub delivery has no per-message failure mode; a
/// dropped connection just ends the stream.
pub trait BrokerSubscription: Send {
    fn next(&mut self) -> impl Future<Output = Option<BrokerMessage>> + Send;
}

/// A replay's own source: unlike a subscription, a read can fail mid-
/// backlog, and that must never be indistinguishable from the backlog
/// simply ending — an adopt missing its tail because a read error was
/// swallowed is worse than an adopt that fails outright.
pub trait BrokerReplay: Send {
    fn next(&mut self) -> impl Future<Output = Option<Result<BrokerMessage, BrokerError>>> + Send;
}

pub trait Broker: Clone + Send + Sync + 'static {
    type Subscription: BrokerSubscription;
    type Replay: BrokerReplay;

    fn publish(
        &self,
        subject: String,
        payload: Vec<u8>,
    ) -> impl Future<Output = Result<(), BrokerError>> + Send;

    fn subscribe(
        &self,
        subject: String,
    ) -> impl Future<Output = Result<Self::Subscription, BrokerError>> + Send;

    /// Open a JetStream capture stream's backlog, filtered to
    /// `filter_subject`, in stream order — adopt's replay. Bounded: the
    /// returned source yields exactly the backlog pending at consumer
    /// creation, once; an empty backlog yields a source that ends
    /// immediately rather than reaching for the underlying client at all.
    fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> impl Future<Output = Result<Self::Replay, BrokerError>> + Send;

    /// Fetch one attachment's bytes from the transit object store
    /// (objects.rs's `fetch_object`/`resolve_history`/`validate_fresh`) —
    /// bucket and id in, bytes out; the caller already knows the media type
    /// from the reference block itself.
    fn fetch_object(
        &self,
        bucket: String,
        id: String,
    ) -> impl Future<Output = Result<Vec<u8>, BrokerError>> + Send;
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

/// Whether an empty backlog is worth reaching for the client at all — pure,
/// so the guard against calling `fetch().max_messages(0)` (unproven
/// semantics; never exercised pre-refactor either, since the old code took
/// the same `pending == 0` early return) is provable without a live broker.
#[derive(Debug, PartialEq)]
enum ReplayPlan {
    Empty,
    Fetch(usize),
}

fn replay_plan(pending: usize) -> ReplayPlan {
    if pending == 0 {
        ReplayPlan::Empty
    } else {
        ReplayPlan::Fetch(pending)
    }
}

/// A replay's live source: either nothing was pending at consumer creation
/// (`Empty`, ending immediately), or the JetStream pull consumer's own
/// message stream, mapped frame by frame. A read failure is surfaced, not
/// swallowed — `Some(Err(_))`, never folded into "the backlog ended".
pub enum NatsReplay {
    Empty,
    Batch(Box<async_nats::jetstream::consumer::pull::Batch>),
}

impl BrokerReplay for NatsReplay {
    async fn next(&mut self) -> Option<Result<BrokerMessage, BrokerError>> {
        use futures::StreamExt;
        match self {
            NatsReplay::Empty => None,
            NatsReplay::Batch(batch) => {
                let msg = batch.next().await?;
                Some(match msg {
                    Ok(msg) => Ok(BrokerMessage {
                        subject: msg.subject.to_string(),
                        payload: msg.payload.to_vec(),
                        reply: None,
                    }),
                    // Batch's Item error is already `async_nats::Error`
                    // (`Box<dyn Error + Send + Sync>`) — no double-boxing.
                    Err(e) => Err(BrokerError::ReplayRead(e)),
                })
            }
        }
    }
}

impl Broker for NatsBroker {
    type Subscription = NatsSubscription;
    type Replay = NatsReplay;

    async fn publish(&self, subject: String, payload: Vec<u8>) -> Result<(), BrokerError> {
        self.client
            .publish(subject, payload.into())
            .await
            .map_err(|e| BrokerError::Publish(Box::new(e)))
    }

    async fn subscribe(&self, subject: String) -> Result<Self::Subscription, BrokerError> {
        self.client
            .subscribe(subject)
            .await
            .map(NatsSubscription)
            .map_err(|e| BrokerError::Subscribe(Box::new(e)))
    }

    async fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> Result<Self::Replay, BrokerError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let handle = js
            .get_stream(&stream)
            .await
            .map_err(|e| BrokerError::StreamUnavailable {
                stream: stream.clone(),
                source: Box::new(e),
            })?;
        let consumer = handle
            .create_consumer(async_nats::jetstream::consumer::pull::Config {
                filter_subject,
                deliver_policy: async_nats::jetstream::consumer::DeliverPolicy::All,
                // Ephemeral (no durable_name): explicit, not the crate
                // default reached by omission, since this is now a trait
                // contract — the server reclaims it if a replay is ever
                // abandoned mid-adopt (a crash between creation and drain).
                inactive_threshold: std::time::Duration::from_secs(30),
                ..Default::default()
            })
            .await
            .map_err(|e| BrokerError::ReplaySetup(Box::new(e)))?;
        // num_pending at creation is the full backlog. An empty one never
        // reaches for `fetch().max_messages(0)` — its semantics are
        // unproven here and untested pre-refactor too, since the old code
        // took this same early return before ever calling fetch.
        let pending = consumer.cached_info().num_pending as usize;
        match replay_plan(pending) {
            ReplayPlan::Empty => Ok(NatsReplay::Empty),
            ReplayPlan::Fetch(pending) => {
                let messages = consumer
                    .fetch()
                    .max_messages(pending)
                    .messages()
                    .await
                    .map_err(|e| BrokerError::ReplaySetup(Box::new(e)))?;
                Ok(NatsReplay::Batch(Box::new(messages)))
            }
        }
    }

    async fn fetch_object(&self, bucket: String, id: String) -> Result<Vec<u8>, BrokerError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js.get_object_store(&bucket).await.map_err(|e| {
            BrokerError::ObjectStoreUnavailable {
                bucket: bucket.clone(),
                source: Box::new(e),
            }
        })?;
        let mut object = store
            .get(&id)
            .await
            .map_err(|e| BrokerError::ObjectNotFound {
                id: id.clone(),
                bucket: bucket.clone(),
                source: Box::new(e),
            })?;
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        object
            .read_to_end(&mut bytes)
            .await
            .map_err(|source| BrokerError::ObjectReadFailed { id, source })?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::{ReplayPlan, replay_plan};

    #[test]
    fn replay_plan_is_empty_when_nothing_is_pending() {
        assert_eq!(replay_plan(0), ReplayPlan::Empty);
    }

    #[test]
    fn replay_plan_fetches_the_pending_count_otherwise() {
        assert_eq!(replay_plan(5), ReplayPlan::Fetch(5));
    }
}
