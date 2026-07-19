//! The axum surface: `/ws` (the contract), `GET /ref/{id}` (the bytes behind
//! a `$ref`, Range honoured for paged previews), and the frontend's built
//! `dist/` for everything else. Binds locally; no auth in v1.

use axum::Router;
use axum::extract::{Path, State, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tokio::sync::oneshot;

use crate::broker::{Broker, Clock};
use crate::views::{ViewQuery, ViewsHandle};
use crate::ws::run_session;

#[derive(Clone)]
pub struct AppState<B: Broker, C: Clock> {
    pub views: ViewsHandle,
    pub broker: B,
    pub clock: C,
    pub dist: std::path::PathBuf,
    /// The transit object store for attachments (ws-spec, POST /attachment).
    /// Optional: tests and object-store-less deployments run without it and
    /// the route answers 503 honestly.
    pub attach: Option<async_nats::jetstream::object_store::ObjectStore>,
}

pub fn router<B: Broker, C: Clock>(state: AppState<B, C>) -> Router {
    Router::new()
        .route("/ws", get(ws_upgrade::<B, C>))
        .route("/ref/{id}", get(get_ref::<B, C>))
        .route("/stats", get(get_stats::<B, C>))
        .route(
            "/attachment",
            axum::routing::post(post_attachment::<B, C>)
                // The default 2 MB body cap is smaller than a phone photo;
                // the transit store's own limits are the real bound.
                .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/attachment/{id}", get(get_attachment::<B, C>))
        .route("/", get(serve_index::<B, C>))
        .route("/{*path}", get(serve_asset::<B, C>))
        .with_state(state)
}

/// Table row counts, per-stream cursor positions, schema version and db
/// size, as plain JSON — the diagnostic route so "what's actually in the
/// db" doesn't need a manual sqlite3 session.
async fn get_stats<B: Broker, C: Clock>(State(state): State<AppState<B, C>>) -> Response {
    let (tx, rx) = oneshot::channel();
    if state
        .views
        .queries
        .send(ViewQuery::Stats { reply: tx })
        .await
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Ok(stats) = rx.await else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    axum::Json(stats).into_response()
}

/// Upload one attachment's bytes into the transit store. The id is minted
/// random — nothing lives long enough for content-addressing to buy
/// anything — and the store's TTL is the cleanup (no delete call exists).
async fn post_attachment<B: Broker, C: Clock>(
    State(state): State<AppState<B, C>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let Some(store) = &state.attach else {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "no attachment store configured",
        )
            .into_response();
    };
    let media_type = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let id = format!("att-{}", uuid::Uuid::new_v4());
    let size = body.len();
    let mut reader = body.as_ref();
    // The media type rides as object metadata so the preview route can
    // serve an honest Content-Type later.
    let meta = async_nats::jetstream::object_store::ObjectMetadata {
        name: id.clone(),
        description: Some(media_type.clone()),
        ..Default::default()
    };
    if let Err(e) = store.put(meta, &mut reader).await {
        eprintln!("attachment put failed: {e}");
        return (
            axum::http::StatusCode::BAD_GATEWAY,
            "attachment store put failed",
        )
            .into_response();
    }
    axum::Json(serde_json::json!({ "id": id, "mediaType": media_type, "size": size }))
        .into_response()
}

/// Preview an attachment while its object lives. Transit semantics on
/// purpose: past the store's TTL this honestly 404s — the record's chip
/// still states what was attached; the bytes were for the model.
async fn get_attachment<B: Broker, C: Clock>(
    State(state): State<AppState<B, C>>,
    Path(id): Path<String>,
) -> Response {
    let Some(store) = &state.attach else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Ok(mut object) = store.get(&id).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = object
        .info
        .description
        .clone()
        .unwrap_or_else(|| "application/octet-stream".into());
    let mut bytes = Vec::new();
    {
        use tokio::io::AsyncReadExt;
        if object.read_to_end(&mut bytes).await.is_err() {
            return StatusCode::BAD_GATEWAY.into_response();
        }
    }
    (
        [
            (header::CONTENT_TYPE, content_type),
            // Short-lived by nature: the object expires with the transit TTL.
            (header::CACHE_CONTROL, "private, max-age=300".into()),
        ],
        bytes,
    )
        .into_response()
}

async fn ws_upgrade<B: Broker, C: Clock>(
    State(state): State<AppState<B, C>>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| run_session(socket, state.views, state.broker, state.clock))
}

/// Content-addressed, so immutable and cacheable forever. The hint is at
/// best the Content-Type; anything unrecognisable ships as octet-stream.
async fn get_ref<B: Broker, C: Clock>(
    State(state): State<AppState<B, C>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let (tx, rx) = oneshot::channel();
    if state
        .views
        .queries
        .send(ViewQuery::Ref { id, reply: tx })
        .await
        .is_err()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    let Ok(Some((hint, bytes))) = rx.await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let content_type = if hint.contains('/') {
        hint
    } else {
        "application/octet-stream".into()
    };
    let total = bytes.len();

    // Range: one `bytes=a-b` / `bytes=a-` / `bytes=-n` slice — enough for
    // "preview the first 4 KB of a 500 KB result"; multipart ranges are not
    // this API's problem.
    if let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some((start, end)) = parse_range(range, total) {
            return (
                StatusCode::PARTIAL_CONTENT,
                [
                    (header::CONTENT_TYPE, content_type),
                    (
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{total}"),
                    ),
                    (header::ACCEPT_RANGES, "bytes".into()),
                    (
                        header::CACHE_CONTROL,
                        "public, max-age=31536000, immutable".into(),
                    ),
                ],
                bytes[start..=end].to_vec(),
            )
                .into_response();
        }
        return (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{total}"))],
        )
            .into_response();
    }

    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::ACCEPT_RANGES, "bytes".into()),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".into(),
            ),
        ],
        bytes,
    )
        .into_response()
}

/// `bytes=a-b` → inclusive (start, end), clamped; `None` = unsatisfiable.
fn parse_range(header: &str, total: usize) -> Option<(usize, usize)> {
    let spec = header.strip_prefix("bytes=")?;
    if total == 0 {
        return None;
    }
    let (from, to) = spec.split_once('-')?;
    match (from, to) {
        ("", n) => {
            // suffix: last n bytes
            let n: usize = n.parse().ok()?;
            if n == 0 {
                return None;
            }
            Some((total.saturating_sub(n), total - 1))
        }
        (a, "") => {
            let start: usize = a.parse().ok()?;
            (start < total).then_some((start, total - 1))
        }
        (a, b) => {
            let (start, end): (usize, usize) = (a.parse().ok()?, b.parse().ok()?);
            (start <= end && start < total).then_some((start, end.min(total - 1)))
        }
    }
}

async fn serve_index<B: Broker, C: Clock>(State(state): State<AppState<B, C>>) -> Response {
    serve_file(&state.dist.join("index.html")).await
}

/// Static assets from dist/, with the SPA fallback: an unknown path serves
/// index.html so client-side routes survive a refresh.
async fn serve_asset<B: Broker, C: Clock>(
    State(state): State<AppState<B, C>>,
    Path(path): Path<String>,
) -> Response {
    // No traversal: reject any segment that isn't a plain name.
    if path
        .split('/')
        .any(|seg| seg == ".." || seg.is_empty() || seg.starts_with('.'))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let file = state.dist.join(&path);
    if file.is_file() {
        serve_file(&file).await
    } else {
        serve_file(&state.dist.join("index.html")).await
    }
}

async fn serve_file(path: &std::path::Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mime = match path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("ico") => "image/x-icon",
                Some("woff2") => "font/woff2",
                _ => "application/octet-stream",
            };
            ([(header::CONTENT_TYPE, mime)], bytes).into_response()
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn range_shapes() {
        assert_eq!(parse_range("bytes=0-3", 10), Some((0, 3)));
        assert_eq!(parse_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(parse_range("bytes=-2", 10), Some((8, 9)));
        assert_eq!(parse_range("bytes=0-999", 10), Some((0, 9))); // clamped
        assert_eq!(parse_range("bytes=10-", 10), None); // past the end
        assert_eq!(parse_range("bytes=5-3", 10), None); // inverted
        assert_eq!(parse_range("chunks=0-3", 10), None); // not bytes
    }
}
