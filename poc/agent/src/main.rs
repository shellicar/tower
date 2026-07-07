//! Wiring only: parse args, construct, run.

use anyhow::{Context, Result, bail};
use clap::Parser;

use agent::agent::AgentCore;
use agent::bridge;
use agent::model::HttpModelClient;

/// Headless agent: NATS bridge up, streaming model HTTP client down.
#[derive(Parser)]
struct Args {
    /// Agent id (lowercase alphanumeric plus hyphens). Generated if absent.
    #[arg(long)]
    id: Option<String>,

    #[arg(long, default_value = "nats://localhost:4222")]
    nats_url: String,

    #[arg(long, default_value = "http://localhost:8090")]
    model_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let id = match args.id {
        Some(id) => validated(id)?,
        None => format!("agent-{:04x}", rand::random::<u16>()),
    };

    let nats = async_nats::connect(&args.nats_url)
        .await
        .with_context(|| format!("connecting to NATS at {}", args.nats_url))?;
    let core = AgentCore::new(HttpModelClient::new(args.model_url));

    eprintln!("agent {id}: connected, announcing");
    bridge::run(nats, id, core).await
}

fn validated(id: String) -> Result<String> {
    let ok = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        bail!("invalid agent id {id:?}: lowercase alphanumeric plus hyphens only");
    }
    Ok(id)
}
