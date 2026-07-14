//! bridge: the agent host. Conversations are tasks, not processes — nothing
//! on the wire knows the difference (the concern specs are conversation-
//! centric by design). v0 control is stdio, deliberately not a wire concern:
//! creation stays local until practice teaches the spawn request's shape.
//!
//!   $ echo '{"spawn": {}}' | bridge
//!   {"conversationId":"…"}
//!
//! Each spawn services `conv.v2.{id}.requests.>` and produces the v2 event
//! subjects until the process ends. No persistence: v0 conversations die
//! with the host (a deliberate cut, not a gap).
//!
//! The process is one agent instance in a world (agent-spec): `ready` on
//! boot, a `pulse` every PULSE_INTERVAL_S, `attached` per spawn. The world
//! is deployer-chosen (`BRIDGE_WORLD`, default `local`); the instance id is
//! generated per process — a restart is a new instance in the same world.
//! No `detached` in v0: conversations die with the host, and a kill is a
//! crash from the wire's view (a crash publishes nothing; the pulse going
//! silent is what observers fold).

mod agent;
mod anthropic;

use tokio::io::{AsyncBufReadExt, BufReader};
use wire::now_iso;

const PULSE_INTERVAL_S: i64 = 30;

async fn publish_agent(
    client: &async_nats::Client,
    world: &str,
    leaf: &str,
    payload: serde_json::Value,
) {
    let subject = format!("agent.v1.{world}.telemetry.{leaf}");
    let bytes = serde_json::to_vec(&payload).expect("json! of plain values cannot fail");
    if let Err(e) = client.publish(subject, bytes.into()).await {
        eprintln!("bridge: agent telemetry publish failed: {e}");
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    // ANTHROPIC_API_KEY when set; otherwise the Claude Code OAuth token.
    let auth = anthropic::Auth::resolve()?;
    let default_model =
        std::env::var("BRIDGE_MODEL").unwrap_or_else(|_| "claude-sonnet-4-5".into());
    // The world is a durable name for a place, deployer-chosen; the process
    // standing in it is disposable and mints a fresh instance id per boot.
    let world = std::env::var("BRIDGE_WORLD").unwrap_or_else(|_| "local".into());
    let instance = uuid::Uuid::new_v4().to_string();

    let client = async_nats::connect(&nats_url).await?; // fail-fast

    // Ready once subscriptions can be made, then the liveness promise: "you
    // will hear from me again within PULSE_INTERVAL_S seconds". One pulse per
    // instance, never per conversation.
    publish_agent(
        &client,
        &world,
        "ready",
        serde_json::json!({ "ts": now_iso(), "instanceId": instance }),
    )
    .await;
    {
        let client = client.clone();
        let world = world.clone();
        let instance = instance.clone();
        tokio::spawn(async move {
            let mut tick =
                tokio::time::interval(std::time::Duration::from_secs(PULSE_INTERVAL_S as u64));
            loop {
                tick.tick().await;
                publish_agent(
                    &client,
                    &world,
                    "pulse",
                    serde_json::json!({
                        "ts": now_iso(),
                        "instanceId": instance,
                        "intervalS": PULSE_INTERVAL_S,
                    }),
                )
                .await;
            }
        });
    }

    // The stdio control loop: one JSON object per line in, one per line out.
    // Unknown control lines are answered with an error line — compliance is
    // answering, on every surface.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    eprintln!("bridge: ready (model {default_model}); spawn with {{\"spawn\":{{}}}}");

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            println!("{}", serde_json::json!({ "error": "unparseable" }));
            continue;
        };
        if let Some(spawn) = value.get("spawn") {
            let conv = uuid::Uuid::new_v4().to_string();
            let model = spawn
                .get("model")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&default_model)
                .to_string();
            let system = spawn
                .get("system")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let config = agent::AgentConfig {
                conv: wire::ConversationId(conv.clone()),
                model,
                system,
                auth: auth.clone(),
            };
            tokio::spawn(agent::run(client.clone(), config));
            // The attachment is what makes the conversation exist for
            // observers before its first message. cwd is causal (an input to
            // how the conversation unfolds) — published when known.
            let mut attached = serde_json::json!({
                "ts": now_iso(),
                "instanceId": instance,
                "conversationId": conv,
            });
            if let Ok(cwd) = std::env::current_dir() {
                attached["cwd"] = serde_json::json!(cwd.to_string_lossy());
            }
            publish_agent(&client, &world, "attached", attached).await;
            println!("{}", serde_json::json!({ "conversationId": conv }));
        } else {
            println!("{}", serde_json::json!({ "error": "unsupported" }));
        }
    }
    // stdin closed: keep serving what was spawned until killed.
    std::future::pending::<()>().await;
    Ok(())
}
