//! bridge's test doubles, out of the shipped binary by construction: a
//! dev-dependency compiles for any test/bench in the crate that declares
//! it, never for a normal build, so nothing here needs a `cfg` at all.

use bridge::broker::{
    Broker, BrokerDurable, BrokerError, BrokerKvWatch, BrokerMessage, BrokerReplay,
    BrokerSubscription, KvChange,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

type Published = Arc<Mutex<Vec<(String, Vec<u8>)>>>;
type FetchData = Arc<Mutex<std::collections::HashMap<(String, String), Vec<u8>>>>;

/// One scripted replay frame: `Ok` yields a message, `Err` (a plain message
/// string — `BrokerError`'s own variants aren't `Clone`, and a fake's
/// scripted failure doesn't need their exact shape) yields a read failure,
/// so a test can prove a mid-replay error fails the adopt instead of
/// reading as the backlog simply ending.
pub type FakeReplayFrame = Result<BrokerMessage, String>;
type ReplayData = Arc<Mutex<std::collections::HashMap<String, VecDeque<FakeReplayFrame>>>>;
type SubscribeData = Arc<Mutex<std::collections::HashMap<String, VecDeque<BrokerMessage>>>>;
type KvData = Arc<Mutex<std::collections::HashMap<String, Vec<(String, bytes::Bytes)>>>>;
type LastData = Arc<Mutex<std::collections::HashMap<String, BrokerMessage>>>;
type DurableData = Arc<Mutex<std::collections::HashMap<String, VecDeque<FakeReplayFrame>>>>;
type RequestReplies = Arc<Mutex<std::collections::HashMap<String, VecDeque<Vec<u8>>>>>;
type Requested = Arc<Mutex<Vec<(String, Vec<u8>)>>>;
type KvChanges = Arc<Mutex<std::collections::HashMap<String, VecDeque<KvChange>>>>;

/// The only fake in a test is the Broker (CLAUDE.md's house rule). Records
/// every subscribe/publish call, in order (`calls`) and every publish's
/// full payload (`published`), and answers subscribe/replay from scripted
/// queues a test seeds up front, keyed by the exact filter subject asked
/// for. An unseeded filter is a scripting error (panics naming it), not a
/// silent empty backlog — a typo'd filter must fail the test that made it,
/// not pass vacuously; a test that genuinely wants an empty backlog seeds
/// that filter with an empty queue explicitly.
#[derive(Clone, Default)]
pub struct FakeBroker {
    pub calls: Arc<Mutex<Vec<String>>>,
    pub published: Published,
    // Arc'd like every other piece of shared state: a `bool` copied on
    // Clone would let flipping it on the original silently leave a clone
    // the code under test holds unaffected — exactly the vacuity this fake
    // exists to rule out.
    pub subscribe_fails: Arc<AtomicBool>,
    /// Subjects whose subscribe fails, for a test that needs one subscribe
    /// to fail while the others succeed (`subscribe_fails` is all-or-nothing).
    pub subscribe_fail_subjects: Arc<Mutex<std::collections::HashSet<String>>>,
    pub replay_data: ReplayData,
    pub fetch_data: FetchData,
    /// Messages a subscription yields, keyed by the exact subject subscribed
    /// to. Unlike `replay_data`, an unseeded subject is an ordinary empty
    /// subscription — live subjects with nothing to say are the norm, not a
    /// scripting error.
    pub subscribe_data: SubscribeData,
    /// Subjects whose subscription stays open (pending forever) once its
    /// scripted messages are drained, instead of ending. A real subscription
    /// with nothing to say is quiet, not dead — a test that must tell the
    /// two apart marks the subject here.
    pub open_subjects: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Reporting lines and anything else read as a table, keyed by bucket.
    /// An unseeded bucket is `KvUnavailable`: a lookout that cannot find its
    /// bucket is a real deployment failure worth exercising.
    pub kv_data: KvData,
    /// The newest frame per subject, for `last_on_subject`. Absence is the
    /// honest empty answer (a conversation nobody has spoken into), not an
    /// error.
    pub last_data: LastData,
    /// Frames a durable consumer yields, keyed by filter subject. Like
    /// `subscribe_data`, an unseeded filter is an ordinary quiet consumer.
    pub durable_data: DurableData,
    /// Replies to `request`, keyed by subject and consumed in order, so a
    /// test can script a rejection followed by an acceptance. An unseeded
    /// subject has no responder.
    pub request_replies: RequestReplies,
    /// Every request sent, with its payload — the digest a handler actually
    /// received is read from here.
    pub requested: Requested,
    /// One entry per `ack_delivered` that acked something, naming the filter
    /// subject of the consumer that acked.
    pub acked: Arc<Mutex<Vec<String>>>,
    /// Bucket changes a watch yields, keyed by bucket. An unseeded bucket is
    /// an ordinary quiet watch: a registry nobody is changing is the norm.
    pub kv_changes: KvChanges,
    /// Every durable removed, by name.
    pub removed_durables: Arc<Mutex<Vec<String>>>,
}

#[derive(Default)]
pub struct FakeSubscription {
    pub queued: VecDeque<BrokerMessage>,
    pub stay_open: bool,
}

impl BrokerSubscription for FakeSubscription {
    async fn next(&mut self) -> Option<BrokerMessage> {
        match self.queued.pop_front() {
            Some(msg) => Some(msg),
            None if self.stay_open => std::future::pending().await,
            None => None,
        }
    }
}

#[derive(Default)]
pub struct FakeReplay {
    pub queued: VecDeque<FakeReplayFrame>,
}

impl BrokerReplay for FakeReplay {
    async fn next(&mut self) -> Option<Result<BrokerMessage, BrokerError>> {
        self.queued.pop_front().map(|frame| {
            frame.map_err(|message| {
                BrokerError::ReplayRead(Box::new(std::io::Error::other(message)))
            })
        })
    }
}

/// The fake's durable consumer. `delivered` counts frames handed out since
/// the last ack, so `acked` records an ack only when there was something to
/// ack — the same cumulative shape the real consumer has.
pub struct FakeDurable {
    pub filter_subject: String,
    pub queued: VecDeque<FakeReplayFrame>,
    pub delivered: usize,
    pub acked: Arc<Mutex<Vec<String>>>,
    pub stay_open: bool,
}

impl BrokerDurable for FakeDurable {
    async fn next(&mut self) -> Option<Result<BrokerMessage, BrokerError>> {
        let frame = match self.queued.pop_front() {
            Some(frame) => frame,
            None if self.stay_open => std::future::pending().await,
            None => return None,
        };
        self.delivered += 1;
        Some(
            frame.map_err(|message| {
                BrokerError::DurableRead(Box::new(std::io::Error::other(message)))
            }),
        )
    }

    async fn ack_delivered(&mut self) -> Result<(), BrokerError> {
        if self.delivered > 0 {
            self.delivered = 0;
            self.acked.lock().unwrap().push(self.filter_subject.clone());
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct FakeKvWatch {
    pub queued: VecDeque<KvChange>,
    pub stay_open: bool,
}

impl BrokerKvWatch for FakeKvWatch {
    async fn next(&mut self) -> Option<Result<KvChange, BrokerError>> {
        match self.queued.pop_front() {
            Some(change) => Some(Ok(change)),
            None if self.stay_open => std::future::pending().await,
            None => None,
        }
    }
}

impl Broker for FakeBroker {
    type Subscription = FakeSubscription;
    type Replay = FakeReplay;
    type Durable = FakeDurable;
    type KvWatch = FakeKvWatch;

    async fn publish(&self, subject: String, payload: Vec<u8>) -> Result<(), BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("publish:{subject}"));
        self.published.lock().unwrap().push((subject, payload));
        Ok(())
    }

    async fn subscribe(&self, subject: String) -> Result<Self::Subscription, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("subscribe:{subject}"));
        if self.subscribe_fails.load(Ordering::SeqCst)
            || self
                .subscribe_fail_subjects
                .lock()
                .unwrap()
                .contains(&subject)
        {
            Err(BrokerError::Subscribe(Box::new(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "scripted subscribe failure",
            ))))
        } else {
            let stay_open = self.open_subjects.lock().unwrap().contains(&subject);
            let queued = self
                .subscribe_data
                .lock()
                .unwrap()
                .remove(&subject)
                .unwrap_or_default();
            Ok(FakeSubscription { queued, stay_open })
        }
    }

    /// Queue-group delivery is the real broker's concern; a fake with one
    /// subscriber per subject serves the scripted messages the same way,
    /// recording the group so a test can pin that the queue-group form was
    /// used (a plain subscribe on a requests subject would make every
    /// instance a responder).
    async fn queue_subscribe(
        &self,
        subject: String,
        group: String,
    ) -> Result<Self::Subscription, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("queue_subscribe:{subject}:{group}"));
        if self.subscribe_fails.load(Ordering::SeqCst)
            || self
                .subscribe_fail_subjects
                .lock()
                .unwrap()
                .contains(&subject)
        {
            Err(BrokerError::Subscribe(Box::new(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "scripted subscribe failure",
            ))))
        } else {
            let stay_open = self.open_subjects.lock().unwrap().contains(&subject);
            let queued = self
                .subscribe_data
                .lock()
                .unwrap()
                .remove(&subject)
                .unwrap_or_default();
            Ok(FakeSubscription { queued, stay_open })
        }
    }

    async fn replay(
        &self,
        stream: String,
        filter_subject: String,
    ) -> Result<Self::Replay, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("replay:{stream}:{filter_subject}"));
        let queued = self
            .replay_data
            .lock()
            .unwrap()
            .get(&filter_subject)
            .cloned()
            .unwrap_or_else(|| {
                panic!(
                    "FakeBroker::replay called with unscripted filter {filter_subject:?} — \
                     seed replay_data for it first (an empty VecDeque for a deliberately \
                     empty backlog)"
                )
            });
        Ok(FakeReplay { queued })
    }

    /// Unlike `replay`, an unscripted filter here is an ordinary
    /// `StreamUnavailable`, not a panic: the seed's degrade path (a
    /// deployment that doesn't capture telemetry) is a real behaviour under
    /// test, so absence models a missing stream rather than a typo. The
    /// fake ignores `start` — a test scripts exactly the window it means.
    async fn replay_since(
        &self,
        stream: String,
        filter_subject: String,
        _start: std::time::SystemTime,
    ) -> Result<Self::Replay, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("replay_since:{stream}:{filter_subject}"));
        match self.replay_data.lock().unwrap().get(&filter_subject) {
            Some(queued) => Ok(FakeReplay {
                queued: queued.clone(),
            }),
            None => Err(BrokerError::StreamUnavailable {
                stream,
                source: Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no scripted capture for this filter",
                )),
            }),
        }
    }

    async fn fetch_object(&self, bucket: String, id: String) -> Result<Vec<u8>, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("fetch_object:{bucket}:{id}"));
        self.fetch_data
            .lock()
            .unwrap()
            .get(&(bucket.clone(), id.clone()))
            .cloned()
            .ok_or_else(|| BrokerError::ObjectNotFound {
                id: id.clone(),
                bucket: bucket.clone(),
                source: Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no fixture data configured for this bucket/id",
                )),
            })
    }

    async fn kv_entries(&self, bucket: String) -> Result<Vec<(String, bytes::Bytes)>, BrokerError> {
        self.calls.lock().unwrap().push(format!("kv:{bucket}"));
        self.kv_data
            .lock()
            .unwrap()
            .get(&bucket)
            .cloned()
            .ok_or_else(|| BrokerError::KvUnavailable {
                bucket,
                source: Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no scripted bucket",
                )),
            })
    }

    async fn last_on_subject(
        &self,
        stream: String,
        subject: String,
    ) -> Result<Option<BrokerMessage>, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("last_on_subject:{stream}:{subject}"));
        Ok(self.last_data.lock().unwrap().get(&subject).cloned())
    }

    async fn durable(
        &self,
        stream: String,
        filter_subject: String,
        name: String,
    ) -> Result<Self::Durable, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("durable:{stream}:{filter_subject}:{name}"));
        let queued = self
            .durable_data
            .lock()
            .unwrap()
            .remove(&filter_subject)
            .unwrap_or_default();
        let stay_open = self.open_subjects.lock().unwrap().contains(&filter_subject);
        Ok(FakeDurable {
            filter_subject,
            queued,
            delivered: 0,
            acked: Arc::clone(&self.acked),
            stay_open,
        })
    }

    async fn kv_watch(&self, bucket: String) -> Result<Self::KvWatch, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("kv_watch:{bucket}"));
        let queued = self
            .kv_changes
            .lock()
            .unwrap()
            .remove(&bucket)
            .unwrap_or_default();
        let stay_open = self.open_subjects.lock().unwrap().contains(&bucket);
        Ok(FakeKvWatch { queued, stay_open })
    }

    async fn delete_durable(&self, stream: String, name: String) -> Result<(), BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("delete_durable:{stream}:{name}"));
        self.removed_durables.lock().unwrap().push(name);
        Ok(())
    }

    async fn request(
        &self,
        subject: String,
        payload: Vec<u8>,
        _timeout: std::time::Duration,
    ) -> Result<Vec<u8>, BrokerError> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("request:{subject}"));
        self.requested
            .lock()
            .unwrap()
            .push((subject.clone(), payload));
        match self
            .request_replies
            .lock()
            .unwrap()
            .get_mut(&subject)
            .and_then(VecDeque::pop_front)
        {
            Some(reply) => Ok(reply),
            None => Err(BrokerError::Request {
                subject,
                source: Box::new(std::io::Error::new(
                    std::io::ErrorKind::NotConnected,
                    "no scripted responder",
                )),
            }),
        }
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
        let dir = std::env::temp_dir().join(format!("bridge-test-{name}-{}", uuid::Uuid::new_v4()));
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
