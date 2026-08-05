//! The lookout's broker verbs against a real NATS, because a fake cannot
//! prove any of them: a KV bucket read and its watch, a
//! last-message-on-a-subject read, a durable consumer that resumes where it
//! left off, and a request that gets its reply.
//!
//! Needs the compose broker (`docker compose up -d`), so it is `#[ignore]`d by
//! default — `cargo test -p lookout -- --ignored` runs it deliberately.
//!
//! It touches nothing the fleet uses. It creates its own stream over its own
//! subject space and its own bucket, both named for the run, and removes both
//! at the end whether the checks passed or not — a test that leaks on failure
//! leaks exactly when it is doing its job. It reads no fleet configuration
//! either: an earlier version resolved its stream from towerd's variable,
//! which is how it came to be publishing into the fleet's permanent audit
//! stream in the first place.

use bridge::broker::{Broker, BrokerDurable, BrokerKvWatch, BrokerSubscription, NatsBroker};
use std::time::Duration;

const NATS_URL: &str = "nats://127.0.0.1:4222";

fn message(ts: &str, id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "ts": ts,
        "id": id,
        "queryId": "q-1",
        "role": "assistant",
        "content": [{ "type": "text", "text": "content the lookout must not read" }],
    }))
    .unwrap()
}

fn id_of(payload: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(payload).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
#[ignore = "needs the compose broker: docker compose up -d"]
async fn the_lookout_s_broker_verbs_work_against_a_real_nats() {
    let client = async_nats::connect(NATS_URL)
        .await
        .expect("broker not reachable — docker compose up -d first");
    let js = async_nats::jetstream::new(client.clone());
    let run = std::process::id();
    let stream = format!("lookout-itest-{run}");
    let bucket = format!("lookout-itest-{run}");

    js.create_stream(async_nats::jetstream::stream::Config {
        name: stream.clone(),
        subjects: vec![format!("lookout-itest.{run}.>")],
        ..Default::default()
    })
    .await
    .expect("create this run's own stream");
    js.create_key_value(async_nats::jetstream::kv::Config {
        bucket: bucket.clone(),
        ..Default::default()
    })
    .await
    .expect("create this run's own bucket");

    let outcome = verbs(&client, &js, run, &stream, &bucket).await;

    // Always, so a failed check leaves nothing behind.
    let _ = js.delete_stream(&stream).await;
    let _ = js.delete_key_value(&bucket).await;

    outcome.expect("the broker verbs behave as the lookout needs");
}

async fn verbs(
    client: &async_nats::Client,
    js: &async_nats::jetstream::Context,
    run: u32,
    stream: &str,
    bucket: &str,
) -> anyhow::Result<()> {
    let broker = NatsBroker {
        client: client.clone(),
    };
    let subject = format!("lookout-itest.{run}.changes.message");

    // --- kv_entries: the reporting lines ---------------------------------
    let store = js.get_key_value(bucket).await?;
    let line = serde_json::to_vec(&serde_json::json!({
        "owner": "lookout-itest-handler",
        "ts": wire::now_iso(),
    }))?;
    store.put("worker-1", line.into()).await?;

    let entries = broker.kv_entries(bucket.to_string()).await?;
    let read_back: Vec<_> = entries
        .iter()
        .map(|(key, value)| lookout::lines::parse_line(key, value))
        .collect();
    anyhow::ensure!(
        read_back
            == vec![Ok(lookout::lines::ReportingLine {
                worker: "worker-1".into(),
                owner: "lookout-itest-handler".into(),
                written_at_ms: read_back[0].as_ref().unwrap().written_at_ms,
            })],
        "the bucket read back the line that was written: {read_back:?}"
    );

    // --- kv_watch: a line written after the read still arrives -----------
    let mut registry = broker.kv_watch(bucket.to_string()).await?;
    let line2 = serde_json::to_vec(&serde_json::json!({ "owner": "lookout-itest-handler" }))?;
    store.put("worker-2", line2.into()).await?;
    let change = tokio::time::timeout(Duration::from_secs(5), registry.next())
        .await?
        .ok_or_else(|| anyhow::anyhow!("the registry watch ended"))??;
    anyhow::ensure!(
        change.key == "worker-2" && change.value.is_some(),
        "a line written after the read arrives as a change: {change:?}"
    );

    store.delete("worker-2").await?;
    let removed = tokio::time::timeout(Duration::from_secs(5), registry.next())
        .await?
        .ok_or_else(|| anyhow::anyhow!("the registry watch ended"))??;
    anyhow::ensure!(
        removed.key == "worker-2" && removed.value.is_none(),
        "a line that goes away arrives with no value: {removed:?}"
    );
    drop(registry);

    // --- a worker's history ----------------------------------------------
    for id in ["m-1", "m-2"] {
        js.publish(subject.clone(), message(&wire::now_iso(), id).into())
            .await?
            .await?;
    }

    // --- last_on_subject: the tip -----------------------------------------
    let tip = broker
        .last_on_subject(stream.to_string(), subject.clone())
        .await?
        .ok_or_else(|| anyhow::anyhow!("the subject has messages"))?;
    anyhow::ensure!(
        id_of(&tip.payload) == "m-2",
        "the tip is the newest message on the subject"
    );

    let absent = broker
        .last_on_subject(
            stream.to_string(),
            format!("lookout-itest.{run}.changes.nothing"),
        )
        .await?;
    anyhow::ensure!(
        absent.is_none(),
        "a subject nothing was published to has no tip, and is not an error"
    );

    // --- durable: the cursor resumes, and nothing published while the
    // --- reader was down is lost -----------------------------------------
    let filter = format!("lookout-itest.{run}.>");
    let name = format!("lookout-itest-{run}");
    let mut durable = broker
        .durable(stream.to_string(), filter.clone(), name.clone())
        .await?;
    let first = next_frame(&mut durable).await?;
    anyhow::ensure!(
        id_of(&first.payload) == "m-1",
        "the durable delivers the history in order"
    );
    durable.ack_delivered().await?;
    drop(durable);

    // Published with no reader attached at all.
    js.publish(subject.clone(), message(&wire::now_iso(), "m-3").into())
        .await?
        .await?;

    // What arrives on reopen, up to and including the event published while
    // nothing was reading. Bounded rather than timed: a frame the previous
    // reader had buffered and dropped without acking stays outstanding with
    // the server until `ack_wait` elapses, so it may or may not be among
    // these, and neither answer is the property under test.
    let mut resumed = broker
        .durable(stream.to_string(), filter, name.clone())
        .await?;
    let mut arrived = Vec::new();
    for _ in 0..5 {
        let frame = next_frame(&mut resumed).await?;
        arrived.push(id_of(&frame.payload));
        if arrived.last().is_some_and(|id| id == "m-3") {
            break;
        }
    }
    anyhow::ensure!(
        arrived.contains(&"m-3".to_string()),
        "an event published while nothing was reading is delivered on reopen: {arrived:?}"
    );
    anyhow::ensure!(
        !arrived.contains(&"m-1".to_string()),
        "an acked frame is not delivered again: {arrived:?}"
    );
    resumed.ack_delivered().await?;
    drop(resumed);

    // --- delete_durable ---------------------------------------------------
    broker
        .delete_durable(stream.to_string(), name.clone())
        .await?;
    let gone = js
        .get_stream(stream)
        .await?
        .get_consumer::<async_nats::jetstream::consumer::pull::Config>(&name)
        .await;
    anyhow::ensure!(
        gone.is_err(),
        "a removed durable is no longer on the stream"
    );

    // --- request: the say and its reply ----------------------------------
    // Deliberately outside this run's stream subjects. A stream capturing a
    // request subject answers the request itself with its own publish ack,
    // so the caller gets JetStream's reply instead of the responder's
    // (CLAUDE.md, Rules with teeth). Which is what happened here first.
    let ask = format!("lookout-itest-request.{run}.say");
    let responder = broker.subscribe(ask.clone()).await?;
    let replier = tokio::spawn({
        let broker = broker.clone();
        async move {
            let mut responder = responder;
            if let Some(frame) = responder.next().await
                && let Some(reply) = frame.reply
            {
                let _ = broker
                    .publish(reply, wire::encode_accepted(Some("q-itest")))
                    .await;
            }
        }
    });
    let reply = broker
        .request(ask, b"{}".to_vec(), Duration::from_secs(5))
        .await?;
    anyhow::ensure!(
        wire::parse_say_reply(&reply)
            == wire::SayOutcome::Accepted {
                query: wire::QueryId("q-itest".into())
            },
        "the request carried the reply back"
    );
    replier.await?;
    Ok(())
}

async fn next_frame(
    durable: &mut <NatsBroker as Broker>::Durable,
) -> anyhow::Result<bridge::broker::BrokerMessage> {
    Ok(
        tokio::time::timeout(Duration::from_secs(10), durable.next())
            .await?
            .ok_or_else(|| anyhow::anyhow!("the durable ended"))??,
    )
}
