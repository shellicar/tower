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
    // Which stream captures which subjects is deployment configuration; the
    // defaults match the three-way retention split (migrate-stream-retention.sh):
    // audit (unlimited), diagnostic (90d), ephemeral (3d) — one ingest loop
    // and one cursor row per stream, all folding into the same views.
    let stream_audit =
        std::env::var("TOWER_STREAM_AUDIT").unwrap_or_else(|_| "conv-approval".into());
    let stream_diagnostic =
        std::env::var("TOWER_STREAM_DIAGNOSTIC").unwrap_or_else(|_| "conv-diagnostic".into());
    let stream_ephemeral =
        std::env::var("TOWER_STREAM_EPHEMERAL").unwrap_or_else(|_| "conv-ephemeral".into());

    // Which db, streams, broker and port this instance is: the first thing to
    // know when more than one towerd runs on a machine (v1 beside v2, a stray
    // from a dead run). Without it a mismatched backend is invisible.
    eprintln!(
        "towerd: db {db_path} · streams {stream_audit}/{stream_diagnostic}/{stream_ephemeral} · nats {nats_url} · bind {bind}"
    );

    // Storage first: the schema must exist before the views thread starts.
    let db = rusqlite::Connection::open(&db_path)?;
    apply_schema(&db)?;

    let client = async_nats::connect(&nats_url).await?; // fail-fast

    let (events_tx, events_rx) = mpsc::channel::<(String, u64, wire::WireEvent)>(1024);
    let (queries_tx, queries_rx) = mpsc::channel::<views::ViewQuery>(64);
    let (view_events_tx, _) = broadcast::channel::<views::ViewEvent>(1024);

    // Views: the one struct, on its own OS thread.
    let views = Views::new(db, view_events_tx.clone());
    std::thread::spawn(move || views.run_blocking(events_rx, queries_rx));

    // Ingest: plain async fn, worker pool, one task per stream. Where to
    // resume is the views' call — ingest reconciles the stream incarnation
    // against the cursor on every consumer build (see ingest.rs). A hiccup
    // on one stream never stalls the other two: three independent loops,
    // sharing only the channels into the one views thread.
    tokio::spawn(ingest::run_ingest(
        client.clone(),
        stream_audit,
        &ingest::AUDIT_SUBJECTS,
        queries_tx.clone(),
        events_tx.clone(),
    ));
    tokio::spawn(ingest::run_ingest(
        client.clone(),
        stream_diagnostic,
        &ingest::DIAGNOSTIC_SUBJECTS,
        queries_tx.clone(),
        events_tx.clone(),
    ));
    tokio::spawn(ingest::run_ingest(
        client.clone(),
        stream_ephemeral,
        &ingest::EPHEMERAL_SUBJECTS,
        queries_tx.clone(),
        events_tx,
    ));

    // The transit object store for attachments: get-or-create with the
    // configured TTL. Transit, not storage — expiry IS the cleanup.
    let attach_bucket = std::env::var("TOWER_ATTACH_BUCKET").unwrap_or_else(|_| "attach".into());
    let attach_ttl_s: u64 = std::env::var("TOWER_ATTACH_TTL_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3600);
    let js = async_nats::jetstream::new(client.clone());
    let attach = match js.get_object_store(&attach_bucket).await {
        Ok(store) => Some(store),
        Err(_) => match js
            .create_object_store(async_nats::jetstream::object_store::Config {
                bucket: attach_bucket.clone(),
                description: Some("tower attachment transit".into()),
                max_age: std::time::Duration::from_secs(attach_ttl_s),
                ..Default::default()
            })
            .await
        {
            Ok(store) => Some(store),
            Err(e) => {
                // Uploads answer 503; everything else works. Honest degrade.
                eprintln!("towerd: attachment store unavailable: {e}");
                None
            }
        },
    };

    // Web: axum serves frontend dist/ + /ws + /ref/{id} + /attachment.
    let state = web::AppState {
        views: ViewsHandle {
            queries: queries_tx,
            events: view_events_tx,
        },
        broker: NatsBroker { client },
        clock: SystemClock,
        dist: std::env::var("TOWER_DIST")
            .unwrap_or_else(|_| "frontend-leptos/dist".into())
            .into(),
        attach,
    };
    let app = web::router(state);
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    eprintln!("towerd listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}
