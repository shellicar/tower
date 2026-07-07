//! Wiring only: parse args, construct, run.

use anyhow::{Context, Result};
use tokio::sync::broadcast;
use tower_backend::{bridge, server};

struct Args {
    nats_url: String,
    listen: String,
    static_dir: String,
}

fn parse_args() -> Args {
    let mut args = Args {
        nats_url: "nats://localhost:4222".to_string(),
        listen: "127.0.0.1:8091".to_string(),
        static_dir: "../frontend/dist".to_string(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let value = it.next();
        match (flag.as_str(), value) {
            ("--nats", Some(v)) => args.nats_url = v,
            ("--listen", Some(v)) => args.listen = v,
            ("--static-dir", Some(v)) => args.static_dir = v,
            _ => {}
        }
    }
    args
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();
    let args = parse_args();

    let client = async_nats::connect(&args.nats_url)
        .await
        .with_context(|| format!("connecting to NATS at {}", args.nats_url))?;

    let (tx, _) = broadcast::channel(1024);
    let state = server::AppState { tx: tx.clone() };

    let bridge_task = tokio::spawn(bridge::run(client, tx));

    let listener = tokio::net::TcpListener::bind(&args.listen)
        .await
        .with_context(|| format!("binding {}", args.listen))?;
    tracing::info!("tower backend listening on {}", args.listen);

    let serve = axum::serve(listener, server::router(state, &args.static_dir));

    tokio::select! {
        r = serve => r.context("http server")?,
        r = bridge_task => r.context("bridge task panicked")??,
        _ = tokio::signal::ctrl_c() => {}
    }
    Ok(())
}
