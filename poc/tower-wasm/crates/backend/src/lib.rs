//! The tower-wasm backend: a NATS → WebSocket relay that also serves the
//! WASM frontend.
//!
//! Every NATS message on `agent.announce` or `agent.*.events` becomes an
//! [`Envelope`] (the raw event tagged with its agent id) broadcast to every
//! connected WebSocket client. The backend does not interpret events beyond
//! working out which agent they came from — folding is the frontend's job,
//! so unknown event types pass through intact.

use std::{net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::Context as _;
use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
    routing::get,
};
use futures::StreamExt as _;
use protocol::Envelope;
use tokio::sync::broadcast;
use tower_http::services::ServeDir;

pub struct Config {
    pub nats_url: String,
    pub port: u16,
    pub dist: PathBuf,
    /// Hard self-termination backstop so nothing is left running.
    pub ttl: Duration,
}

impl Config {
    /// Parse `--nats URL`, `--port N`, `--dist DIR`, `--ttl SECS`.
    pub fn from_args(mut args: impl Iterator<Item = String>) -> anyhow::Result<Self> {
        let mut config = Self {
            nats_url: "nats://localhost:4222".to_owned(),
            port: 8093,
            dist: PathBuf::from("crates/frontend/dist"),
            ttl: Duration::from_secs(120),
        };
        while let Some(flag) = args.next() {
            let value = args
                .next()
                .with_context(|| format!("missing value for `{flag}`"))?;
            match flag.as_str() {
                "--nats" => config.nats_url = value,
                "--port" => config.port = value.parse().context("--port")?,
                "--dist" => config.dist = PathBuf::from(value),
                "--ttl" => config.ttl = Duration::from_secs(value.parse().context("--ttl")?),
                other => anyhow::bail!("unknown flag `{other}`"),
            }
        }
        Ok(config)
    }
}

pub async fn run(config: Config) -> anyhow::Result<()> {
    let (tx, _) = broadcast::channel::<String>(1024);

    let relay = tokio::spawn(relay_nats(config.nats_url.clone(), tx.clone()));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(&config.dist))
        .with_state(tx);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;
    eprintln!(
        "tower-wasm backend listening on http://localhost:{}",
        config.port
    );

    tokio::select! {
        result = axum::serve(listener, app) => result.context("web server"),
        result = relay => result.context("relay task")?,
        _ = tokio::time::sleep(config.ttl) => {
            eprintln!("ttl of {}s reached; shutting down", config.ttl.as_secs());
            Ok(())
        }
    }
}

async fn relay_nats(url: String, tx: broadcast::Sender<String>) -> anyhow::Result<()> {
    let client = async_nats::connect(&url)
        .await
        .with_context(|| format!("connect to NATS at {url}"))?;
    let mut announce = client
        .subscribe("agent.announce")
        .await
        .context("subscribe agent.announce")?;
    let mut events = client
        .subscribe("agent.*.events")
        .await
        .context("subscribe agent.*.events")?;

    loop {
        let message = tokio::select! {
            Some(message) = announce.next() => message,
            Some(message) = events.next() => message,
            else => return Ok(()),
        };
        // Non-JSON payloads and unattributable messages are skipped: the
        // spec's forward-compatibility rule applied at the relay layer.
        let Ok(event) = serde_json::from_slice::<serde_json::Value>(&message.payload) else {
            continue;
        };
        let Some(agent_id) = agent_id_for(message.subject.as_str(), &event) else {
            continue;
        };
        let envelope = Envelope { agent_id, event };
        if let Ok(json) = serde_json::to_string(&envelope) {
            // No subscribers yet is fine; the send just drops.
            let _ = tx.send(json);
        }
    }
}

/// The agent id a message belongs to: from the payload for the announce
/// subject, from the subject itself for `agent.{id}.events`.
fn agent_id_for(subject: &str, event: &serde_json::Value) -> Option<String> {
    if subject == "agent.announce" {
        event
            .get("agentId")
            .and_then(|id| id.as_str())
            .map(str::to_owned)
    } else {
        subject
            .strip_prefix("agent.")?
            .strip_suffix(".events")
            .map(str::to_owned)
    }
}

async fn ws_handler(
    State(tx): State<broadcast::Sender<String>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| client_loop(socket, tx.subscribe()))
}

async fn client_loop(mut socket: WebSocket, mut rx: broadcast::Receiver<String>) {
    loop {
        tokio::select! {
            received = rx.recv() => match received {
                Ok(json) => {
                    if socket.send(Message::Text(json.into())).await.is_err() {
                        return;
                    }
                }
                // Slow client skipped some events; keep going with the rest.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            },
            incoming = socket.recv() => {
                // Tower only watches; drain pings/closes, drop anything else.
                if !matches!(incoming, Some(Ok(_))) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_subject_yields_id_from_subject() {
        let event = serde_json::json!({ "type": "text_delta" });
        assert_eq!(
            agent_id_for("agent.stub-a.events", &event),
            Some("stub-a".to_owned())
        );
    }

    #[test]
    fn announce_subject_yields_id_from_payload() {
        let event = serde_json::json!({ "type": "agent_ready", "agentId": "agent-4f2a" });
        assert_eq!(
            agent_id_for("agent.announce", &event),
            Some("agent-4f2a".to_owned())
        );
    }

    #[test]
    fn announce_without_agent_id_is_skipped() {
        let event = serde_json::json!({ "type": "agent_ready" });
        assert_eq!(agent_id_for("agent.announce", &event), None);
    }
}
