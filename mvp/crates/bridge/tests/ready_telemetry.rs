//! Boots the real binary against a real broker and reads what it puts on the
//! wire, because the payload's shape is decided in main() where no unit test
//! reaches. Ignored by default:
//!
//!     just broker-run 'cargo test -p bridge --test ready_telemetry -- --ignored --nocapture'

use futures::StreamExt as _;

#[tokio::test]
#[ignore = "needs a real broker: run it under just broker-run"]
async fn ready_carries_the_name_of_the_agent_that_published_it() {
    let url = std::env::var("NATS_URL")
        .expect("NATS_URL is unset — run this under `just broker-run` from mvp/");
    let world = format!("ready-telemetry-{}", uuid::Uuid::new_v4());

    let client = async_nats::connect(&url).await.unwrap();
    let mut ready = client
        .subscribe(format!("agent.v1.{world}.telemetry.ready"))
        .await
        .unwrap();
    // The subscription has to be registered at the broker before the boot it
    // is meant to hear; ready is published once and never repeated.
    client.flush().await.unwrap();

    let mut bridge = std::process::Command::new(env!("CARGO_BIN_EXE_bridge"))
        .env("NATS_URL", &url)
        .env("BRIDGE_WORLD", &world)
        // Boot resolves a credential before it publishes. Nothing here ever
        // calls the model, so any value gets past that and the keychain is
        // left alone.
        .env("ANTHROPIC_API_KEY", "unused-no-model-request-is-made")
        // Held open for the lifetime of the child: bridge exits when its
        // stdin closes.
        .stdin(std::process::Stdio::piped())
        .spawn()
        .unwrap();

    let frame = tokio::time::timeout(std::time::Duration::from_secs(30), ready.next()).await;

    bridge.kill().unwrap();
    bridge.wait().unwrap();

    let frame = frame
        .expect("no ready within 30s")
        .expect("the subscription ended before a ready arrived");
    let body: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
    println!(
        "off the wire, {}:\n{}",
        frame.subject,
        serde_json::to_string_pretty(&body).unwrap()
    );

    let expected = serde_json::json!("bridge");

    let actual = body["name"].clone();

    assert_eq!(actual, expected);
}
