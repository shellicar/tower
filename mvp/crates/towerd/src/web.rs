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
}

pub fn router<B: Broker, C: Clock>(state: AppState<B, C>) -> Router {
    Router::new()
        .route("/ws", get(ws_upgrade::<B, C>))
        .route("/ref/{id}", get(get_ref::<B, C>))
        .route("/", get(serve_index::<B, C>))
        .route("/{*path}", get(serve_asset::<B, C>))
        .with_state(state)
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
