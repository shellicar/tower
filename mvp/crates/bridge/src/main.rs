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
mod delete;
mod editfile;
mod exec;
mod find;
mod history;
mod historytools;
mod matcher;
mod memory;
mod memtools;
mod mutate;
mod objects;
mod pipe;
mod read;
mod readfile;
mod refs;
mod skills;
mod slice;
mod stream;

use std::sync::{Arc, RwLock};

use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use wire::now_iso;

const PULSE_INTERVAL_S: i64 = 30;

/// Expand a leading `~` or `~/...` to `$HOME`. A control line is JSON over
/// stdio, never a shell, so this is the only place a `~`-prefixed path is
/// ever resolved — anywhere else, it stays a literal tilde character.
fn expand_tilde(path: &str) -> std::path::PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return std::path::PathBuf::from(home).join(rest);
        }
    } else if path == "~"
        && let Ok(home) = std::env::var("HOME")
    {
        return std::path::PathBuf::from(home);
    }
    std::path::PathBuf::from(path)
}

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

/// The host's shared config and live cells. Every control line — from `-c` or
/// live stdin — reads through this; the cells are what a `skills`, `system`,
/// or `context` line repoints without a restart.
struct Host {
    client: async_nats::Client,
    world: String,
    instance: String,
    default_model: String,
    auth: anthropic::Auth,
    skills_root: Arc<RwLock<std::path::PathBuf>>,
    system: Arc<RwLock<Option<String>>>,
    context: Arc<RwLock<Option<String>>>,
    attach_bucket: String,
    thinking_budget: Option<i64>,
    refs: refs::RefStore,
    memory: memory::MemoryStore,
    history: history::HistoryStore,
}

impl Host {
    /// Build the config for a new or adopted conversation from the live cells.
    fn config(&self, conv: &str, model: String) -> agent::AgentConfig {
        agent::AgentConfig {
            conv: wire::ConversationId(conv.to_string()),
            model,
            system: Arc::clone(&self.system),
            context: Arc::clone(&self.context),
            auth: self.auth.clone(),
            skills_root: Arc::clone(&self.skills_root),
            attach_bucket: self.attach_bucket.clone(),
            refs: Arc::clone(&self.refs),
            memory: Arc::clone(&self.memory),
            history: Arc::clone(&self.history),
            thinking_budget: self.thinking_budget,
        }
    }

    /// Carry out one control line, writing its single response to stdout.
    async fn handle(&self, value: serde_json::Value) {
        if let Some(spawn) = value.get("spawn") {
            let conv = uuid::Uuid::new_v4().to_string();
            let model = spawn
                .get("model")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&self.default_model)
                .to_string();
            let config = self.config(&conv, model);
            let Some(conv) = serve_conversation(
                &self.client,
                &self.world,
                &self.instance,
                config,
                decisions::Conversation::default(),
            )
            .await
            else {
                return;
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
                return;
            };
            let stream_name =
                std::env::var("BRIDGE_STREAM").unwrap_or_else(|_| "conv-approval".into());
            let messages = match replay_conversation(&self.client, &stream_name, &conv).await {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("bridge: adopt failed for {conv}: {e:#}");
                    println!("{}", serde_json::json!({ "error": "replay failed" }));
                    return;
                }
            };
            let adopted = messages.len();
            let config = self.config(&conv, self.default_model.clone());
            let Some(conv) = serve_conversation(
                &self.client,
                &self.world,
                &self.instance,
                config,
                decisions::Conversation::adopt(messages),
            )
            .await
            else {
                return;
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
                return;
            };
            // A control line is JSON over stdio, never a shell — nothing else
            // will ever expand a leading `~`, so this is the one place it can
            // happen; without it, a `~/...` path silently sets an unreadable
            // directory with no clue why.
            let path = expand_tilde(dir);
            *self.skills_root.write().unwrap() = path.clone();
            eprintln!("bridge: skills dir → {}", path.display());
            // Setting the config is never rejected — the directory might not
            // exist yet, or might arrive before it does — but a missing or
            // non-directory path is silent otherwise, so it's surfaced as a
            // warning alongside the (always successful) set.
            let mut response = serde_json::json!({ "skillsDir": path.to_string_lossy() });
            match std::fs::metadata(&path) {
                Ok(m) if m.is_dir() => {}
                Ok(_) => {
                    let warning = format!("{} exists but is not a directory", path.display());
                    eprintln!("bridge: skills dir warning: {warning}");
                    response["warning"] = serde_json::json!(warning);
                }
                Err(e) => {
                    let warning =
                        format!("{} does not exist or is unreadable: {e}", path.display());
                    eprintln!("bridge: skills dir warning: {warning}");
                    response["warning"] = serde_json::json!(warning);
                }
            }
            println!("{response}");
        } else if let Some(system) = value.get("system") {
            // The API system prompt, read fresh each turn; never persisted.
            let Some(text) = system.as_str() else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "system needs a string" })
                );
                return;
            };
            *self.system.write().unwrap() = Some(text.to_string());
            eprintln!("bridge: system prompt set ({} chars)", text.len());
            println!("{}", serde_json::json!({ "system": "set" }));
        } else if let Some(context) = value.get("context") {
            // User context, injected at a conversation's birth and committed.
            let Some(text) = context.as_str() else {
                println!(
                    "{}",
                    serde_json::json!({ "error": "context needs a string" })
                );
                return;
            };
            *self.context.write().unwrap() = Some(text.to_string());
            eprintln!("bridge: context set ({} chars)", text.len());
            println!("{}", serde_json::json!({ "context": "set" }));
        } else {
            println!("{}", serde_json::json!({ "error": "unsupported" }));
        }
    }
}

/// Parse one control line and hand it to the host. Shared by the -c batch and
/// the live stdin loop, so both surfaces answer identically.
async fn handle_line(host: &Host, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        println!("{}", serde_json::json!({ "error": "unparseable" }));
        return;
    };
    host.handle(value).await;
}

/// The -c batch: `-c <lines>` or `-c=<lines>`, newline-separated control lines
/// run before stdin takes over. None when the flag is absent.
fn c_flag(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "-c" {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix("-c=") {
            return Some(v.to_string());
        }
    }
    None
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Which build this is: the cheapest guard against running a stale binary.
    eprintln!(
        "bridge {} ({}) built {}",
        env!("CARGO_PKG_VERSION"),
        env!("BRIDGE_GIT_HASH"),
        env!("BRIDGE_BUILD_TIME"),
    );
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    // ANTHROPIC_API_KEY when set; otherwise the Claude Code OAuth token.
    let auth = anthropic::Auth::resolve()?;
    let default_model = std::env::var("BRIDGE_MODEL").unwrap_or_else(|_| "claude-sonnet-5".into());
    // The world is a durable name for a place, deployer-chosen; the process
    // standing in it is disposable and mints a fresh instance id per boot.
    let world = std::env::var("BRIDGE_WORLD").unwrap_or_else(|_| "local".into());
    let instance = uuid::Uuid::new_v4().to_string();

    // The skills root, shared and mutable so a stdio `skills` control line can
    // repoint it live. No default: until a `skills` line (from -c or live
    // stdin) points it somewhere, the catalogue is empty and the Skill tool is
    // not offered. An empty path scans to an empty catalogue.
    let skills_root = Arc::new(RwLock::new(std::path::PathBuf::new()));
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
    // The oversized-tool-output store: content-addressed, ephemeral is fine
    // (unlike conversation state, losing it across a restart is not data
    // loss, only a stale ref id). Defaults under the OS temp dir so no new
    // config is required to get it working.
    let refs_path = std::env::var("BRIDGE_REFS_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("bridge-refs.db"));
    let refs_store = refs::open(&refs_path).map_err(|e| anyhow::anyhow!(e))?;
    // Shared with claude-sdk-cli's own SqliteMemoryEngine — same file, same
    // schema, so a memory either process writes is visible to the other.
    let memory_path = std::env::var("BRIDGE_MEMORY_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join(".claude")
                .join("memory.db")
        });
    let memory_store = memory::open(&memory_path).map_err(|e| anyhow::anyhow!(e))?;
    // Shared with claude-sdk-cli's own SqliteHistoryEngine — same file, same
    // schema. Written best-effort on every committed message (agent.rs's
    // Publisher::message), read by SearchHistory/ReadHistory.
    let history_path = std::env::var("BRIDGE_HISTORY_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join(".claude")
                .join("history.db")
        });
    let history_store = history::open(&history_path).map_err(|e| anyhow::anyhow!(e))?;

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

    // Host: the shared config and live cells every control line reads. One
    // grammar, two delivery points — the -c batch, then live stdin.
    let host = Host {
        client: client.clone(),
        world,
        instance,
        default_model,
        refs: refs_store,
        memory: memory_store,
        history: history_store,
        auth,
        skills_root,
        system: Arc::new(RwLock::new(None)),
        context: Arc::new(RwLock::new(None)),
        attach_bucket,
        thinking_budget,
    };

    // -c: a batch of control lines run before stdin takes over. Each writes its
    // response to stdout, so a launcher reads back a spawn's conversationId.
    let args: Vec<String> = std::env::args().collect();
    if let Some(batch) = c_flag(&args) {
        for line in batch.lines() {
            handle_line(&host, line).await;
        }
    }

    // The live stdio control loop: one JSON object per line in, one per line
    // out. Unknown lines are answered; compliance is answering, on every
    // surface.
    let tool_names: Vec<String> = agent::static_tool_schemas()
        .iter()
        .filter_map(|t| t["name"].as_str().map(str::to_owned))
        .collect();
    eprintln!(
        "bridge: tools: {} (+ Skill once a catalogue is set)",
        tool_names.join(", ")
    );
    eprintln!(
        "bridge: ready (model {}); spawn with {{\"spawn\":{{}}}}",
        host.default_model
    );
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        handle_line(&host, &line).await;
    }
    // stdin closed: keep serving what was spawned until killed.
    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::expand_tilde;

    #[test]
    fn expands_a_leading_tilde_slash_to_home() {
        let home = std::env::var("HOME").expect("HOME set in test environment");
        let expanded = expand_tilde("~/repos/skills");
        assert_eq!(
            expanded,
            std::path::PathBuf::from(home).join("repos/skills")
        );
    }

    #[test]
    fn expands_a_bare_tilde_to_home() {
        let home = std::env::var("HOME").expect("HOME set in test environment");
        assert_eq!(expand_tilde("~"), std::path::PathBuf::from(home));
    }

    #[test]
    fn leaves_an_absolute_path_unchanged() {
        assert_eq!(
            expand_tilde("/abs/path"),
            std::path::PathBuf::from("/abs/path")
        );
    }

    #[test]
    fn leaves_a_relative_path_unchanged() {
        assert_eq!(
            expand_tilde("rel/path"),
            std::path::PathBuf::from("rel/path")
        );
    }

    #[test]
    fn does_not_expand_a_tilde_that_is_not_a_path_prefix() {
        // "~foo" (another user's home) is deliberately not handled — only
        // the bare current-user forms (`~`, `~/...`) are.
        assert_eq!(
            expand_tilde("~foo/bar"),
            std::path::PathBuf::from("~foo/bar")
        );
    }
}
