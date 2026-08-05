//! The lookout's four new broker verbs against a real NATS, because a fake
//! cannot prove any of them: a KV bucket read, a last-message-on-a-subject
//! read, a durable consumer whose cursor survives being reopened, and a
//! request that gets its reply.
//!
//! Needs the compose broker (`docker compose up -d`) with the capture stream,
//! so it is `#[ignore]`d by default — `cargo test -p lookout -- --ignored`
//! runs it deliberately. It mints its own bucket and its own conversation
//! ids, and removes the bucket it created; nothing here touches a bucket or a
//! conversation the fleet is using.

use bridge::broker::{Broker, BrokerDurable, BrokerSubscription, NatsBroker};

const NATS_URL: &str = "nats://127.0.0.1:4222";

fn stream() -> String {
    std::env::var("TOWER_STREAM_AUDIT").unwrap_or_else(|_| "conv-approval".into())
}

fn message(ts: &str, query: &str, id: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "ts": ts,
        "id": id,
        "queryId": query,
        "turnId": "t-1",
        "role": "assistant",
        "content": [{ "type": "text", "text": "content the lookout must not read" }],
    }))
    .unwrap()
}

#[tokio::test]
#[ignore = "needs the compose broker: docker compose up -d"]
async fn the_lookout_s_broker_verbs_work_against_a_real_nats() {
    let client = async_nats::connect(NATS_URL)
        .await
        .expect("broker not reachable — docker compose up -d first");
    let js = async_nats::jetstream::new(client.clone());
    let broker = NatsBroker {
        client: client.clone(),
    };
    let run = std::process::id();
    let worker = format!("lookout-itest-worker-{run}");
    let bucket = format!("lookout-itest-{run}");

    // --- kv_entries: the reporting lines ---------------------------------
    js.create_key_value(async_nats::jetstream::kv::Config {
        bucket: bucket.clone(),
        ..Default::default()
    })
    .await
    .expect("create the test bucket");
    let store = js.get_key_value(&bucket).await.unwrap();
    store
        .put(
            worker.as_str(),
            serde_json::to_vec(&serde_json::json!({
                "owner": "lookout-itest-handler",
                "ts": wire::now_iso(),
            }))
            .unwrap()
            .into(),
        )
        .await
        .expect("write the line");

    let entries = broker
        .kv_entries(bucket.clone())
        .await
        .expect("read the bucket");
    let lines: Vec<_> = entries
        .iter()
        .map(|(key, value)| lookout::lines::parse_line(key, value))
        .collect();
    assert_eq!(
        lines,
        vec![Ok(lookout::lines::ReportingLine {
            worker: worker.clone(),
            owner: "lookout-itest-handler".into(),
            written_at_ms: lines[0].as_ref().unwrap().written_at_ms,
        })],
        "the bucket read back the line that was written"
    );

    // --- a worker's history ----------------------------------------------
    let subject = format!("conv.v2.{worker}.changes.message");
    let first = wire::now_iso();
    js.publish(subject.clone(), message(&first, "q-1", "m-1").into())
        .await
        .unwrap()
        .await
        .expect("publish the first message");
    let second = wire::now_iso();
    js.publish(subject.clone(), message(&second, "q-1", "m-2").into())
        .await
        .unwrap()
        .await
        .expect("publish the second message");

    // --- last_on_subject: the tip -----------------------------------------
    let tip = broker
        .last_on_subject(stream(), subject.clone())
        .await
        .expect("read the tip")
        .expect("the subject has messages");
    let tip_id = serde_json::from_slice::<serde_json::Value>(&tip.payload).unwrap()["id"].clone();
    assert_eq!(
        tip_id, "m-2",
        "the tip is the newest message on the subject"
    );

    let absent = broker
        .last_on_subject(
            stream(),
            format!("conv.v2.lookout-itest-empty-{run}.changes.message"),
        )
        .await
        .expect("an unspoken-to conversation is not an error");
    assert!(absent.is_none(), "an empty conversation has no tip");

    // --- durable: the cursor survives the consumer being reopened ---------
    let filter = format!("conv.v2.{worker}.changes.>");
    let name = format!("lookout-itest-{run}");
    let mut durable = broker
        .durable(stream(), filter.clone(), name.clone())
        .await
        .expect("open the durable");
    let mut delivered = Vec::new();
    for _ in 0..2 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), durable.next())
            .await
            .expect("the durable delivered within 5s")
            .expect("the durable is still open")
            .expect("the frame read cleanly");
        delivered.push(frame.subject);
    }
    assert_eq!(
        delivered,
        vec![subject.clone(), subject.clone()],
        "the durable delivered the worker's own history"
    );
    durable
        .ack_delivered()
        .await
        .expect("ack after the relay, not before");
    drop(durable);

    let mut resumed = broker
        .durable(stream(), filter, name)
        .await
        .expect("reopen the same durable");
    let after_ack = tokio::time::timeout(std::time::Duration::from_secs(2), resumed.next()).await;
    assert!(
        after_ack.is_err(),
        "an acked frame is not delivered again: the cursor survived"
    );
    drop(resumed);

    // --- request: the say and its reply ----------------------------------
    let ask = format!("lookout.itest.{run}.say");
    let responder = broker.subscribe(ask.clone()).await.expect("subscribe");
    let replier = tokio::spawn({
        let broker = broker.clone();
        async move {
            let mut responder = responder;
            if let Some(frame) = responder.next().await
                && let Some(reply) = frame.reply
            {
                broker
                    .publish(reply, wire::encode_accepted(Some("q-itest")))
                    .await
                    .expect("reply");
            }
        }
    });
    let reply = broker
        .request(ask, b"{}".to_vec(), std::time::Duration::from_secs(5))
        .await
        .expect("the responder answered");
    assert_eq!(
        wire::parse_say_reply(&reply),
        wire::SayOutcome::Accepted {
            query: wire::QueryId("q-itest".into())
        },
        "the request carried the reply back"
    );
    replier.await.unwrap();

    // Remove what this run created. The two published messages stay: the
    // capture stream is permanent by design, and isolation there comes from
    // the conversation id rather than from cleanup.
    js.delete_key_value(&bucket)
        .await
        .expect("remove the bucket this test created");
    js.get_stream(stream())
        .await
        .unwrap()
        .delete_consumer(&format!("lookout-itest-{run}"))
        .await
        .expect("remove the durable this test created");
}
