//! The one integration check (tower-v1-design.md, Testing): compose broker,
//! scripted publisher, WS client asserts. Runs against a real NATS with the
//! capture stream (docker compose up -d; name via TOWER_STREAM, default
//! conv-approval), so it is `#[ignore]`d by default —
//! `cargo test -p towerd -- --ignored` runs it deliberately.
//!
//! The script is scenario 1's event lines published to a fresh conversation
//! id; the client connects, receives `list`, opens the conversation, and
//! asserts the four committed messages arrive in order. A `say` into the
//! same conversation must come back `unreachable` — nothing services it.

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message as WsFrame;

use towerd::broker::{NatsBroker, SystemClock};
use towerd::views::{Views, ViewsHandle, apply_schema};
use towerd::{ingest, web};

const NATS_URL: &str = "nats://127.0.0.1:4222";

#[tokio::test]
#[ignore = "needs the compose broker: docker compose up -d"]
async fn scripted_publisher_reaches_the_ws_client() {
    let client = async_nats::connect(NATS_URL)
        .await
        .expect("broker not reachable — docker compose up -d first");
    let js = async_nats::jetstream::new(client.clone());

    // A fresh conversation id per run: the shared capture stream persists,
    // so isolation comes from the id, not from cleanup.
    let conv = format!("itest-{}", std::process::id());

    // --- towerd, in-process, on an ephemeral port ------------------------
    let db = rusqlite::Connection::open_in_memory().unwrap();
    apply_schema(&db).unwrap();

    let (events_tx, events_rx) = mpsc::channel(1024);
    let (queries_tx, queries_rx) = mpsc::channel(64);
    let (view_events_tx, _) = broadcast::channel(1024);

    let views = Views::new(db, view_events_tx.clone());
    std::thread::spawn(move || views.run_blocking(events_rx, queries_rx));
    let stream = std::env::var("TOWER_STREAM").unwrap_or_else(|_| "conv-approval".into());
    tokio::spawn(ingest::run_ingest(client.clone(), stream, events_tx, 1));

    let state = web::AppState {
        views: ViewsHandle {
            queries: queries_tx,
            events: view_events_tx,
        },
        broker: NatsBroker { client },
        clock: SystemClock,
        dist: std::env::temp_dir(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, web::router(state)).await.unwrap();
    });

    // --- the scripted publisher: scenario 1's event lines ----------------
    let ts = "2026-07-07T21:00:00+10:00";
    let publish = |subject: String, payload: Value| {
        let js = js.clone();
        async move {
            js.publish(subject, serde_json::to_vec(&payload).unwrap().into())
                .await
                .unwrap()
                .await
                .unwrap(); // PubAck: the stream really captured it
        }
    };

    publish(
        format!("conv.v1.{conv}.changes"),
        json!({"type":"message","ts":ts,"id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}),
    )
    .await;
    publish(
        format!("conv.v1.{conv}.telemetry"),
        json!({"type":"turn_started","ts":ts,"queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}),
    )
    .await;
    publish(
        format!("conv.v1.{conv}.changes"),
        json!({"type":"message","ts":ts,"id":"m2","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"tool_use","id":"toolu_01ABC","name":"ReadFile","input":{"path":"X"}}]}),
    )
    .await;
    publish(
        format!("conv.v1.{conv}.changes"),
        json!({"type":"message","ts":ts,"id":"m3","queryId":"q1","turnId":"t2","role":"user","from":{"kind":"agent"},"content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"…file contents…"}]}),
    )
    .await;
    publish(
        format!("conv.v1.{conv}.deltas"),
        json!({"type":"delta","text":"File X contains"}),
    )
    .await;
    publish(
        format!("conv.v1.{conv}.changes"),
        json!({"type":"message","ts":ts,"id":"m4","queryId":"q1","turnId":"t2","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"File X contains a summary of…"}]}),
    )
    .await;

    // --- the WS client asserts -------------------------------------------
    // Ingest is async; poll by reconnecting until the row appears (reconnect
    // = fresh list is the protocol's own recovery, so this is a lawful loop).
    let mut found = false;
    for _ in 0..50 {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
            .await
            .unwrap();
        let list = read_json(&mut socket).await;
        assert_eq!(list["type"], "list");
        if list["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["conv"] == conv.as_str())
        {
            // Open and assert the catch-up.
            socket
                .send(WsFrame::Text(
                    json!({"type":"open","id":"r1","conv":conv,"after":null})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let reply = read_until(&mut socket, "conversation").await;
            assert_eq!(reply["id"], "r1");
            let ids: Vec<&str> = reply["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, ["m1", "m2", "m3", "m4"]);
            // Every message carries the id triple.
            for m in reply["messages"].as_array().unwrap() {
                assert!(m["query"].is_string() && m["turn"].is_string());
            }

            // say into an unserviced conversation → unreachable.
            socket
                .send(WsFrame::Text(
                    json!({"type":"say","id":"r2","conv":conv,"text":"hello","tip":"m4"})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            let result = read_until(&mut socket, "say_result").await;
            assert_eq!(result["id"], "r2");
            assert_eq!(result["outcome"], "unreachable");

            found = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    assert!(found, "the published conversation never reached the list");
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn read_json(socket: &mut Socket) -> Value {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(10), socket.next())
            .await
            .expect("timed out waiting for a frame")
            .expect("socket closed")
            .expect("socket error")
        {
            WsFrame::Text(text) => return serde_json::from_str(&text).unwrap(),
            _ => continue,
        }
    }
}

/// Events interleave with responses on the socket; skip frames (rows,
/// streaming) until the wanted type arrives — exactly what a client does.
async fn read_until(socket: &mut Socket, wanted: &str) -> Value {
    loop {
        let v = read_json(socket).await;
        if v["type"] == wanted {
            return v;
        }
    }
}
