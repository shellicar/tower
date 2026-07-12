//! towerd: ingest → views → web (docs/mvp/tower-v1-design.md). Startup order
//! is the design's: open db → read cursor → connect broker → spawn loops.
//! Shutdown = crash: transactions make them the same path.

use tokio::sync::{broadcast, mpsc};

use towerd::broker::{NatsBroker, SystemClock};
use towerd::views::{Views, ViewsHandle, apply_schema};
use towerd::{ingest, views, web};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Env vars override; the defaults are the local single-machine deployment,
    // so a bare `just run` works.
    let nats_url = std::env::var("NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".into());
    let bind = std::env::var("TOWER_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let db_path = std::env::var("TOWER_DB").unwrap_or_else(|_| "tower.db".into());
    // Which stream captures the event subjects is deployment configuration;
    // the default matches the deployed capture stream's name.
    let stream = std::env::var("TOWER_STREAM").unwrap_or_else(|_| "conv-approval".into());

    // Storage first: the schema must exist before the views thread starts.
    let db = rusqlite::Connection::open(&db_path)?;
    apply_schema(&db)?;

    let client = async_nats::connect(&nats_url).await?; // fail-fast

    let (events_tx, events_rx) = mpsc::channel::<(u64, wire::WireEvent)>(1024);
    let (queries_tx, queries_rx) = mpsc::channel::<views::ViewQuery>(64);
    let (view_events_tx, _) = broadcast::channel::<views::ViewEvent>(1024);

    // Views: the one struct, on its own OS thread.
    let views = Views::new(db, view_events_tx.clone());
    std::thread::spawn(move || views.run_blocking(events_rx, queries_rx));

    // Ingest: plain async fn, worker pool. Where to resume is the views'
    // call — ingest reconciles the stream incarnation against the cursor on
    // every consumer build (see ingest.rs).
    tokio::spawn(ingest::run_ingest(
        client.clone(),
        stream,
        queries_tx.clone(),
        events_tx,
    ));

    // Web: axum serves frontend dist/ + /ws + /ref/{id}.
    let state = web::AppState {
        views: ViewsHandle {
            queries: queries_tx,
            events: view_events_tx,
        },
        broker: NatsBroker { client },
        clock: SystemClock,
        dist: std::env::var("TOWER_DIST")
            .unwrap_or_else(|_| "frontend/dist".into())
            .into(),
    };
    let app = web::router(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("towerd listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
