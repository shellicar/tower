//! What the lookout holds across ticks, and what it does on one.
//!
//! The only state is the two facts per worker and the last state each worker
//! was reported in. That last-reported state is what suppresses a repeat: a
//! worker is relayed when its reading changes, so a second tick over
//! unchanged facts announces nothing, and a rejected delivery is regenerated
//! by the next tick from the state the worker is in *then* rather than
//! replayed from a stale queue.
//!
//! It suppresses a repeat **within one process, and deliberately not across a
//! restart.** A fresh process has no record of what the last one said, so the
//! first tick after a cold start relays every worker that is not working.
//! That is the recovery path rather than a leak: it is what finds a worker
//! that died while nothing was watching. Telling a handler the same thing
//! twice across a restart is what that costs, and it is the cheaper side.

use bridge::broker::{Broker, BrokerReplay};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use crate::classify::{self, Reading};
use crate::digest::{self, Delivery, Edge};
use crate::facts::{self, Facts};
use crate::lines::{ReportingLine, parse_line};

pub struct Config {
    /// The capture stream holding `conv.v2.*.changes.>`.
    pub stream: String,
    /// The stream holding `conv.v2.*.telemetry.>`. Separate because the
    /// deployment splits the two by retention, and the turn boundaries there
    /// are what show a conversation being worked on between commits.
    pub telemetry_stream: String,
    /// The reporting-line bucket. Overridable so a test never reads the
    /// bucket the fleet runs on.
    pub bucket: String,
    /// The two clocks a reading is measured against.
    pub thresholds: classify::Thresholds,
    pub say_timeout: Duration,
}

#[derive(Debug, Default)]
pub struct TickOutcome {
    /// Handlers whose delivery did not land. Their workers stay unreported,
    /// so the next tick tries again against a freshly read tip.
    pub failed: BTreeSet<String>,
    /// Anything the lookout could not read, named rather than dropped.
    pub complaints: Vec<String>,
}

#[derive(Default)]
pub struct Watch {
    lines: BTreeMap<String, ReportingLine>,
    facts: BTreeMap<String, Facts>,
    /// What each worker was last told about, keyed by worker.
    ///
    /// The value is the whole reading, state *and* the query it was about,
    /// because keying on the state alone made a second turn finishing look
    /// identical to the first. A worker that finishes, is briefed again and
    /// finishes again has two things to say, and the query id is what tells
    /// them apart.
    reported: BTreeMap<String, Reading>,
}

/// Read the reporting lines. Returns the lines and, separately, every entry
/// that could not be read: one malformed key must not blind the lookout to
/// every other worker, and it must not vanish either.
pub async fn read_lines<B: Broker>(
    broker: &B,
    bucket: &str,
) -> Result<(Vec<ReportingLine>, Vec<String>), bridge::broker::BrokerError> {
    let entries = broker.kv_entries(bucket.to_string()).await?;
    let mut lines = Vec::new();
    let mut complaints = Vec::new();
    for (key, value) in entries {
        match parse_line(&key, &value) {
            Ok(line) => lines.push(line),
            Err(complaint) => complaints.push(complaint),
        }
    }
    Ok((lines, complaints))
}

impl Watch {
    pub fn lines(&self) -> &BTreeMap<String, ReportingLine> {
        &self.lines
    }

    /// Take up a worker: record its line and rebuild its two facts from its
    /// own subtrees, the changes and the telemetry. Bounded by the registry —
    /// two reads per live worker, with no time window to get wrong.
    ///
    /// Replay itself relays nothing. It is rebuilding state, not reporting
    /// news; the tick that follows is what surfaces anything stale, and that
    /// single tick is the recovery path.
    pub async fn seed<B: Broker>(
        &mut self,
        broker: &B,
        config: &Config,
        line: ReportingLine,
    ) -> Result<Vec<String>, bridge::broker::BrokerError> {
        let worker = line.worker.clone();
        let subtrees = [
            (config.stream.clone(), format!("conv.v2.{worker}.changes.>")),
            (
                config.telemetry_stream.clone(),
                format!("conv.v2.{worker}.telemetry.>"),
            ),
        ];
        let mut facts = Facts::default();
        let mut complaints = Vec::new();
        for (stream, filter) in subtrees {
            let mut replay = broker.replay(stream, filter).await?;
            while let Some(frame) = replay.next().await {
                let frame = frame?;
                match facts::observe(&frame.subject, &frame.payload) {
                    Ok(Some(observation)) => facts.apply(&observation),
                    Ok(None) => {}
                    Err(complaint) => complaints.push(complaint),
                }
            }
        }
        self.facts.insert(worker.clone(), facts);
        self.lines.insert(worker, line);
        Ok(complaints)
    }

    /// Point an existing worker's line at a corrected owner. What is known
    /// about the worker stands: only where its reports go has moved.
    pub fn relink(&mut self, line: ReportingLine) {
        self.lines.insert(line.worker.clone(), line);
    }

    /// Forget a worker whose line has gone. Its facts go with it: a line that
    /// was removed is the registry saying this is no longer a worker anyone
    /// reports on, and keeping its state would leave it classifiable for ever.
    pub fn stand_down(&mut self, worker: &str) {
        self.lines.remove(worker);
        self.facts.remove(worker);
        self.reported.remove(worker);
    }

    /// Fold one live event into a worker's facts. Nothing is relayed here:
    /// the tick is the batch boundary, so many events become one delivery.
    pub fn observe(&mut self, worker: &str, subject: &str, payload: &[u8]) -> Option<String> {
        match facts::observe(subject, payload) {
            Ok(Some(observation)) => {
                self.facts
                    .entry(worker.to_string())
                    .or_default()
                    .apply(&observation);
                None
            }
            Ok(None) => None,
            Err(complaint) => Some(complaint),
        }
    }

    /// Classify every worker, batch what is worth telling by the owner on its
    /// line, and deliver one digest per handler.
    pub async fn tick<B: Broker>(
        &mut self,
        broker: &B,
        config: &Config,
        now_ms: i64,
        ts: &str,
    ) -> TickOutcome {
        let mut outcome = TickOutcome::default();
        let mut edges: Vec<(String, Edge)> = Vec::new();
        for (worker, line) in &self.lines {
            let facts = self.facts.get(worker).cloned().unwrap_or_default();
            let Some(silent_since_ms) = classify::silent_since_ms(&facts, line) else {
                continue;
            };
            let reading = classify::classify(&facts, silent_since_ms, now_ms, &config.thresholds);
            if !reading.state.is_worth_telling() || self.reported.get(worker) == Some(&reading) {
                continue;
            }
            edges.push((
                line.owner.clone(),
                Edge {
                    worker: worker.clone(),
                    state: reading.state,
                    query: reading.query,
                    silent_for_ms: now_ms.saturating_sub(silent_since_ms),
                },
            ));
        }

        for delivery in digest::batch(edges) {
            match deliver(broker, config, &delivery, ts).await {
                Ok(()) => {
                    for edge in &delivery.edges {
                        self.reported.insert(
                            edge.worker.clone(),
                            Reading {
                                state: edge.state,
                                query: edge.query.clone(),
                            },
                        );
                    }
                }
                Err(complaint) => {
                    outcome.complaints.push(complaint);
                    outcome.failed.insert(delivery.handler);
                }
            }
        }
        outcome
    }
}

/// One attempt at a delivery. A rejection is not retried here: the tick is
/// the retry interval, and the next one reads the tip again and sends the
/// worker's state as it is *then*, which is better news than a stale queue
/// would have carried.
async fn deliver<B: Broker>(
    broker: &B,
    config: &Config,
    delivery: &Delivery,
    ts: &str,
) -> Result<(), String> {
    let handler = &delivery.handler;
    let tip = read_tip(broker, &config.stream, handler).await?;
    let command = wire::SayCommand {
        conv: wire::ConversationId(handler.clone()),
        text: digest::render(delivery),
        tip,
        attachments: Vec::new(),
    };
    // The lookout relays on a worker's behalf and is neither the human nor an
    // agent, which is exactly what `orchestrator` names (core.md). `from` is
    // provenance and is never fabricated.
    let payload =
        wire::encode_say_from(&command, ts, &serde_json::json!({ "kind": "orchestrator" }));
    let reply = broker
        .request(
            format!("conv.v2.{handler}.requests.say"),
            payload,
            config.say_timeout,
        )
        .await
        .map_err(|e| format!("{handler} did not answer: {:#}", anyhow::Error::new(e)))?;
    match wire::parse_say_reply(&reply) {
        wire::SayOutcome::Accepted { .. } => Ok(()),
        // A stale tip means the handler spoke first, which is the ordinary
        // case while it is mid-turn rather than a fault.
        wire::SayOutcome::Rejected { reason } => {
            Err(format!("{handler} rejected the digest: {reason}"))
        }
        wire::SayOutcome::Unreachable => Err(format!("{handler} is unreachable")),
    }
}

/// The handler's own latest message id, which anchors the say. This reads one
/// field of one body, and that field is a pointer rather than content: the
/// precondition exists so a digest written while the handler was speaking is
/// rejected instead of applied out of order.
async fn read_tip<B: Broker>(
    broker: &B,
    stream: &str,
    handler: &str,
) -> Result<Option<wire::MessageId>, String> {
    #[derive(serde::Deserialize)]
    struct Tip {
        id: String,
    }
    let frame = broker
        .last_on_subject(
            stream.to_string(),
            format!("conv.v2.{handler}.changes.message"),
        )
        .await
        .map_err(|e| {
            format!(
                "could not read {handler}'s tip: {:#}",
                anyhow::Error::new(e)
            )
        })?;
    match frame {
        // An empty conversation anchors to null, which is the claim "this
        // conversation has nothing in it" rather than the absence of a claim.
        None => Ok(None),
        Some(frame) => serde_json::from_slice::<Tip>(&frame.payload)
            .map(|tip| Some(wire::MessageId(tip.id)))
            .map_err(|e| format!("{handler}'s tip carries no id: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bridge::broker::BrokerMessage;
    use bridge_testkit::FakeBroker;
    use std::collections::VecDeque;

    const NOW_MS: i64 = 1_754_000_000_000;
    const STREAM: &str = "conv-approval";
    const TELEMETRY_STREAM: &str = "conv-diagnostic";
    const BUCKET: &str = "reporting-lines-test";

    fn config() -> Config {
        Config {
            stream: STREAM.into(),
            telemetry_stream: TELEMETRY_STREAM.into(),
            bucket: BUCKET.into(),
            thresholds: classify::Thresholds {
                quiet_after_ms: 600_000,
                tool_max_ms: 900_000,
            },
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

    fn frame(subject: &str, body: String) -> BrokerMessage {
        BrokerMessage {
            subject: subject.into(),
            payload: body.into(),
            reply: None,
        }
    }

    fn committed(worker: &str, query: &str, at_ms: i64) -> BrokerMessage {
        frame(
            &format!("conv.v2.{worker}.changes.message"),
            format!(
                r#"{{"ts":"{}","queryId":"{query}","role":"assistant","content":[{{"type":"text","text":"secret"}}]}}"#,
                wire::format_ts(at_ms)
            ),
        )
    }

    fn closed(worker: &str, query: &str, at_ms: i64) -> BrokerMessage {
        frame(
            &format!("conv.v2.{worker}.changes.query"),
            format!(
                r#"{{"ts":"{}","queryId":"{query}","reason":"completed"}}"#,
                wire::format_ts(at_ms)
            ),
        )
    }

    /// A broker holding one worker's change history, and an empty telemetry
    /// history — seeding reads both subtrees, so both must be scripted.
    fn broker_with(worker: &str, replay: Vec<BrokerMessage>) -> FakeBroker {
        let broker = FakeBroker::default();
        seed_history(&broker, worker, replay, vec![]);
        broker
    }

    fn seed_history(
        broker: &FakeBroker,
        worker: &str,
        changes: Vec<BrokerMessage>,
        telemetry: Vec<BrokerMessage>,
    ) {
        let mut data = broker.replay_data.lock().unwrap();
        data.insert(
            format!("conv.v2.{worker}.changes.>"),
            changes.into_iter().map(Ok).collect(),
        );
        data.insert(
            format!("conv.v2.{worker}.telemetry.>"),
            telemetry.into_iter().map(Ok).collect(),
        );
    }

    fn tool_started(worker: &str, query: &str, at_ms: i64) -> BrokerMessage {
        frame(
            &format!("conv.v2.{worker}.telemetry.tool.use"),
            format!(
                r#"{{"ts":"{}","queryId":"{query}","name":"Exec","input":{{"command":"cargo build"}}}}"#,
                wire::format_ts(at_ms)
            ),
        )
    }

    fn turn_started(worker: &str, at_ms: i64) -> BrokerMessage {
        frame(
            &format!("conv.v2.{worker}.telemetry.turn.started"),
            format!(
                r#"{{"ts":"{}","queryId":"q-1","turnId":"t-1"}}"#,
                wire::format_ts(at_ms)
            ),
        )
    }

    fn accepts(broker: &FakeBroker, handler: &str) {
        broker.request_replies.lock().unwrap().insert(
            format!("conv.v2.{handler}.requests.say"),
            VecDeque::from([wire::encode_accepted(Some("q-new"))]),
        );
    }

    fn says_to(broker: &FakeBroker) -> Vec<(String, String)> {
        broker
            .requested
            .lock()
            .unwrap()
            .iter()
            .map(|(subject, payload)| {
                (
                    subject.clone(),
                    String::from_utf8(payload.clone()).expect("a say is utf-8"),
                )
            })
            .collect()
    }

    async fn seeded(broker: &FakeBroker, line: ReportingLine) -> Watch {
        let mut watch = Watch::default();
        watch
            .seed(broker, &config(), line)
            .await
            .expect("the replay is scripted");
        watch
    }

    mod read_lines {
        use super::*;

        #[tokio::test]
        async fn reads_every_line_in_the_bucket() {
            let expected = vec![line("worker-1", "handler-1").worker];
            let broker = FakeBroker::default();
            broker.kv_data.lock().unwrap().insert(
                BUCKET.into(),
                vec![(
                    "worker-1".into(),
                    bytes::Bytes::from_static(br#"{"owner":"handler-1"}"#),
                )],
            );

            let actual: Vec<String> = super::super::read_lines(&broker, BUCKET)
                .await
                .expect("the bucket is scripted")
                .0
                .into_iter()
                .map(|line| line.worker)
                .collect();

            assert_eq!(actual, expected);
        }

        /// One malformed key must not blind the lookout to every other
        /// worker, and it must not vanish either.
        #[tokio::test]
        async fn names_an_unreadable_entry_and_keeps_the_rest() {
            let expected = (1, 1);
            let broker = FakeBroker::default();
            broker.kv_data.lock().unwrap().insert(
                BUCKET.into(),
                vec![
                    ("worker-1".into(), bytes::Bytes::from_static(b"rubbish")),
                    (
                        "worker-2".into(),
                        bytes::Bytes::from_static(br#"{"owner":"handler-1"}"#),
                    ),
                ],
            );

            let (lines, complaints) = super::super::read_lines(&broker, BUCKET)
                .await
                .expect("the bucket is scripted");
            let actual = (lines.len(), complaints.len());

            assert_eq!(actual, expected);
        }
    }

    mod seed {
        use super::*;

        /// Bounded by the registry: the replays are this worker's own two
        /// subtrees, never a wildcard over every conversation on the broker.
        #[tokio::test]
        async fn replays_only_the_worker_s_own_subtrees() {
            let expected = vec![
                "replay:conv-approval:conv.v2.worker-1.changes.>".to_string(),
                "replay:conv-diagnostic:conv.v2.worker-1.telemetry.>".to_string(),
            ];
            let broker = broker_with("worker-1", vec![]);

            seeded(&broker, line("worker-1", "handler-1")).await;
            let actual = broker.calls.lock().unwrap().clone();

            assert_eq!(actual, expected);
        }

        /// Replay rebuilds state; it does not report news. A restart that
        /// relayed its replay would re-announce every historical close.
        #[tokio::test]
        async fn relays_nothing() {
            let expected: Vec<(String, String)> = vec![];
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 7_200_000),
                    closed("worker-1", "q-1", NOW_MS - 7_200_000),
                ],
            );

            seeded(&broker, line("worker-1", "handler-1")).await;
            let actual = says_to(&broker);

            assert_eq!(actual, expected);
        }
    }

    mod tick {
        use super::*;

        /// The recovery path: a worker that died mid-turn publishes no event
        /// ever, so only the tick after a cold start can find it. This is the
        /// one that would have caught the worker dead for a day.
        #[tokio::test]
        async fn a_cold_start_finds_a_worker_that_died_mid_turn() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 82_800_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0]
                .1
                .contains("has a query still open, has not spoken for 23h");

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn a_worker_that_finished_a_turn_is_relayed_to_its_handler() {
            let expected = vec!["conv.v2.handler-1.requests.say".to_string()];
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual: Vec<String> = says_to(&broker).into_iter().map(|(s, _)| s).collect();

            assert_eq!(actual, expected);
        }

        /// The reason telemetry is watched at all: a worker whose last commit
        /// is older than the threshold, but whose turn started since, is
        /// being worked on and is not a corpse.
        #[tokio::test]
        async fn a_turn_that_started_after_the_last_commit_keeps_a_worker_alive() {
            let expected: Vec<(String, String)> = vec![];
            let broker = FakeBroker::default();
            seed_history(
                &broker,
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 3_600_000)],
                vec![turn_started("worker-1", NOW_MS - 30_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker);

            assert_eq!(actual, expected);
        }

        /// The founding case, end to end. A worker that died holding an open
        /// `Exec` announced a tool that has been outstanding for 23 hours,
        /// which no running tool can be, so its handler is told.
        #[tokio::test]
        async fn a_worker_that_died_holding_an_open_tool_is_found() {
            let expected = true;
            let broker = FakeBroker::default();
            seed_history(
                &broker,
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 23 * 3_600_000)],
                vec![tool_started("worker-1", "q-1", NOW_MS - 23 * 3_600_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0]
                .1
                .contains("which is longer than a tool can run");

            assert_eq!(actual, expected);
        }

        /// A second turn finishing is a second thing to say. Keying the
        /// suppression on the reading alone made the handler that briefs its
        /// workers promptly the one that stopped hearing.
        #[tokio::test]
        async fn a_second_turn_finishing_is_relayed_again() {
            let expected = 2;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 120_000),
                    closed("worker-1", "q-1", NOW_MS - 120_000),
                ],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            // Fresh work, and it finishes too.
            for frame in [
                committed("worker-1", "q-2", NOW_MS - 30_000),
                closed("worker-1", "q-2", NOW_MS - 30_000),
            ] {
                watch.observe("worker-1", &frame.subject, &frame.payload);
            }
            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker).len();

            assert_eq!(actual, expected);
        }

        /// The recovery case. A process that dies mid-query publishes no
        /// closure ever, so without a later query superseding the earlier one
        /// the worker could never read as finished again.
        #[tokio::test]
        async fn a_worker_reserviced_after_a_silent_death_is_relayed_when_it_finishes() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 22 * 3_600_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            // Re-serviced, and the new query runs to completion.
            for frame in [
                committed("worker-1", "q-2", NOW_MS - 30_000),
                closed("worker-1", "q-2", NOW_MS - 30_000),
            ] {
                watch.observe("worker-1", &frame.subject, &frame.payload);
            }
            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)
                .last()
                .expect("a digest was sent")
                .1
                .contains("finished a turn");

            assert_eq!(actual, expected);
        }

        /// The query the reading is about travels, so a handler that has been
        /// reset can tell an old stop from a new one.
        #[tokio::test]
        async fn a_digest_names_the_query_its_reading_is_about() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-77", NOW_MS - 30_000),
                    closed("worker-1", "q-77", NOW_MS - 30_000),
                ],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains("Query q-77.");

            assert_eq!(actual, expected);
        }

        /// The case the whole tool fact exists for, end to end: a worker
        /// twelve minutes into a build has been silent past the quiet
        /// threshold but is within the bound, and its handler is told nothing.
        #[tokio::test]
        async fn a_worker_waiting_on_a_tool_it_announced_wakes_nobody() {
            let expected: Vec<(String, String)> = vec![];
            let broker = FakeBroker::default();
            seed_history(
                &broker,
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 12 * 60_000)],
                vec![tool_started("worker-1", "q-1", NOW_MS - 12 * 60_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker);

            assert_eq!(actual, expected);
        }

        /// The same worker with no tool announced is the reading that made a
        /// live build indistinguishable from a corpse.
        #[tokio::test]
        async fn the_same_worker_with_no_tool_announced_is_reported() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 12 * 60_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains("has a query still open");

            assert_eq!(actual, expected);
        }

        /// Without the telemetry subtree the same worker reads as silent for
        /// an hour, which is the reading watching one subtree alone gives.
        #[tokio::test]
        async fn the_same_worker_without_its_telemetry_reads_as_silent() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 3_600_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains("has a query still open");

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn a_worker_still_working_is_left_alone() {
            let expected: Vec<(String, String)> = vec![];
            let broker = broker_with(
                "worker-1",
                vec![committed("worker-1", "q-1", NOW_MS - 30_000)],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker);

            assert_eq!(actual, expected);
        }

        /// The funnel: many workers report, one handler hears once.
        #[tokio::test]
        async fn two_workers_on_one_line_become_one_delivery() {
            let expected = 1;
            let broker = FakeBroker::default();
            for worker in ["worker-1", "worker-2"] {
                seed_history(
                    &broker,
                    worker,
                    vec![
                        committed(worker, "q-1", NOW_MS - 30_000),
                        closed(worker, "q-1", NOW_MS - 30_000),
                    ],
                    vec![],
                );
            }
            accepts(&broker, "handler-1");
            let mut watch = Watch::default();
            for worker in ["worker-1", "worker-2"] {
                watch
                    .seed(&broker, &config(), line(worker, "handler-1"))
                    .await
                    .expect("the replay is scripted");
            }

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker).len();

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn a_delivery_names_every_worker_it_carries() {
            let expected = true;
            let broker = FakeBroker::default();
            for worker in ["worker-1", "worker-2"] {
                seed_history(
                    &broker,
                    worker,
                    vec![
                        committed(worker, "q-1", NOW_MS - 30_000),
                        closed(worker, "q-1", NOW_MS - 30_000),
                    ],
                    vec![],
                );
            }
            accepts(&broker, "handler-1");
            let mut watch = Watch::default();
            for worker in ["worker-1", "worker-2"] {
                watch
                    .seed(&broker, &config(), line(worker, "handler-1"))
                    .await
                    .expect("the replay is scripted");
            }

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let digest = says_to(&broker)[0].1.clone();
            let actual = digest.contains("worker-1") && digest.contains("worker-2");

            assert_eq!(actual, expected);
        }

        /// A digest carries pointers, never payloads. What the worker
        /// actually said stays where it sits.
        #[tokio::test]
        async fn a_digest_carries_nothing_the_worker_said() {
            let expected = false;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains("secret");

            assert_eq!(actual, expected);
        }

        #[tokio::test]
        async fn the_same_reading_twice_is_told_once() {
            let expected = 1;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            broker.request_replies.lock().unwrap().insert(
                "conv.v2.handler-1.requests.say".into(),
                VecDeque::from([
                    wire::encode_accepted(Some("q-a")),
                    wire::encode_accepted(Some("q-b")),
                ]),
            );
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker).len();

            assert_eq!(actual, expected);
        }

        /// A rejected say means the handler spoke first, so the reading is
        /// not marked as told and the next tick sends it again.
        #[tokio::test]
        async fn a_rejected_delivery_is_sent_again_on_the_next_tick() {
            let expected = 2;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            broker.request_replies.lock().unwrap().insert(
                "conv.v2.handler-1.requests.say".into(),
                VecDeque::from([
                    wire::encode_rejected("stale tip"),
                    wire::encode_accepted(Some("q-b")),
                ]),
            );
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker).len();

            assert_eq!(actual, expected);
        }

        /// A handler that did not hear is named, so the daemon can say so.
        #[tokio::test]
        async fn a_handler_that_did_not_hear_is_named_in_the_outcome() {
            let expected = BTreeSet::from(["handler-1".to_string()]);
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            broker.request_replies.lock().unwrap().insert(
                "conv.v2.handler-1.requests.say".into(),
                VecDeque::from([wire::encode_rejected("stale tip")]),
            );
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            let actual = watch.tick(&broker, &config(), NOW_MS, "ts").await.failed;

            assert_eq!(actual, expected);
        }

        /// A worker whose line was removed stops being classified, so a torn
        /// down worker is not reported for ever after.
        #[tokio::test]
        async fn a_worker_stood_down_is_no_longer_relayed() {
            let expected: Vec<(String, String)> = vec![];
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.stand_down("worker-1");
            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker);

            assert_eq!(actual, expected);
        }

        /// The say is anchored to the handler's own tip, so a digest written
        /// while the handler was speaking is rejected rather than applied out
        /// of order.
        #[tokio::test]
        async fn a_digest_is_anchored_to_the_handler_s_tip() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            broker.last_data.lock().unwrap().insert(
                "conv.v2.handler-1.changes.message".into(),
                frame(
                    "conv.v2.handler-1.changes.message",
                    r#"{"id":"m-77","ts":"2025-07-31T22:13:20.000Z"}"#.into(),
                ),
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains(r#""tip":"m-77""#);

            assert_eq!(actual, expected);
        }

        /// A conversation nobody has spoken into anchors to null, which is
        /// the claim that it is empty rather than the absence of a claim.
        #[tokio::test]
        async fn a_digest_into_an_empty_conversation_anchors_to_null() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains(r#""tip":null"#);

            assert_eq!(actual, expected);
        }

        /// The lookout is neither the human nor an agent, and `from` is
        /// provenance that is never fabricated.
        #[tokio::test]
        async fn a_digest_is_sent_as_an_orchestrator() {
            let expected = true;
            let broker = broker_with(
                "worker-1",
                vec![
                    committed("worker-1", "q-1", NOW_MS - 30_000),
                    closed("worker-1", "q-1", NOW_MS - 30_000),
                ],
            );
            accepts(&broker, "handler-1");
            let mut watch = seeded(&broker, line("worker-1", "handler-1")).await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains(r#""kind":"orchestrator""#);

            assert_eq!(actual, expected);
        }

        /// A worker that was commissioned and never spoke is waiting on
        /// someone, not working: the line's own timestamp is the only clock
        /// there is for a brief that never landed.
        #[tokio::test]
        async fn a_worker_that_never_spoke_is_reported_once_its_line_goes_stale() {
            let expected = true;
            let broker = broker_with("worker-1", vec![]);
            accepts(&broker, "handler-1");
            let mut watch = seeded(
                &broker,
                ReportingLine {
                    worker: "worker-1".into(),
                    owner: "handler-1".into(),
                    written_at_ms: Some(NOW_MS - 7_200_000),
                },
            )
            .await;

            watch.tick(&broker, &config(), NOW_MS, "ts").await;
            let actual = says_to(&broker)[0].1.contains("waiting on someone");

            assert_eq!(actual, expected);
        }
    }
}
