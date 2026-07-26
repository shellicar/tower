//! bridge's test doubles, out of the shipped binary by construction: a
//! dev-dependency compiles for any test/bench in the crate that declares
//! it, never for a normal build, so nothing here needs a `cfg` at all.

use bridge::broker::{Broker, BrokerError, BrokerMessage, BrokerReplay, BrokerSubscription};
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
    pub replay_data: ReplayData,
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

impl Broker for FakeBroker {
    type Subscription = FakeSubscription;
    type Replay = FakeReplay;

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
        if self.subscribe_fails.load(Ordering::SeqCst) {
            Err(BrokerError::Subscribe(Box::new(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "scripted subscribe failure",
            ))))
        } else {
            Ok(FakeSubscription::default())
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
