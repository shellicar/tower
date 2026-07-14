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

/// Subjects ingest folds — event subjects only, never `.requests`
/// (nats-spec, Storage: a stream over requests becomes a second responder).
const SUBJECTS: [&str; 6] = [
    "conv.v2.*.telemetry.>",
    "conv.v2.*.changes.>",
    "conv.v2.*.deltas",
    "agent.v1.*.telemetry.>",
    "approval.v1.*.lifecycle",
    "approval.v1.*.telemetry",
];

pub async fn run_ingest(
    client: async_nats::Client,
    stream: String,
    queries: mpsc::Sender<ViewQuery>,
    events_tx: mpsc::Sender<(u64, WireEvent)>,
) {
    let js = async_nats::jetstream::new(client);

    loop {
        if let Err(e) = consume(&js, &stream, &queries, &events_tx).await {
            eprintln!("ingest: consumer failed, rebuilding: {e:#}");
        }
        if events_tx.is_closed() {
            return; // views gone; nothing to feed
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

async fn consume(
    js: &async_nats::jetstream::Context,
    stream: &str,
    queries: &mpsc::Sender<ViewQuery>,
    events_tx: &mpsc::Sender<(u64, WireEvent)>,
) -> anyhow::Result<()> {
    // Which stream captures the event subjects is deployment configuration
    // (nats-spec, Storage) — the name arrives from config, never hard-coded.
    let mut stream = js.get_stream(stream).await?;
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
            created,
            last_seq,
            reply: tx,
        })
        .await
        .map_err(|_| anyhow::anyhow!("views gone"))?;
    let cursor = rx
        .await
        .map_err(|_| anyhow::anyhow!("views did not answer the stream sync"))?;

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
            filter_subjects: SUBJECTS.iter().map(|s| s.to_string()).collect(),
            // Ephemeral: the views' cursor is the durable position; a named
            // durable here would be a second cursor to drift.
            ..Default::default()
        })
        .await?;

    let mut messages = consumer.messages().await?;

    while let Some(message) = messages.next().await {
        let message = message?;
        let info = message
            .info()
            .map_err(|e| anyhow::anyhow!("no stream info: {e}"))?;
        let seq = info.stream_sequence;

        // Ack immediately: delivery bookkeeping only — position truth is the
        // views' cursor, committed with the rows.
        message
            .ack()
            .await
            .map_err(|e| anyhow::anyhow!("ack failed: {e}"))?;

        if let Some(event) = parse_wire(&message.subject, &message.payload)
            && events_tx.send((seq, event)).await.is_err()
        {
            return Ok(()); // views gone
        }
        // Foreign concern / malformed subject: not conversation traffic,
        // skipped — the cursor still advances when the next frame lands.
    }
    Ok(())
}
