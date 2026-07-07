//! The HTTP surface: `POST /v1/messages` streaming SSE per the spec.

use std::convert::Infallible;
use std::pin::Pin;
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::routing::post;
use futures::Stream;
use futures::stream::{self, StreamExt};

use crate::protocol::{Delta, ErrorBody, MessageStart, MessagesRequest, Role, StreamEvent};
use crate::reply;

/// Delay between SSE deltas so streaming is visible in the clients (~50ms per spec).
const DELTA_DELAY: Duration = Duration::from_millis(50);

/// Build the application router. `main` binds it; tests can drive it directly.
pub fn router() -> Router {
    Router::new().route("/v1/messages", post(messages))
}

type SseStream = Sse<Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>>>;

async fn messages(
    payload: Result<Json<MessagesRequest>, JsonRejection>,
) -> Result<SseStream, (StatusCode, Json<ErrorBody>)> {
    let Json(request) = payload.map_err(|rejection| bad_request(rejection.body_text()))?;

    let last_user = request
        .messages
        .iter()
        .rev()
        .find(|message| message.role == Role::User)
        .ok_or_else(|| bad_request("messages must contain at least one user message".into()))?;

    let events = build_events(&reply::scripted_reply(&last_user.content));

    // Serialize eagerly so a (theoretical) serialization failure surfaces as an HTTP
    // error rather than a broken stream mid-flight.
    let mut sse_events = Vec::with_capacity(events.len());
    for event in &events {
        let data = serde_json::to_string(event)
            .map_err(|error| bad_request(format!("failed to serialize event: {error}")))?;
        sse_events.push(Event::default().event(event.name()).data(data));
    }

    let stream =
        stream::iter(sse_events.into_iter().enumerate()).then(|(index, event)| async move {
            if index > 0 {
                tokio::time::sleep(DELTA_DELAY).await;
            }
            Ok(event)
        });

    Ok(Sse::new(Box::pin(stream)
        as Pin<
            Box<dyn Stream<Item = Result<Event, Infallible>> + Send>,
        >))
}

/// The full scripted event sequence for one reply.
fn build_events(reply_text: &str) -> Vec<StreamEvent> {
    let mut events = vec![StreamEvent::MessageStart {
        message: MessageStart {
            id: "msg_1".into(),
            role: Role::Assistant,
        },
    }];
    events.extend(reply::word_chunks(reply_text).into_iter().map(|text| {
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: Delta::TextDelta { text },
        }
    }));
    events.push(StreamEvent::MessageStop);
    events
}

fn bad_request(message: String) -> (StatusCode, Json<ErrorBody>) {
    (StatusCode::BAD_REQUEST, Json(ErrorBody { error: message }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_sequence_is_start_deltas_stop() {
        let events = build_events("one two");
        assert!(matches!(
            events.first(),
            Some(StreamEvent::MessageStart { .. })
        ));
        assert!(matches!(events.last(), Some(StreamEvent::MessageStop)));
        let delta_count = events
            .iter()
            .filter(|e| matches!(e, StreamEvent::ContentBlockDelta { .. }))
            .count();
        assert_eq!(delta_count, 2);
        assert_eq!(events.len(), delta_count + 2);
    }
}
