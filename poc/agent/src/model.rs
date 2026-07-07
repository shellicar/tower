//! The model seam. The turn loop depends on [`ModelClient`]; the real SSE/HTTP
//! implementation lives behind it, and tests drive the loop with a scripted fake.

use std::collections::VecDeque;
use std::future::Future;

use futures::StreamExt;
use futures::stream::BoxStream;

use crate::protocol::{ChatMessage, ContentBlockDelta, ModelRequest};
use crate::sse::SseParser;

/// Text deltas as they arrive off the wire. Ends after `message_stop`; an `Err`
/// item means the turn failed mid-stream.
pub type TextStream = BoxStream<'static, Result<String, ModelError>>;

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("model request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("model returned HTTP {0}")]
    Status(u16),
    #[error("malformed model stream: {0}")]
    Protocol(String),
}

/// One completion request against the conversation so far.
pub trait ModelClient: Send + 'static {
    fn stream_reply(
        &self,
        messages: Vec<ChatMessage>,
    ) -> impl Future<Output = Result<TextStream, ModelError>> + Send;
}

/// The real client: `POST /v1/messages`, SSE consumed incrementally as chunks
/// arrive — the whole response is never buffered.
pub struct HttpModelClient {
    http: reqwest::Client,
    base_url: String,
}

impl HttpModelClient {
    pub fn new(base_url: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url,
        }
    }
}

impl ModelClient for HttpModelClient {
    async fn stream_reply(&self, messages: Vec<ChatMessage>) -> Result<TextStream, ModelError> {
        let request = ModelRequest {
            model: "fake-1".into(),
            stream: true,
            max_tokens: 1024,
            messages,
        };
        let response = self
            .http
            .post(format!("{}/v1/messages", self.base_url))
            .json(&request)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            return Err(ModelError::Status(status.as_u16()));
        }

        let state = StreamState {
            bytes: response.bytes_stream().boxed(),
            parser: SseParser::new(),
            pending: VecDeque::new(),
            done: false,
        };
        Ok(futures::stream::unfold(state, drive).boxed())
    }
}

struct StreamState {
    bytes: BoxStream<'static, reqwest::Result<bytes::Bytes>>,
    parser: SseParser,
    pending: VecDeque<String>,
    done: bool,
}

/// One step of the SSE-to-deltas state machine: drain queued deltas first, then
/// pull the next chunk. `message_stop` ends the stream; a body that ends without
/// it is a protocol failure, so a truncated stream surfaces as a failed turn.
async fn drive(mut state: StreamState) -> Option<(Result<String, ModelError>, StreamState)> {
    loop {
        if let Some(text) = state.pending.pop_front() {
            return Some((Ok(text), state));
        }
        if state.done {
            return None;
        }
        match state.bytes.next().await {
            None => {
                state.done = true;
                return Some((
                    Err(ModelError::Protocol(
                        "stream ended without message_stop".into(),
                    )),
                    state,
                ));
            }
            Some(Err(e)) => {
                state.done = true;
                return Some((Err(ModelError::Http(e)), state));
            }
            Some(Ok(chunk)) => {
                for event in state.parser.push(&chunk) {
                    match event.event.as_deref() {
                        Some("content_block_delta") => {
                            match serde_json::from_str::<ContentBlockDelta>(&event.data) {
                                Ok(delta) => state.pending.push_back(delta.delta.text),
                                Err(e) => {
                                    state.done = true;
                                    return Some((
                                        Err(ModelError::Protocol(format!(
                                            "bad content_block_delta payload: {e}"
                                        ))),
                                        state,
                                    ));
                                }
                            }
                        }
                        Some("message_stop") => state.done = true,
                        // Unknown event types are skipped, per the spec's
                        // forward-compatibility rule.
                        _ => {}
                    }
                }
            }
        }
    }
}
