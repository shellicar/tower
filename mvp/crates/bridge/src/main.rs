//! bridge: the agent host. Conversations are tasks, not processes — nothing
//! on the wire knows the difference (the concern specs are conversation-
//! centric by design). v0 control is stdio, deliberately not a wire concern:
//! creation stays local until practice teaches the spawn request's shape.
//!
//!   $ echo '{"spawn": {}}' | bridge
//!   {"conversationId":"…"}
//!
//! Each spawn services `conv.v1.{id}.requests` and produces the event
//! subjects until the process ends. No persistence: v0 conversations die
//! with the host (a deliberate cut, not a gap).

mod agent;
mod anthropic;

use tokio::io::{AsyncBufReadExt, BufReader};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    // ANTHROPIC_API_KEY when set; otherwise the Claude Code OAuth token.
    let auth = anthropic::Auth::resolve()?;
    let default_model =
        std::env::var("BRIDGE_MODEL").unwrap_or_else(|_| "claude-sonnet-4-5".into());

    let client = async_nats::connect(&nats_url).await?; // fail-fast

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
            println!("{}", serde_json::json!({ "conversationId": conv }));
        } else {
            println!("{}", serde_json::json!({ "error": "unsupported" }));
        }
    }
    // stdin closed: keep serving what was spawned until killed.
    std::future::pending::<()>().await;
    Ok(())
}
