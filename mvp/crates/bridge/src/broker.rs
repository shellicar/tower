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

/// A live source of messages: pull the next one, or `None` when it has
/// ended (the broker dropped the subscription, the replay's backlog is
/// exhausted, or — for a fake — the scripted messages are used up).
pub trait BrokerSubscription: Send {
    fn next(&mut self) -> impl Future<Output = Option<BrokerMessage>> + Send;
}

pub trait Broker: Clone + Send + Sync + 'static {
    type Subscription: BrokerSubscription;
    /// Adopt's replay source: frames pulled one at a time so a caller can
    /// tee and fold each as it arrives, never holding the whole backlog's
    /// raw bytes at once (a raw message can run to ~17.8 MB — workload
    /// facts).
    type Replay: BrokerSubscription;

    fn publish(
        &self,
        subject: String,
        payload: Vec<u8>,
    ) -> impl Future<Output = Result<(), String>> + Send;

    fn subscribe(
        &self,
        subject: String,
    ) -> impl Future<Output = Result<Self::Subscription, String>> + Send;

    /// Open a JetStream capture stream's backlog, filtered to
    /// `filter_subject`, in stream order — adopt's replay. Bounded: the
    /// returned source yields exactly the backlog pending at consumer
    /// creation, once.
    fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> impl Future<Output = Result<Self::Replay, String>> + Send;

    /// Fetch one attachment's bytes from the transit object store
    /// (objects.rs's `fetch_object`/`resolve_history`/`validate_fresh`) —
    /// bucket and id in, bytes out; the caller already knows the media type
    /// from the reference block itself.
    fn fetch_object(
        &self,
        bucket: String,
        id: String,
    ) -> impl Future<Output = Result<Vec<u8>, String>> + Send;
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

/// A replay's live source: the JetStream pull consumer's own message
/// stream, mapped frame by frame — nothing buffered ahead of what the
/// caller has already pulled.
pub struct NatsReplay(async_nats::jetstream::consumer::pull::Batch);

impl BrokerSubscription for NatsReplay {
    async fn next(&mut self) -> Option<BrokerMessage> {
        use futures::StreamExt;
        // A read failure mid-replay: nothing more to offer honestly.
        let msg = self.0.next().await?.ok()?;
        Some(BrokerMessage {
            subject: msg.subject.to_string(),
            payload: msg.payload.to_vec(),
            reply: None,
        })
    }
}

impl Broker for NatsBroker {
    type Subscription = NatsSubscription;
    type Replay = NatsReplay;

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

    async fn replay(&self, stream: String, filter_subject: String) -> Result<Self::Replay, String> {
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
        // num_pending at creation is the full backlog: read exactly that
        // many, one frame at a time, as the caller drains it.
        let pending = consumer.cached_info().num_pending as usize;
        let messages = consumer
            .fetch()
            .max_messages(pending)
            .messages()
            .await
            .map_err(|e| e.to_string())?;
        Ok(NatsReplay(messages))
    }

    async fn fetch_object(&self, bucket: String, id: String) -> Result<Vec<u8>, String> {
        let js = async_nats::jetstream::new(self.client.clone());
        let store = js
            .get_object_store(&bucket)
            .await
            .map_err(|e| format!("object store {bucket:?} unavailable: {e}"))?;
        let mut object = store
            .get(&id)
            .await
            .map_err(|e| format!("attachment {id:?} not found in {bucket:?}: {e}"))?;
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        object
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| format!("attachment {id:?} read failed: {e}"))?;
        Ok(bytes)
    }
}

// ---------------------------------------------------------------------------

/// Test doubles, shared across every module's tests (objects.rs, agent.rs,
/// main.rs) rather than each defining its own copy. Not `#[cfg(test)]`:
/// bridge's binary target links this library as an ordinary dependency, so
/// a `cfg(test)` item here is invisible to the binary's own test build —
/// these stay plain `pub` so both sides can reach the one definition.
pub mod fake {
    use super::{Broker, BrokerMessage, BrokerSubscription};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// The only fake in a test is the Broker (CLAUDE.md's house rule).
    /// Records every subscribe/publish call, in order (`calls`) and every
    /// publish's full payload (`published`), and answers subscribe/replay
    /// from scripted queues a test seeds up front.
    type Published = Arc<Mutex<Vec<(String, Vec<u8>)>>>;
    type FetchData = Arc<Mutex<std::collections::HashMap<(String, String), Vec<u8>>>>;

    #[derive(Clone, Default)]
    pub struct FakeBroker {
        pub calls: Arc<Mutex<Vec<String>>>,
        pub published: Published,
        pub subscribe_fails: bool,
        pub replay_data: Arc<Mutex<VecDeque<BrokerMessage>>>,
        pub fetch_data: FetchData,
    }

    #[derive(Default)]
    pub struct FakeSubscription {
        pub queued: VecDeque<BrokerMessage>,
    }

    impl BrokerSubscription for FakeSubscription {
        async fn next(&mut self) -> Option<BrokerMessage> {
            self.queued.pop_front()
        }
    }

    impl Broker for FakeBroker {
        type Subscription = FakeSubscription;
        type Replay = FakeSubscription;

        async fn publish(&self, subject: String, payload: Vec<u8>) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("publish:{subject}"));
            self.published.lock().unwrap().push((subject, payload));
            Ok(())
        }

        async fn subscribe(&self, subject: String) -> Result<Self::Subscription, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("subscribe:{subject}"));
            if self.subscribe_fails {
                Err("boom".to_string())
            } else {
                Ok(FakeSubscription::default())
            }
        }

        async fn replay(
            &self,
            _stream: String,
            _filter_subject: String,
        ) -> Result<Self::Replay, String> {
            Ok(FakeSubscription {
                queued: self.replay_data.lock().unwrap().clone(),
            })
        }

        async fn fetch_object(&self, bucket: String, id: String) -> Result<Vec<u8>, String> {
            self.fetch_data
                .lock()
                .unwrap()
                .get(&(bucket.clone(), id.clone()))
                .cloned()
                .ok_or_else(|| format!("no fixture fetch data for {bucket:?}/{id:?}"))
        }
    }

    /// A unique scratch directory for a test's sqlite stores (refs/memory/
    /// history each need their own file), removed on drop so a test run
    /// doesn't leave debris behind in the OS temp dir.
    pub struct TestScratch {
        dir: std::path::PathBuf,
    }

    impl TestScratch {
        pub fn new(name: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("bridge-test-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create test scratch dir");
            Self { dir }
        }

        pub fn path(&self, leaf: &str) -> std::path::PathBuf {
            self.dir.join(leaf)
        }
    }

    impl Drop for TestScratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}
