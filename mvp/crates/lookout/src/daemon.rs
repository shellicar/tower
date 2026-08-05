//! The daemon's moving parts, out of the binary so they can be tested: what
//! taking up a worker does and in what order, what a change to the registry
//! does, and what a tick acks.
//!
//! The binary keeps only what needs a real runtime — reading the environment,
//! connecting, and the select that waits on the clock and every open source
//! at once.

use bridge::broker::{Broker, BrokerDurable, BrokerError};

use crate::lines::ReportingLine;
use crate::watch::{Config, TickOutcome, Watch};

/// One open tail. A worker has two: its changes and its telemetry. They are
/// held flat rather than paired so the daemon's select treats every source
/// alike, and so a worker standing down removes both by name.
pub struct Source<D> {
    pub worker: String,
    pub stream: String,
    pub durable: String,
    pub tail: D,
}

pub struct Lookout<B: Broker> {
    watch: Watch,
    sources: Vec<Source<B::Durable>>,
    durable_prefix: String,
}

impl<B: Broker> Lookout<B> {
    pub fn new(durable_prefix: String) -> Self {
        Self {
            watch: Watch::default(),
            sources: Vec::new(),
            durable_prefix,
        }
    }

    pub fn sources_mut(&mut self) -> &mut Vec<Source<B::Durable>> {
        &mut self.sources
    }

    pub fn worker_at(&self, index: usize) -> &str {
        &self.sources[index].worker
    }

    pub fn watching(&self) -> Vec<&str> {
        let mut workers: Vec<&str> = self.watch.lines().keys().map(String::as_str).collect();
        workers.sort_unstable();
        workers
    }

    /// Take up a worker: open both tails, then rebuild its facts.
    ///
    /// The order is the point. A tail opens before the replay that follows it,
    /// so an event published while the replay is running is delivered by the
    /// tail rather than falling into the gap between the two.
    pub async fn take_up(
        &mut self,
        broker: &B,
        config: &Config,
        line: ReportingLine,
    ) -> Result<Vec<String>, BrokerError> {
        let worker = line.worker.clone();
        if self.watch.lines().contains_key(&worker) {
            return Ok(Vec::new());
        }
        let mut opened = Vec::new();
        for (stream, subtree) in [
            (config.stream.clone(), "changes"),
            (config.telemetry_stream.clone(), "telemetry"),
        ] {
            let durable = format!("{}-{subtree}-{worker}", self.durable_prefix);
            let tail = broker
                .durable(
                    stream.clone(),
                    format!("conv.v2.{worker}.{subtree}.>"),
                    durable.clone(),
                )
                .await?;
            opened.push(Source {
                worker: worker.clone(),
                stream,
                durable,
                tail,
            });
        }
        let complaints = self.watch.seed(broker, config, line).await?;
        self.sources.extend(opened);
        Ok(complaints)
    }

    /// Let a worker go: forget it, and remove the consumers that were watching
    /// it. A consumer outlives its worker unless something removes it, and one
    /// per departed worker accumulates on the stream forever.
    pub async fn stand_down(&mut self, broker: &B, worker: &str) -> Vec<String> {
        self.watch.stand_down(worker);
        let mut complaints = Vec::new();
        let (going, staying): (Vec<_>, Vec<_>) = std::mem::take(&mut self.sources)
            .into_iter()
            .partition(|source| source.worker == worker);
        self.sources = staying;
        for source in going {
            if let Err(e) = broker
                .delete_durable(source.stream, source.durable.clone())
                .await
            {
                complaints.push(format!(
                    "{} could not be removed: {:#}",
                    source.durable,
                    anyhow::Error::new(e)
                ));
            }
        }
        complaints
    }

    /// Apply one change to the registry. A line that appears is a worker to
    /// take up; a line that changes is the same worker under a corrected
    /// owner; a line that goes away is a worker to let go.
    pub async fn line_changed(
        &mut self,
        broker: &B,
        config: &Config,
        key: &str,
        value: Option<&[u8]>,
    ) -> Vec<String> {
        let Some(value) = value else {
            return self.stand_down(broker, key).await;
        };
        let line = match crate::lines::parse_line(key, value) {
            Ok(line) => line,
            Err(complaint) => return vec![complaint],
        };
        // An owner that moved is a change to where reports go, not a reason to
        // rebuild what is known about the worker or to reopen its tails.
        if self.watch.lines().contains_key(&line.worker) {
            self.watch.relink(line);
            return Vec::new();
        }
        match self.take_up(broker, config, line).await {
            Ok(complaints) => complaints,
            Err(e) => vec![format!(
                "{key} could not be taken up: {:#}",
                anyhow::Error::new(e)
            )],
        }
    }

    /// Fold one event from the source at `index`.
    pub fn observe(&mut self, index: usize, subject: &str, payload: &[u8]) -> Option<String> {
        let worker = self.sources[index].worker.clone();
        self.watch.observe(&worker, subject, payload)
    }

    /// Drop a source whose tail ended. The worker keeps its facts and its
    /// line: the clock still covers it, so it degrades to being polled rather
    /// than disappearing.
    pub fn source_ended(&mut self, index: usize) -> String {
        self.sources.remove(index).worker
    }

    /// Classify, deliver, and then ack.
    ///
    /// The ack is flow control, not durability. What protects the facts is
    /// that taking a worker up replays its whole subtree from the start of the
    /// stream, with no cursor: wherever the consumer sat, the same facts come
    /// back. So a crash anywhere around the ack loses nothing, and acking
    /// after the tick rather than on receipt is what makes one ack cover a
    /// whole batch instead of one per frame.
    ///
    /// It acks regardless of whether a delivery landed, and that is the
    /// choice: holding the cursor back for an unreachable handler buys no
    /// correctness, because the retry runs off the unreported state instead,
    /// and it costs the whole backlog being redelivered on every ack timeout
    /// until the handler comes back.
    pub async fn tick(
        &mut self,
        broker: &B,
        config: &Config,
        now_ms: i64,
        ts: &str,
    ) -> TickOutcome {
        let mut outcome = self.watch.tick(broker, config, now_ms, ts).await;
        for source in &mut self.sources {
            if let Err(e) = source.tail.ack_delivered().await {
                outcome.complaints.push(format!(
                    "{} could not ack: {:#}",
                    source.durable,
                    anyhow::Error::new(e)
                ));
            }
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge::broker::BrokerMessage;
    use bridge_testkit::FakeBroker;
    use std::collections::VecDeque;
    use std::time::Duration;

    const NOW_MS: i64 = 1_754_000_000_000;

    fn config() -> Config {
        Config {
            stream: "conv-approval".into(),
            telemetry_stream: "conv-diagnostic".into(),
            bucket: "reporting-lines-test".into(),
            quiet_after_ms: 600_000,
            say_timeout: Duration::from_secs(5),
        }
    }

    fn line(worker: &str, owner: &str) -> ReportingLine {
        ReportingLine {
            worker: worker.into(),
            owner: owner.into(),
            written_at_ms: Some(NOW_MS - 60_000),
        }
    }

    fn scripted(workers: &[&str]) -> FakeBroker {
        let broker = FakeBroker::default();
        let mut data = broker.replay_data.lock().unwrap();
        for worker in workers {
            data.insert(format!("conv.v2.{worker}.changes.>"), VecDeque::new());
            data.insert(format!("conv.v2.{worker}.telemetry.>"), VecDeque::new());
        }
        drop(data);
        broker
    }

    fn finished(broker: &FakeBroker, worker: &str, at_ms: i64) {
        let mut data = broker.replay_data.lock().unwrap();
        data.insert(
            format!("conv.v2.{worker}.changes.>"),
            VecDeque::from([
                Ok(BrokerMessage {
                    subject: format!("conv.v2.{worker}.changes.message"),
                    payload: format!(r#"{{"ts":"{}","queryId":"q-1"}}"#, wire::format_ts(at_ms))
                        .into(),
                    reply: None,
                }),
                Ok(BrokerMessage {
                    subject: format!("conv.v2.{worker}.changes.query"),
                    payload: format!(
                        r#"{{"ts":"{}","queryId":"q-1","reason":"completed"}}"#,
                        wire::format_ts(at_ms)
                    )
                    .into(),
                    reply: None,
                }),
            ]),
        );
        data.insert(format!("conv.v2.{worker}.telemetry.>"), VecDeque::new());
    }

    fn accepts(broker: &FakeBroker, handler: &str) {
        broker.request_replies.lock().unwrap().insert(
            format!("conv.v2.{handler}.requests.say"),
            VecDeque::from([
                wire::encode_accepted(Some("q-a")),
                wire::encode_accepted(Some("q-b")),
            ]),
        );
    }

    fn lookout() -> Lookout<FakeBroker> {
        Lookout::<FakeBroker>::new("lookout".into())
    }

    mod take_up {
        use super::*;

        /// The cold-start ordering: both tails open before the replay that
        /// rebuilds the facts, so an event published during the replay is
        /// delivered by the tail rather than lost between the two.
        #[tokio::test]
        async fn opens_both_tails_before_replaying_anything() {
            let expected = vec![
                "durable:conv-approval:conv.v2.worker-1.changes.>:lookout-changes-worker-1"
                    .to_string(),
                "durable:conv-diagnostic:conv.v2.worker-1.telemetry.>:lookout-telemetry-worker-1"
                    .to_string(),
                "replay:conv-approval:conv.v2.worker-1.changes.>".to_string(),
                "replay:conv-diagnostic:conv.v2.worker-1.telemetry.>".to_string(),
            ];
            let broker = scripted(&["worker-1"]);
            let mut lookout = lookout();

            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");
            let actual = broker.calls.lock().unwrap().clone();

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn taking_up_a_worker_twice_opens_nothing_twice() {
            let expected = 1;
            let broker = scripted(&["worker-1"]);
            let mut lookout = lookout();

            for _ in 0..2 {
                lookout
                    .take_up(&broker, &config(), line("worker-1", "handler-1"))
                    .await
                    .expect("the replays are scripted");
            }
            let actual = lookout.watching().len();

            assert_eq!(actual, expected);
        }
    }

    mod line_changed {
        use super::*;

        /// The failure the lookout exists to prevent: a worker commissioned
        /// after the daemon started must still be watched.
        #[tokio::test]
        async fn a_line_that_appears_is_taken_up() {
            let expected = vec!["worker-2"];
            let broker = scripted(&["worker-2"]);
            let mut lookout = lookout();

            lookout
                .line_changed(
                    &broker,
                    &config(),
                    "worker-2",
                    Some(br#"{"owner":"handler-1"}"#),
                )
                .await;
            let actual = lookout.watching();

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn a_line_that_goes_away_is_let_go() {
            let expected: Vec<&str> = vec![];
            let broker = scripted(&["worker-1"]);
            let mut lookout = lookout();
            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");

            lookout
                .line_changed(&broker, &config(), "worker-1", None)
                .await;
            let actual = lookout.watching();

            assert_eq!(actual, expected);
        }

        /// A consumer outlives its worker unless something removes it.
        #[tokio::test]
        async fn a_line_that_goes_away_takes_its_consumers_with_it() {
            let expected = vec![
                "lookout-changes-worker-1".to_string(),
                "lookout-telemetry-worker-1".to_string(),
            ];
            let broker = scripted(&["worker-1"]);
            let mut lookout = lookout();
            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");

            lookout
                .line_changed(&broker, &config(), "worker-1", None)
                .await;
            let actual = broker.removed_durables.lock().unwrap().clone();

            assert_eq!(actual, expected);
        }

        /// An owner that moved changes where reports go. It is not a new
        /// worker, so nothing is reopened and nothing is replayed again.
        #[tokio::test]
        async fn a_line_whose_owner_moved_reopens_nothing() {
            let expected = 0;
            let broker = scripted(&["worker-1"]);
            let mut lookout = lookout();
            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");
            broker.calls.lock().unwrap().clear();

            lookout
                .line_changed(
                    &broker,
                    &config(),
                    "worker-1",
                    Some(br#"{"owner":"handler-2"}"#),
                )
                .await;
            let actual = broker.calls.lock().unwrap().len();

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn a_worker_relinked_reports_to_its_new_owner() {
            let expected = vec!["conv.v2.handler-2.requests.say".to_string()];
            let broker = scripted(&["worker-1"]);
            finished(&broker, "worker-1", NOW_MS - 30_000);
            accepts(&broker, "handler-2");
            let mut lookout = lookout();
            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");

            lookout
                .line_changed(
                    &broker,
                    &config(),
                    "worker-1",
                    Some(br#"{"owner":"handler-2"}"#),
                )
                .await;
            lookout.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual: Vec<String> = broker
                .requested
                .lock()
                .unwrap()
                .iter()
                .map(|(subject, _)| subject.clone())
                .collect();

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn an_unreadable_line_is_named_and_watches_nothing() {
            let expected = (1, 0);
            let broker = scripted(&[]);
            let mut lookout = lookout();

            let complaints = lookout
                .line_changed(&broker, &config(), "worker-1", Some(b"rubbish"))
                .await;
            let actual = (complaints.len(), lookout.watching().len());

            assert_eq!(actual, expected);
        }
    }

    mod tick {
        use super::*;

        #[tokio::test]
        async fn acks_every_open_tail() {
            let expected = vec![
                "conv.v2.worker-1.changes.>".to_string(),
                "conv.v2.worker-1.telemetry.>".to_string(),
            ];
            let broker = scripted(&["worker-1"]);
            broker.durable_data.lock().unwrap().insert(
                "conv.v2.worker-1.changes.>".into(),
                VecDeque::from([Ok(BrokerMessage {
                    subject: "conv.v2.worker-1.changes.tip.moved".into(),
                    payload: r#"{"ts":"2025-07-31T22:13:20.000Z","to":"m-1"}"#.into(),
                    reply: None,
                })]),
            );
            broker.durable_data.lock().unwrap().insert(
                "conv.v2.worker-1.telemetry.>".into(),
                VecDeque::from([Ok(BrokerMessage {
                    subject: "conv.v2.worker-1.telemetry.turn.started".into(),
                    payload: r#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1"}"#.into(),
                    reply: None,
                })]),
            );
            let mut lookout = lookout();
            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");
            for index in 0..2 {
                let frame = lookout.sources_mut()[index].tail.next().await;
                let frame = frame.expect("a frame was scripted").expect("it read");
                lookout.observe(index, &frame.subject, &frame.payload);
            }

            lookout.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = broker.acked.lock().unwrap().clone();

            assert_eq!(actual, expected);
        }

        /// Holding the cursor back for a handler that did not hear buys no
        /// correctness, because taking the worker up again replays its whole
        /// history. It only costs the backlog being redelivered.
        #[tokio::test]
        async fn acks_even_when_the_handler_did_not_hear() {
            let expected = vec!["conv.v2.worker-1.changes.>".to_string()];
            let broker = scripted(&["worker-1"]);
            finished(&broker, "worker-1", NOW_MS - 30_000);
            broker.durable_data.lock().unwrap().insert(
                "conv.v2.worker-1.changes.>".into(),
                VecDeque::from([Ok(BrokerMessage {
                    subject: "conv.v2.worker-1.changes.tip.moved".into(),
                    payload: r#"{"ts":"2025-07-31T22:13:20.000Z","to":"m-1"}"#.into(),
                    reply: None,
                })]),
            );
            broker.request_replies.lock().unwrap().insert(
                "conv.v2.handler-1.requests.say".into(),
                VecDeque::from([wire::encode_rejected("stale tip")]),
            );
            let mut lookout = lookout();
            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");
            let frame = lookout.sources_mut()[0].tail.next().await;
            let frame = frame.expect("a frame was scripted").expect("it read");
            lookout.observe(0, &frame.subject, &frame.payload);

            lookout.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = broker.acked.lock().unwrap().clone();

            assert_eq!(actual, expected);
        }

        /// A tick with nothing delivered acks nothing, so an idle fleet costs
        /// no traffic.
        #[tokio::test]
        async fn acks_nothing_when_no_frame_arrived() {
            let expected: Vec<String> = vec![];
            let broker = scripted(&["worker-1"]);
            let mut lookout = lookout();
            lookout
                .take_up(&broker, &config(), line("worker-1", "handler-1"))
                .await
                .expect("the replays are scripted");

            lookout.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = broker.acked.lock().unwrap().clone();

            assert_eq!(actual, expected);
        }
    }
}
