//! Ingest: one JetStream consumer over the conversation event subjects,
//! reading through the stream only. Each frame goes through wire's edge fold
//! once; subjects never travel further in.
//!
//! On every consumer build — startup and every rebuild after an error —
//! ingest reconciles with the views first: it reports the stream's
//! incarnation (its `created` time) and receives the cursor to resume after.
//! Same incarnation → cursor+1, as ever. A recreated stream (sequences
//! restarted at 1) → the views rematerialise and answer 0, and the replay
//! starts from the beginning. Without this, a cursor resumed against a fresh
//! stream waits forever, silently.
//!
//! Deliberately thin: no state of its own — the durable position lives in
//! the views' cursor, committed with the rows, and is re-asked every rebuild.

use futures::StreamExt;
use tokio::sync::{mpsc, oneshot};

use wire::{WireEvent, parse_wire};

use crate::views::ViewQuery;

/// The audit stream's subjects: the committal record, kept unlimited
/// (conv-approval by convention, though the name itself is deployment
/// config — see `run_ingest`'s own doc). `usage` rides here, not in
/// `DIAGNOSTIC_SUBJECTS` below, despite being telemetry-plane traffic
/// (nats-spec's own test still holds: the conversation functions fine
/// without publishing it): it is the only record of what a conversation
/// COST, and diagnostic's 90-day cap silently deletes that forever —
/// correction, 19 Jul 2026, after exactly that happened once (see
/// migrate-usage-retention.sh). Retention need, not plane, decided this.
pub const AUDIT_SUBJECTS: [&str; 4] = [
    "conv.v1.*.changes",
    "conv.v2.*.changes.>",
    "approval.v1.*.lifecycle",
    "conv.v2.*.telemetry.usage",
];
/// The diagnostic stream's subjects: telemetry with real debugging/cost
/// value, capped meaningfully longer than a display buffer (90d by
/// convention). Spelled out leaf by leaf, not `conv.v2.*.telemetry.>` —
/// `usage` is the one leaf under this prefix that does NOT belong here
/// (see `AUDIT_SUBJECTS`), and NATS subject wildcards cannot express
/// "everything except one leaf".
pub const DIAGNOSTIC_SUBJECTS: [&str; 8] = [
    "conv.v1.*.telemetry",
    "conv.v2.*.telemetry.turn.started",
    "conv.v2.*.telemetry.turn.ended",
    "conv.v2.*.telemetry.turn.cancelled",
    "conv.v2.*.telemetry.turn.aborted",
    "conv.v2.*.telemetry.tool.use",
    "agent.v1.*.telemetry.attached",
    "agent.v1.*.telemetry.detached",
];
/// The ephemeral stream's subjects: pure liveness noise and in-progress
/// streaming, superseded the instant it lands — a short grace window for a
/// lagging consumer, nothing more (3d by convention).
pub const EPHEMERAL_SUBJECTS: [&str; 5] = [
    "conv.v1.*.deltas",
    "conv.v2.*.deltas",
    "approval.v1.*.telemetry",
    "agent.v1.*.telemetry.ready",
    "agent.v1.*.telemetry.pulse",
];

/// One ingest loop over one stream. Subjects and which stream name captures
/// them are both deployment configuration (nats-spec, Storage) — never
/// hard-coded past the constant lists above, which exist to keep this file
/// in sync with `migrate-stream-retention.sh`'s declared split, not to
/// re-hardcode a stream name. Every event this loop folds is tagged with its
/// own stream name (its own, non-comparable sequence space) before crossing
/// into the shared events channel — three independent loops feed one Views
/// thread, one cursor row per stream.
pub async fn run_ingest(
    client: async_nats::Client,
    stream: String,
    subjects: &'static [&'static str],
    queries: mpsc::Sender<ViewQuery>,
    events_tx: mpsc::Sender<(String, u64, WireEvent)>,
) {
    let js = async_nats::jetstream::new(client);

    loop {
        if let Err(e) = consume(&js, &stream, subjects, &queries, &events_tx).await {
            eprintln!("ingest[{stream}]: consumer failed, rebuilding: {e:#}");
        }
        if events_tx.is_closed() {
            return; // views gone; nothing to feed
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

async fn consume(
    js: &async_nats::jetstream::Context,
    stream_name: &str,
    subjects: &'static [&'static str],
    queries: &mpsc::Sender<ViewQuery>,
    events_tx: &mpsc::Sender<(String, u64, WireEvent)>,
) -> anyhow::Result<()> {
    let mut stream = js.get_stream(stream_name).await?;
    // `created` is fixed at the stream's birth: the incarnation identity.
    // `last_seq` bounds what any honest cursor can be — the views use it to
    // refuse an unreachable resume position (the silent-strand guard).
    let info = stream.info().await?;
    let created = info.created.unix_timestamp_nanos().to_string();
    let last_seq = info.state.last_sequence;

    // Reconcile: the views own the durable position and decide what the
    // cursor means against this incarnation. No answer = no consuming.
    let (tx, rx) = oneshot::channel();
    queries
        .send(ViewQuery::SyncStream {
            stream: stream_name.to_string(),
            created,
            last_seq,
            reply: tx,
        })
        .await
        .map_err(|_| anyhow::anyhow!("views gone"))?;
    let cursor = rx
        .await
        .map_err(|_| anyhow::anyhow!("views did not answer the stream sync"))?;

    // The resume position against the head: the one number that tells a stalled
    // or lagging towerd apart from an idle one. `behind` is how many events must
    // be folded before the views reflect the current stream.
    let behind = last_seq.saturating_sub(cursor);
    eprintln!(
        "ingest[{stream_name}]: stream sync — head seq {last_seq}, resuming from {} ({behind} behind)",
        if cursor == 0 {
            "start".to_string()
        } else {
            format!("seq {cursor}")
        }
    );

    let consumer: async_nats::jetstream::consumer::Consumer<
        async_nats::jetstream::consumer::pull::Config,
    > = stream
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            deliver_policy: if cursor == 0 {
                async_nats::jetstream::consumer::DeliverPolicy::All
            } else {
                async_nats::jetstream::consumer::DeliverPolicy::ByStartSequence {
                    start_sequence: cursor + 1,
                }
            },
            filter_subjects: subjects.iter().map(|s| s.to_string()).collect(),
            // Ephemeral: the views' cursor is the durable position; a named
            // durable here would be a second cursor to drift.
            ..Default::default()
        })
        .await?;

    let mut messages = consumer.messages().await?;

    // Catch-up feedback: while behind the head, log progress every few seconds
    // and announce the crossing to live; once caught up, go quiet — one line per
    // event would drown the log. `last_seq` is the head at consumer build, so
    // "caught up" means folded past everything that existed when we started.
    let mut caught_up = cursor >= last_seq;
    if caught_up {
        eprintln!("ingest[{stream_name}]: at head (seq {last_seq}), tailing live");
    }
    let mut folded: u64 = 0;
    let mut last_log = std::time::Instant::now();

    while let Some(message) = messages.next().await {
        let message = message?;
        let info = message
            .info()
            .map_err(|e| anyhow::anyhow!("no stream info: {e}"))?;
        let seq = info.stream_sequence;

        folded += 1;
        if !caught_up {
            if seq >= last_seq {
                caught_up = true;
                eprintln!(
                    "ingest[{stream_name}]: caught up at seq {seq} ({folded} folded), tailing live"
                );
            } else if last_log.elapsed() >= std::time::Duration::from_secs(2) {
                eprintln!(
                    "ingest[{stream_name}]: folding — seq {seq}/{last_seq} ({} behind, {folded} folded)",
                    last_seq - seq
                );
                last_log = std::time::Instant::now();
            }
        }

        // Ack immediately: delivery bookkeeping only — position truth is the
        // views' cursor, committed with the rows.
        message
            .ack()
            .await
            .map_err(|e| anyhow::anyhow!("ack failed: {e}"))?;

        if let Some(event) = parse_wire(&message.subject, &message.payload)
            && events_tx
                .send((stream_name.to_string(), seq, event))
                .await
                .is_err()
        {
            return Ok(()); // views gone
        }
        // Foreign concern / malformed subject: not conversation traffic,
        // skipped — the cursor still advances when the next frame lands.
    }
    Ok(())
}
