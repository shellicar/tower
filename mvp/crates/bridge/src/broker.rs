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
}

// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct NatsBroker {
    pub client: async_nats::Client,
    /// Frames one fetch asks for — a page size, not a ceiling on the replay.
    /// See `replay_batch_size`.
    pub replay_batch: usize,
}

/// Frames per fetch when nothing configures it. Comfortably under the cap
/// nats-server applies to a single fetch, so a page is never truncated in
/// the first place; the paging below is what makes the whole backlog arrive
/// regardless.
pub const DEFAULT_REPLAY_BATCH: usize = 500;

/// Resolve `BRIDGE_REPLAY_BATCH`. A value that cannot be a batch — zero,
/// negative, not a number — takes the default rather than failing the boot:
/// this only ever changes how many round trips a replay costs, never what it
/// returns, so there is nothing here worth refusing to start over. Setting it
/// small (100 against a thousand-frame conversation) is what forces the
/// paging to iterate.
pub fn replay_batch_size(configured: Option<&str>) -> usize {
    configured
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|batch| *batch > 0)
        .unwrap_or(DEFAULT_REPLAY_BATCH)
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
/// so the early return on nothing pending (which spares a fresh spawn a
/// round trip that could only come back empty) is provable without a live
/// broker. The count itself no longer sizes anything: a fetch asks for a
/// page, and pages repeat until the backlog is drained.
#[derive(Debug, PartialEq)]
enum ReplayPlan {
    Empty,
    Page,
}

fn replay_plan(pending: usize) -> ReplayPlan {
    if pending == 0 {
        ReplayPlan::Empty
    } else {
        ReplayPlan::Page
    }
}

/// Whether a finished batch proves the backlog is drained. Only an empty one
/// does. The server caps a single fetch well below what was asked for and
/// says nothing at all about having done so — no error, no status — so a
/// short batch is byte-for-byte indistinguishable from the end of the
/// stream, and reading it as the end is what silently truncated an adopted
/// conversation.
fn backlog_drained(delivered: usize) -> bool {
    delivered == 0
}

type PullConsumer =
    async_nats::jetstream::consumer::Consumer<async_nats::jetstream::consumer::pull::Config>;

/// A replay's live source: either nothing was pending at consumer creation
/// (`Empty`, ending immediately), or the JetStream pull consumer drained a
/// page at a time. A read failure is surfaced, not swallowed —
/// `Some(Err(_))`, never folded into "the backlog ended".
pub enum NatsReplay {
    Empty,
    Paged(Box<PagedReplay>),
}

/// One pull consumer, drained by repeated fetches. Holding the consumer
/// rather than a single batch is the whole point: a fetch returns what the
/// server felt like giving, and only a batch that yields nothing at all
/// proves there is no more.
pub struct PagedReplay {
    consumer: PullConsumer,
    batch: Option<Box<async_nats::jetstream::consumer::pull::Batch>>,
    batch_size: usize,
    /// Frames the batch in hand has yielded so far — the one number that
    /// distinguishes a capped batch from the end of the stream.
    delivered: usize,
}

impl BrokerReplay for NatsReplay {
    async fn next(&mut self) -> Option<Result<BrokerMessage, BrokerError>> {
        use futures::StreamExt;
        let NatsReplay::Paged(paged) = self else {
            return None;
        };
        loop {
            if paged.batch.is_none() {
                let fetched = paged
                    .consumer
                    .fetch()
                    .max_messages(paged.batch_size)
                    .messages()
                    .await;
                match fetched {
                    Ok(batch) => {
                        paged.delivered = 0;
                        paged.batch = Some(Box::new(batch));
                    }
                    // A page that cannot even be asked for ends the replay
                    // loudly. Reading it as the end is the very fault this
                    // paging exists to close.
                    Err(e) => return Some(Err(BrokerError::ReplaySetup(Box::new(e)))),
                }
            }
            let batch = paged.batch.as_mut().expect("a page was just fetched");
            match batch.next().await {
                // `msg` derefs to the raw message (it also carries the ack
                // context), so `payload` can't move out of it —
                // `Bytes::clone` is a refcount bump, not a copy.
                Some(Ok(msg)) => {
                    paged.delivered += 1;
                    return Some(Ok(BrokerMessage {
                        subject: msg.subject.to_string(),
                        payload: msg.payload.clone(),
                        reply: None,
                    }));
                }
                // Batch's Item error is already `async_nats::Error`
                // (`Box<dyn Error + Send + Sync>`) — no double-boxing.
                Some(Err(e)) => return Some(Err(BrokerError::ReplayRead(e))),
                None => {
                    let drained = backlog_drained(paged.delivered);
                    paged.batch = None;
                    if drained {
                        return None;
                    }
                }
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
}

impl NatsBroker {
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
                // Nothing acks a replayed frame, and with the default
                // explicit policy the server would start redelivering each
                // unacked page after ack_wait — duplicates folded into the
                // tree. A replay reads the record, it does not consume it.
                ack_policy: async_nats::jetstream::consumer::AckPolicy::None,
                ..Default::default()
            })
            .await
            .map_err(|e| BrokerError::ReplaySetup(Box::new(e)))?;
        // num_pending at creation answers one question only: is there
        // anything at all? It never sizes the read. Asking for the whole
        // backlog in one fetch is exactly what failed — the server handed
        // back its own capped count with no error, and the replay ended
        // there, hundreds of frames short.
        let pending = consumer.cached_info().num_pending as usize;
        match replay_plan(pending) {
            ReplayPlan::Empty => Ok(NatsReplay::Empty),
            ReplayPlan::Page => Ok(NatsReplay::Paged(Box::new(PagedReplay {
                consumer,
                batch: None,
                batch_size: self.replay_batch,
                delivered: 0,
            }))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_REPLAY_BATCH, ReplayPlan, backlog_drained, replay_batch_size, replay_plan,
    };

    #[test]
    fn replay_plan_is_empty_when_nothing_is_pending() {
        let expected = ReplayPlan::Empty;
        let actual = replay_plan(0);
        assert_eq!(expected, actual);
    }

    #[test]
    fn replay_plan_pages_when_anything_is_pending() {
        let expected = ReplayPlan::Page;
        let actual = replay_plan(5);
        assert_eq!(expected, actual);
    }

    /// The fault this paging closes: asked for 1243 frames, nats-server
    /// delivered 1000 and reported nothing. Treating that short batch as the
    /// end left an adopted conversation 233 messages behind its own record,
    /// and every say against the real tip was rejected as stale.
    #[test]
    fn a_short_batch_does_not_prove_the_backlog_is_drained() {
        let expected = false;
        let actual = backlog_drained(1000);
        assert_eq!(expected, actual);
    }

    #[test]
    fn a_batch_that_delivers_nothing_proves_the_backlog_is_drained() {
        let expected = true;
        let actual = backlog_drained(0);
        assert_eq!(expected, actual);
    }

    #[test]
    fn the_replay_batch_takes_the_default_when_nothing_configures_it() {
        let expected = DEFAULT_REPLAY_BATCH;
        let actual = replay_batch_size(None);
        assert_eq!(expected, actual);
    }

    #[test]
    fn the_replay_batch_takes_the_configured_size() {
        let expected = 100;
        let actual = replay_batch_size(Some("100"));
        assert_eq!(expected, actual);
    }

    #[test]
    fn a_zero_replay_batch_takes_the_default() {
        let expected = DEFAULT_REPLAY_BATCH;
        let actual = replay_batch_size(Some("0"));
        assert_eq!(expected, actual);
    }

    #[test]
    fn an_unparseable_replay_batch_takes_the_default() {
        let expected = DEFAULT_REPLAY_BATCH;
        let actual = replay_batch_size(Some("lots"));
        assert_eq!(expected, actual);
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
