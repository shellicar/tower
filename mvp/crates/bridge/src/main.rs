//! bridge: the agent host. Conversations are tasks, not processes; nothing
//! on the wire knows the difference (the concern specs are conversation-
//! centric by design). v0 control is stdio, deliberately not a wire concern:
//! creation stays local until practice teaches the spawn request's shape.
//!
//!   $ echo '{"spawn": {}}' | bridge
//!   {"conversationId":"…"}
//!   $ echo '{"adopt": {"conversationId": "…"}}' | bridge
//!   {"conversationId":"…","adoptedMessages":12}
//!   $ echo '{"skills": {"dir": "/path/to/skills"}}' | bridge
//!   {"skillsDir":"/path/to/skills"}
//!
//! `adopt` revives a conversation whose holder died: the record outlives
//! the servicer, so a fresh instance replays the committed messages from
//! the capture stream, seeds its tree, and serves on. The recovery
//! reconciliation, live: recovered behind the published record, reconcile
//! up to it. No validity precondition - a record ending broken (a dangling
//! tool_use) is served as it is, and the next turn's outcome says so.
//!
//! Each spawn services `conv.v2.{id}.requests.>` and produces the v2 event
//! subjects until the process ends. No persistence: v0 conversations die
//! with the host (a deliberate cut, not a gap).
//!
//! The process is one agent instance in a world (agent-spec): `ready` on
//! boot, a `pulse` every PULSE_INTERVAL_S, `attached` per spawn. The world
//! is deployer-chosen (`BRIDGE_WORLD`, default `local`); the instance id is
//! generated per process, so a restart is a new instance in the same world.
//! No `detached` in v0: conversations die with the host, and a kill is a
//! crash from the wire's view (a crash publishes nothing; the pulse going
//! silent is what observers fold).

mod agent;
mod anthropic;
mod approval;
mod decisions;
mod exec;
mod objects;
mod skills;

use std::sync::{Arc, RwLock};

use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use wire::now_iso;

const PULSE_INTERVAL_S: i64 = 30;

/// Replay a conversation's committed messages from the capture stream, in
/// stream order (= commit order). Messages only: telemetry and deltas are
/// observation, and this bridge publishes no revisions or tip movements to
/// fold (a deliberate v0 cut, stated here so the gap is a sentence, not a
/// surprise).
async fn replay_conversation(
    client: &async_nats::Client,
    stream_name: &str,
    conv: &str,
) -> anyhow::Result<Vec<decisions::Message>> {
    let js = async_nats::jetstream::new(client.clone());
    let stream = js.get_stream(stream_name).await.map_err(|e| {
        anyhow::anyhow!("capture stream {stream_name:?} unavailable: {e} (adopt needs the capture)")
    })?;
    let consumer = stream
        .create_consumer(async_nats::jetstream::consumer::pull::Config {
            filter_subject: format!("conv.v2.{conv}.changes.message"),
            deliver_policy: async_nats::jetstream::consumer::DeliverPolicy::All,
            ..Default::default()
        })
        .await?;
    // num_pending at creation is the full backlog: read exactly that many.
    let pending = consumer.cached_info().num_pending as usize;
    let mut messages = Vec::with_capacity(pending);
    if pending == 0 {
        return Ok(messages);
    }
    let mut batch = consumer.fetch().max_messages(pending).messages().await?;
    while let Some(msg) = batch.next().await {
        let msg = msg.map_err(|e| anyhow::anyhow!("replay read failed: {e}"))?;
        // Tolerance: frames that don't parse as a message change are skipped
        // (they can't be - the filter is exact - but never crash on a frame).
        let Some(wire::WireEvent::Conv(event)) = wire::parse_wire(&msg.subject, &msg.payload)
        else {
            continue;
        };
        if let wire::EventKind::Change(wire::ConvChange::Message(m)) = event.kind {
            messages.push(decisions::Message {
                id: m.id.0,
                role: m.role,
                content: m.content,
            });
        }
    }
    Ok(messages)
}

async fn publish_agent(
    client: &async_nats::Client,
    world: &str,
    leaf: &str,
    payload: serde_json::Value,
) {
    let subject = format!("agent.v1.{world}.telemetry.{leaf}");
    let bytes = serde_json::to_vec(&payload).expect("json! of plain values cannot fail");
    // The pulse fires every PULSE_INTERVAL_S; logging it is pure noise. The
    // facts worth seeing are ready/attached/detached.
    if leaf != "pulse" {
        eprintln!("{} bridge: → {subject} ({} B)", now_iso(), bytes.len());
    }
    if let Err(e) = client.publish(subject, bytes.into()).await {
        eprintln!("bridge: agent telemetry publish failed: {e}");
    }
}

/// Serve a conversation: subscribe (the fact before the claim - a
/// conversation that cannot hear requests is not spawned in any meaningful
/// sense, so the claim and the reply both wait for this fact), spawn the
/// agent loop on the seeded tree, and publish `attached` so observers see
/// the conversation exist before its first message. Shared by spawn (a fresh
/// tree) and adopt (a replayed record), and by the future warden before a
/// third caller copies the wiring.
///
/// Returns the conversation id on success (the caller writes the stdout
/// reply); None means the subscription could not be made - the error line is
/// already written, so the caller moves on.
async fn serve_conversation(
    client: &async_nats::Client,
    world: &str,
    instance: &str,
    config: agent::AgentConfig,
    conversation: decisions::Conversation,
) -> Option<String> {
    let conv = config.conv.0.clone();
    let requests = match agent::subscribe(client, &config.conv).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("bridge: subscribe failed for {conv}: {e}");
            println!("{}", serde_json::json!({ "error": "subscribe failed" }));
            return None;
        }
    };
    tokio::spawn(agent::run(client.clone(), requests, config, conversation));
    // The attachment is what makes the conversation exist for observers
    // before its first message. cwd is causal (an input to how the
    // conversation unfolds), published when known.
    let mut attached = serde_json::json!({
        "ts": now_iso(),
        "instanceId": instance,
        "conversationId": conv,
    });
    if let Ok(cwd) = std::env::current_dir() {
        attached["cwd"] = serde_json::json!(cwd.to_string_lossy());
    }
    publish_agent(client, world, "attached", attached).await;
    Some(conv)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    // ANTHROPIC_API_KEY when set; otherwise the Claude Code OAuth token.
    let auth = anthropic::Auth::resolve()?;
    let default_model = std::env::var("BRIDGE_MODEL").unwrap_or_else(|_| "claude-sonnet-5".into());
    // The world is a durable name for a place, deployer-chosen; the process
    // standing in it is disposable and mints a fresh instance id per boot.
    let world = std::env::var("BRIDGE_WORLD").unwrap_or_else(|_| "local".into());
    let instance = uuid::Uuid::new_v4().to_string();

    // The skills root, shared and mutable so a stdio `skills` control line can
    // repoint it live. The catalogue is re-scanned per say; a repoint surfaces
    // as a delta on the next say of every running conversation, and reaches new
    // spawns whole. BRIDGE_SKILLS sets the initial value, overriding the home.
    let initial_skills_root: std::path::PathBuf = std::env::var("BRIDGE_SKILLS")
        .unwrap_or_else(|_| format!("{}/.claude/skills", std::env::var("HOME").unwrap_or_default()))
        .into();
    let skills_root = Arc::new(RwLock::new(initial_skills_root));
    // The transit object store attachments resolve from; must name the same
    // bucket the tower deployment uploads into.
    let attach_bucket = std::env::var("BRIDGE_ATTACH_BUCKET").unwrap_or_else(|_| "attach".into());
    // Extended thinking: on by default; BRIDGE_THINKING_BUDGET=0 disables.
    let thinking_budget = match std::env::var("BRIDGE_THINKING_BUDGET")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
    {
        Some(0) => None,
        Some(n) => Some(n),
        None => Some(4096),
    };

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
    // Unknown control lines are answered with an error line; compliance is
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
                skills_root: Arc::clone(&skills_root),
                attach_bucket: attach_bucket.clone(),
                thinking_budget,
            };
            let Some(conv) = serve_conversation(
                &client,
                &world,
                &instance,
                config,
                decisions::Conversation::default(),
            )
            .await
            else {
                continue;
            };
            println!("{}", serde_json::json!({ "conversationId": conv }));
        } else if let Some(adopt) = value.get("adopt") {
            let Some(conv) = adopt
                .get("conversationId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
            else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "adopt needs conversationId" })
                );
                continue;
            };
            let stream_name =
                std::env::var("BRIDGE_STREAM").unwrap_or_else(|_| "conv-approval".into());
            let messages = match replay_conversation(&client, &stream_name, &conv).await {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("bridge: adopt failed for {conv}: {e:#}");
                    println!("{}", serde_json::json!({ "error": "replay failed" }));
                    continue;
                }
            };
            let adopted = messages.len();
            let config = agent::AgentConfig {
                conv: wire::ConversationId(conv.clone()),
                model: default_model.clone(),
                system: None,
                auth: auth.clone(),
                skills_root: Arc::clone(&skills_root),
                attach_bucket: attach_bucket.clone(),
                thinking_budget,
            };
            let Some(conv) = serve_conversation(
                &client,
                &world,
                &instance,
                config,
                decisions::Conversation::adopt(messages),
            )
            .await
            else {
                continue;
            };
            println!(
                "{}",
                serde_json::json!({ "conversationId": conv, "adoptedMessages": adopted })
            );
        } else if let Some(skills) = value.get("skills") {
            // Repoint the skills directory live. The change reaches every
            // running conversation on its next say (as a delta) and new spawns
            // whole; nothing already committed is touched.
            let Some(dir) = skills.get("dir").and_then(serde_json::Value::as_str) else {
                println!("{}", serde_json::json!({ "error": "skills needs dir" }));
                continue;
            };
            let path: std::path::PathBuf = dir.into();
            *skills_root.write().unwrap() = path.clone();
            eprintln!("bridge: skills dir → {}", path.display());
            println!(
                "{}",
                serde_json::json!({ "skillsDir": path.to_string_lossy() })
            );
        } else {
            println!("{}", serde_json::json!({ "error": "unsupported" }));
        }
    }
    // stdin closed: keep serving what was spawned until killed.
    std::future::pending::<()>().await;
    Ok(())
}
