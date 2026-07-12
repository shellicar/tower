//! Ingest: one JetStream consumer over the conversation event subjects,
//! reading through the stream only — from cursor+1, so restart = reconnect =
//! same path. Each frame goes through wire's edge fold once; subjects never
//! travel further in.
//!
//! Deliberately thin: no state, no retry logic of its own. If the consumer
//! errors, the loop rebuilds it and resumes from the views' cursor — the
//! cursor commits with the rows, so nothing is lost and duplicates are
//! harmless (idempotent replay).

use futures::StreamExt;
use tokio::sync::mpsc;

use wire::{Event, parse_wire};

/// Subjects ingest folds — event subjects only, never `.requests`
/// (nats-spec, Storage: a stream over requests becomes a second responder).
const SUBJECTS: [&str; 3] = [
    "conv.v1.*.telemetry",
    "conv.v1.*.changes",
    "conv.v1.*.deltas",
];

pub async fn run_ingest(
    client: async_nats::Client,
    stream: String,
    events_tx: mpsc::Sender<(u64, Event)>,
    start_seq: u64,
) {
    let js = async_nats::jetstream::new(client);
    let mut next_seq = start_seq;

    loop {
        match consume_from(&js, &stream, next_seq, &events_tx).await {
            Ok(last_seen) => next_seq = last_seen + 1,
            Err(e) => eprintln!("ingest: consumer failed, rebuilding: {e:#}"),
        }
        if events_tx.is_closed() {
            return; // views gone; nothing to feed
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

async fn consume_from(
    js: &async_nats::jetstream::Context,
    stream: &str,
    start_seq: u64,
    events_tx: &mpsc::Sender<(u64, Event)>,
) -> anyhow::Result<u64> {
    // Which stream captures the event subjects is deployment configuration
    // (nats-spec, Storage) — the name arrives from config, never hard-coded.
    let stream = js.get_stream(stream).await?;
    let consumer: async_nats::jetstream::consumer::Consumer<
        async_nats::jetstream::consumer::pull::Config,
    > = stream
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            deliver_policy: if start_seq <= 1 {
                async_nats::jetstream::consumer::DeliverPolicy::All
            } else {
                async_nats::jetstream::consumer::DeliverPolicy::ByStartSequence {
                    start_sequence: start_seq,
                }
            },
            filter_subjects: SUBJECTS.iter().map(|s| s.to_string()).collect(),
            // Ephemeral: the views' cursor is the durable position; a named
            // durable here would be a second cursor to drift.
            ..Default::default()
        })
        .await?;

    let mut messages = consumer.messages().await?;
    let mut last_seen = start_seq.saturating_sub(1);

    while let Some(message) = messages.next().await {
        let message = message?;
        let info = message
            .info()
            .map_err(|e| anyhow::anyhow!("no stream info: {e}"))?;
        let seq = info.stream_sequence;
        last_seen = seq;

        // Ack immediately: delivery bookkeeping only — position truth is the
        // views' cursor, committed with the rows.
        message
            .ack()
            .await
            .map_err(|e| anyhow::anyhow!("ack failed: {e}"))?;

        if let Some(event) = parse_wire(&message.subject, &message.payload)
            && events_tx.send((seq, event)).await.is_err()
        {
            return Ok(last_seen); // views gone
        }
        // Foreign concern / malformed subject: not conversation traffic,
        // skipped — the cursor still advances when the next frame lands.
    }
    Ok(last_seen)
}
