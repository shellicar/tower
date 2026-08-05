//! The seam onto NATS for everything that services conversations or watches
//! them: bridge itself, and the lookout. Still not towerd's `Broker`, which
//! is a browser gateway and only ever requests; the two can merge later if
//! they converge ("a seam appears when a second implementation exists").
//!
//! Bridge is always the servicer, so it only publishes, subscribes, replays
//! a JetStream backlog, and fetches an attachment out of the transit object
//! store. The lookout is the second consumer, and it is a client rather than
//! a servicer, which is where `request`, `last_on_subject`, `kv_entries` and
//! `durable` come from: it reads the reporting lines out of a KV bucket,
//! tails each worker through a durable consumer whose cursor survives a
//! restart, reads a handler's tip to anchor a say, and sends that say as a
//! request expecting an ack.
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
/// frame never does). `payload` is the same ref-counted `Bytes` async-nats
/// and JetStream already hand back — a replayed frame can run to ~17.8 MB
/// (workload facts), so cloning it across the seam must stay a cheap
/// refcount bump, never a copy.
#[derive(Debug, Clone, PartialEq)]
pub struct BrokerMessage {
    pub subject: String,
    pub payload: bytes::Bytes,
    pub reply: Option<String>,
}

/// The seam's own error type: every operation names what it was doing; the
/// cause rides `#[source]` alone, never repeated in the message itself
/// (CLAUDE.md's Errors rule) — a chain-walker like anyhow's `{:#}` renders
/// the cause from `#[source]`, so putting it in the message too would print
/// it twice.
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
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("key-value bucket {bucket:?} unavailable")]
    KvUnavailable {
        bucket: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("key-value bucket {bucket:?} read failed")]
    KvRead {
        bucket: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("read of {subject:?} failed")]
    SubjectRead {
        subject: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("durable consumer {name:?} setup failed")]
    DurableSetup {
        name: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("durable consumer read failed")]
    DurableRead(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("ack failed")]
    Ack(#[source] Box<dyn std::error::Error + Send + Sync>),
    #[error("request to {subject:?} got no reply")]
    Request {
        subject: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
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
/// swallowed is worse than an adopt that fails outright. Scoped claim: this
/// covers errors the client surfaces (a dropped connection, a server error
/// reply); it does NOT cover a fetch that simply expires having delivered
/// fewer than the pending count with no error at all (async-nats's
/// `max_messages` request can end a batch short with nothing to surface) —
/// that hole is real and is deferred, not closed by this trait.
pub trait BrokerReplay: Send {
    fn next(&mut self) -> impl Future<Output = Option<Result<BrokerMessage, BrokerError>>> + Send;
}

/// A durable consumer's tail: the same frames a subscription carries, but
/// with the read position held server-side, so an event published while the
/// reader was down is delivered when it comes back.
///
/// Ack is deliberately not per-message. The reader batches many events into
/// one delivery and may only ack once that delivery has landed, so the
/// consumer acks cumulatively (`AckPolicy::All`) and `ack_delivered` acks
/// everything handed out so far. Nothing is acked before the work it
/// represents is done: acking first and crashing loses the event silently.
pub trait BrokerDurable: Send {
    fn next(&mut self) -> impl Future<Output = Option<Result<BrokerMessage, BrokerError>>> + Send;

    /// Ack every frame delivered so far. A no-op when nothing has been
    /// delivered yet, so a tick with no events costs nothing.
    fn ack_delivered(&mut self) -> impl Future<Output = Result<(), BrokerError>> + Send;
}

pub trait Broker: Clone + Send + Sync + 'static {
    type Subscription: BrokerSubscription;
    type Replay: BrokerReplay;
    type Durable: BrokerDurable;

    fn publish(
        &self,
        subject: String,
        payload: Vec<u8>,
    ) -> impl Future<Output = Result<(), BrokerError>> + Send;

    fn subscribe(
        &self,
        subject: String,
    ) -> impl Future<Output = Result<Self::Subscription, BrokerError>> + Send;

    /// Subscribe as one member of a queue group: the broker delivers each
    /// message to exactly one member. The world's request subjects need this
    /// (agent.md, Requests: several instances sharing a world share a
    /// queue group, so exactly one answers) — a plain subscribe there would
    /// make every instance a responder.
    fn queue_subscribe(
        &self,
        subject: String,
        group: String,
    ) -> impl Future<Output = Result<Self::Subscription, BrokerError>> + Send;

    /// Open a JetStream capture stream's backlog, filtered to
    /// `filter_subject`, in stream order — adopt's replay. Bounded: the
    /// returned source yields exactly the backlog pending at consumer
    /// creation, once. The stream lookup and consumer creation always run;
    /// an empty backlog only skips the fetch itself (the one call whose
    /// `max_messages(0)` semantics are unproven — see `replay_plan`), not
    /// the whole setup.
    fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> impl Future<Output = Result<Self::Replay, BrokerError>> + Send;

    /// Like `replay`, but starting from `start` rather than the beginning
    /// of the stream (JetStream ByStartTime) — the liveness seed's verb: a
    /// bounded window of recent telemetry, never the capture's full
    /// retention.
    fn replay_since(
        &self,
        stream: String,
        filter_subject: String,
        start: std::time::SystemTime,
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

    /// Every live key in a KV bucket, with its value. A bucket is a table
    /// rather than a history: only the current value of each key exists, and
    /// a deleted key is gone rather than tombstoned into the result.
    fn kv_entries(
        &self,
        bucket: String,
    ) -> impl Future<Output = Result<Vec<(String, bytes::Bytes)>, BrokerError>> + Send;

    /// The newest frame stored on exactly one subject, or `None` when the
    /// subject has never been published to. A conversation's tip is this
    /// read against its `changes.message` subject, and an empty conversation
    /// legitimately has none.
    fn last_on_subject(
        &self,
        stream: String,
        subject: String,
    ) -> impl Future<Output = Result<Option<BrokerMessage>, BrokerError>> + Send;

    /// Open (or resume) a named durable consumer over `filter_subject`. The
    /// name is the cursor's identity: the same name after a restart resumes
    /// where the last ack left off.
    fn durable(
        &self,
        stream: String,
        filter_subject: String,
        name: String,
    ) -> impl Future<Output = Result<Self::Durable, BrokerError>> + Send;

    /// Send a request and wait for the one reply. Timeout and no-responders
    /// are both errors here: the caller retries either way, so the
    /// distinction carries nothing.
    fn request(
        &self,
        subject: String,
        payload: Vec<u8>,
        timeout: std::time::Duration,
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
            payload: m.payload,
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
                    // `msg` derefs to the raw message (it also carries the
                    // ack context), so `payload` can't move out of it —
                    // `Bytes::clone` is a refcount bump, not a copy.
                    Ok(msg) => Ok(BrokerMessage {
                        subject: msg.subject.to_string(),
                        payload: msg.payload.clone(),
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

/// A JetStream durable consumer's message stream, plus the last frame handed
/// out. The frame is kept rather than acked on delivery because the ack is
/// the caller's to give, later — and under `AckPolicy::All` acking that one
/// frame acks every frame before it, which is exactly the batch boundary.
pub struct NatsDurable {
    messages: async_nats::jetstream::consumer::pull::Stream,
    delivered: Option<async_nats::jetstream::Message>,
}

impl BrokerDurable for NatsDurable {
    async fn next(&mut self) -> Option<Result<BrokerMessage, BrokerError>> {
        use futures::StreamExt;
        let msg = self.messages.next().await?;
        Some(match msg {
            Ok(msg) => {
                let frame = BrokerMessage {
                    subject: msg.subject.to_string(),
                    payload: msg.payload.clone(),
                    reply: None,
                };
                self.delivered = Some(msg);
                Ok(frame)
            }
            Err(e) => Err(BrokerError::DurableRead(Box::new(e))),
        })
    }

    async fn ack_delivered(&mut self) -> Result<(), BrokerError> {
        let Some(msg) = self.delivered.take() else {
            return Ok(());
        };
        msg.ack().await.map_err(BrokerError::Ack)
    }
}

impl Broker for NatsBroker {
    type Subscription = NatsSubscription;
    type Replay = NatsReplay;
    type Durable = NatsDurable;

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

    async fn queue_subscribe(
        &self,
        subject: String,
        group: String,
    ) -> Result<Self::Subscription, BrokerError> {
        self.client
            .queue_subscribe(subject, group)
            .await
            .map(NatsSubscription)
            .map_err(|e| BrokerError::Subscribe(Box::new(e)))
    }

    async fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> Result<Self::Replay, BrokerError> {
        self.replay_from(
            stream,
            filter_subject,
            async_nats::jetstream::consumer::DeliverPolicy::All,
        )
        .await
    }

    async fn replay_since(
        &self,
        stream: String,
        filter_subject: String,
        start: std::time::SystemTime,
    ) -> Result<Self::Replay, BrokerError> {
        self.replay_from(
            stream,
            filter_subject,
            async_nats::jetstream::consumer::DeliverPolicy::ByStartTime {
                start_time: start.into(),
            },
        )
        .await
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
            .map_err(|source| BrokerError::ObjectReadFailed {
                id,
                source: Box::new(source),
            })?;
        Ok(bytes)
    }

    async fn kv_entries(&self, bucket: String) -> Result<Vec<(String, bytes::Bytes)>, BrokerError> {
        self.kv_entries_inner(bucket).await
    }

    async fn last_on_subject(
        &self,
        stream: String,
        subject: String,
    ) -> Result<Option<BrokerMessage>, BrokerError> {
        let js = async_nats::jetstream::new(self.client.clone());
        let handle = js
            .get_stream(&stream)
            .await
            .map_err(|e| BrokerError::StreamUnavailable {
                stream: stream.clone(),
                source: Box::new(e),
            })?;
        match handle.get_last_raw_message_by_subject(&subject).await {
            Ok(msg) => Ok(Some(BrokerMessage {
                subject: msg.subject.to_string(),
                payload: msg.payload,
                reply: None,
            })),
            // A subject nothing has ever been published to is the empty
            // answer, not a failure: an unspoken-to conversation has no tip.
            Err(e)
                if e.kind()
                    == async_nats::jetstream::stream::LastRawMessageErrorKind::NoMessageFound =>
            {
                Ok(None)
            }
            Err(e) => Err(BrokerError::SubjectRead {
                subject,
                source: Box::new(e),
            }),
        }
    }

    async fn durable(
        &self,
        stream: String,
        filter_subject: String,
        name: String,
    ) -> Result<Self::Durable, BrokerError> {
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
                durable_name: Some(name.clone()),
                filter_subject,
                // Cumulative, so one ack covers a whole batch — see
                // `BrokerDurable`.
                ack_policy: async_nats::jetstream::consumer::AckPolicy::All,
                // A batch is only acked once its delivery lands, and a
                // handler mid-turn rejects deliveries for as long as its turn
                // runs. Redelivery after the default 30s would churn through
                // exactly that window for no gain.
                ack_wait: std::time::Duration::from_secs(300),
                ..Default::default()
            })
            .await
            .map_err(|e| BrokerError::DurableSetup {
                name: name.clone(),
                source: Box::new(e),
            })?;
        let messages = consumer
            .messages()
            .await
            .map_err(|e| BrokerError::DurableSetup {
                name,
                source: Box::new(e),
            })?;
        Ok(NatsDurable {
            messages,
            delivered: None,
        })
    }

    async fn request(
        &self,
        subject: String,
        payload: Vec<u8>,
        timeout: std::time::Duration,
    ) -> Result<Vec<u8>, BrokerError> {
        let request = async_nats::Request::new()
            .payload(payload.into())
            .timeout(Some(timeout));
        self.client
            .send_request(subject.clone(), request)
            .await
            .map(|m| m.payload.to_vec())
            .map_err(|e| BrokerError::Request {
                subject,
                source: Box::new(e),
            })
    }
}

impl NatsBroker {
    async fn kv_entries_inner(
        &self,
        bucket: String,
    ) -> Result<Vec<(String, bytes::Bytes)>, BrokerError> {
        use futures::TryStreamExt;
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js
            .get_key_value(&bucket)
            .await
            .map_err(|e| BrokerError::KvUnavailable {
                bucket: bucket.clone(),
                source: Box::new(e),
            })?;
        let keys: Vec<String> = store
            .keys()
            .await
            .map_err(|e| BrokerError::KvRead {
                bucket: bucket.clone(),
                source: Box::new(e),
            })?
            .try_collect()
            .await
            .map_err(|e| BrokerError::KvRead {
                bucket: bucket.clone(),
                source: Box::new(e),
            })?;
        let mut entries = Vec::with_capacity(keys.len());
        for key in keys {
            let value = store.get(&key).await.map_err(|e| BrokerError::KvRead {
                bucket: bucket.clone(),
                source: Box::new(e),
            })?;
            // A key can be deleted between listing and reading it; that is an
            // ordinary race on a live table, not a read failure.
            if let Some(value) = value {
                entries.push((key, value));
            }
        }
        Ok(entries)
    }

    async fn replay_from(
        &self,
        stream: String,
        filter_subject: String,
        deliver_policy: async_nats::jetstream::consumer::DeliverPolicy,
    ) -> Result<NatsReplay, BrokerError> {
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
                deliver_policy,
                // Ephemeral (no durable_name): explicit, not the server
                // default reached by omission, since this is now a trait
                // contract — the server reclaims it if a replay is ever
                // abandoned mid-adopt (a crash between creation and drain).
                // 5s pins the server's own current default — empirically
                // verified (2026-07-26) against nats-server 2.14.3, the
                // version `nats:latest` (compose.yaml) pulled at the time of
                // writing: a genuinely ephemeral pull consumer
                // (durable_name absent) created via this same async-nats
                // 0.49.1 client, with inactive_threshold left unset, reports
                // `inactive_threshold: 5s` back from the server. Not a
                // behaviour change; re-verify if the pinned image moves.
                inactive_threshold: std::time::Duration::from_secs(5),
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

    /// CLAUDE.md's Errors rule pinned: a log site never renders a bare
    /// `BrokerError` (its own Display omits the cause on purpose, so a
    /// chain-walker doesn't print it twice) — it renders the full chain via
    /// `anyhow`'s `{:#}`, and that rendered chain must still name the
    /// underlying cause. "subscribe failed" alone is undiagnosable in the
    /// field, where pre-seam the async-nats error text was logged.
    #[test]
    fn a_rendered_error_chain_names_its_underlying_cause() {
        let source = std::io::Error::new(
            std::io::ErrorKind::ConnectionRefused,
            "connection refused by broker",
        );
        let err = super::BrokerError::Subscribe(Box::new(source));
        let rendered = format!("{:#}", anyhow::Error::new(err));
        assert!(
            rendered.contains("connection refused by broker"),
            "cause missing from {rendered:?}"
        );
    }
}
