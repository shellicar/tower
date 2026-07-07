//! HTTP layer: static frontend files plus the `/ws` event feed.

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
    routing::get,
};
use tokio::sync::broadcast;
use tower_http::services::ServeDir;

use crate::bridge::TaggedEvent;

#[derive(Clone)]
pub struct AppState {
    pub tx: broadcast::Sender<TaggedEvent>,
}

pub fn router(state: AppState, static_dir: &str) -> Router {
    Router::new()
        .route("/ws", get(ws_upgrade))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(state)
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| forward_events(socket, state.tx.subscribe()))
}

/// Pump broadcast events into one WebSocket until either side closes.
async fn forward_events(mut socket: WebSocket, mut rx: broadcast::Receiver<TaggedEvent>) {
    loop {
        match rx.recv().await {
            Ok(tagged) => {
                let Ok(json) = serde_json::to_string(&tagged) else {
                    continue;
                };
                if socket.send(Message::Text(json.into())).await.is_err() {
                    return; // client went away
                }
            }
            // Slow client skipped some events; keep going with what's current.
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}
