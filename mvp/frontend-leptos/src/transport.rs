//! transport — the one thing that touches the wire (docs/mvp/
//! frontend-architecture.md). It owns the socket, decodes each frame into a
//! typed `ServerMsg`, and holds NO domain state: it knows bytes and frames,
//! never conversations, approvals, or rows.
//!
//! Shape difference from frontend-rs's transport (egui): that build pulls —
//! `drain()` hands the app an owned `Vec<ServerMsg>` once a frame, and the app
//! fans each frame out to every concern's `apply`. Leptos is push-based (a
//! reactive graph, not a redraw loop), so there is no "next frame" to drain
//! on. This transport instead takes an `on_message` callback at connect time
//! and invokes it once per decoded frame, still fanned out to every concern
//! from the composition root — the fan-out shape survives, only the trigger
//! (pull vs push) changes. That is the Leptos-vs-egui finding the plan asked
//! for on the composition root, surfacing here at the transport boundary
//! instead.
//!
//! Request/response correlation (say/answer/cancel) is deliberately NOT here:
//! each concern mints and matches its own request id, so transport stays
//! purely bytes<->frames with no id map to keep.

use ws_types::{ClientMsg, ServerMsg};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Connecting,
    Connected,
    Closed,
}

/// Decode one wire frame. Tolerant: an unparseable frame yields `None`
/// (skipped, never fatal — the client's own version of the wire's leniency).
/// Split out from the wasm socket plumbing so it is tested natively without a
/// browser.
pub fn decode(text: &str) -> Option<ServerMsg> {
    match serde_json::from_str::<ServerMsg>(text) {
        Ok(frame) => Some(frame),
        Err(err) => {
            log(&format!("transport: unparseable frame: {err}"));
            None
        }
    }
}

pub fn encode(msg: &ClientMsg) -> Option<String> {
    match serde_json::to_string(msg) {
        Ok(text) => Some(text),
        Err(err) => {
            log(&format!("transport: failed to encode {msg:?}: {err}"));
            None
        }
    }
}

fn log(msg: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::log_1(&msg.into());
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{msg}");
}

/// A client-minted request id; any unique string (ws-spec). One counter per
/// transport instance, so ids never collide across concerns that share it.
#[derive(Default)]
pub struct IdCounter(u64);

impl IdCounter {
    pub fn next(&mut self) -> String {
        self.0 += 1;
        format!("r{}", self.0)
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use futures::{SinkExt, StreamExt};
    use gloo_net::websocket::{Message, futures::WebSocket};
    use leptos::prelude::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use std::time::Duration;

    /// Reconnect backoff (docs/mvp/frontend-parity.md, "Transport /
    /// connection lifecycle"): matches the Svelte reference
    /// (core/transport.svelte.ts) — 500ms initial, doubling, capped at 10s,
    /// reset the moment a connection proves itself by delivering a frame.
    const INITIAL_RETRY_MS: u32 = 500;
    const MAX_RETRY_MS: u32 = 10_000;

    type Sink = Rc<RefCell<futures::stream::SplitSink<WebSocket, Message>>>;
    type OnMessage = Rc<dyn Fn(ServerMsg)>;

    pub struct Transport {
        status: RwSignal<Status>,
        sink: Sink,
    }

    impl Transport {
        /// Connects and spawns the read loop. `on_message` is invoked once per
        /// decoded frame — the composition root fans it out to every concern.
        /// A closed or errored socket is not fatal: the read loop reconnects
        /// itself with exponential backoff (`schedule_reconnect`) instead of
        /// finishing, so a dropped connection recovers on its own rather than
        /// leaving a dead tab until manual reload.
        pub fn connect(ws_url: &str, on_message: impl Fn(ServerMsg) + 'static) -> Result<Self, String> {
            let ws = WebSocket::open(ws_url).map_err(|e| e.to_string())?;
            let (write, read) = ws.split();
            let status = RwSignal::new(Status::Connecting);
            let sink: Sink = Rc::new(RefCell::new(write));
            let on_message: OnMessage = Rc::new(on_message);
            let retry_ms = Rc::new(Cell::new(INITIAL_RETRY_MS));

            spawn_read_loop(ws_url.to_string(), status, sink.clone(), on_message, read, retry_ms);

            Ok(Self { status, sink })
        }

        pub fn status(&self) -> Status {
            self.status.get()
        }

        pub fn send(&self, msg: &ClientMsg) {
            let Some(text) = encode(msg) else {
                return;
            };
            let sink = self.sink.clone();
            wasm_bindgen_futures::spawn_local(async move {
                if let Err(err) = sink.borrow_mut().send(Message::Text(text)).await {
                    log(&format!("transport: send failed: {err}"));
                }
            });
        }
    }

    /// Runs one connection's read loop until the socket closes or errors,
    /// then hands off to `schedule_reconnect` — the task never finishes for
    /// good while the tab is alive, matching Svelte's `ws.onclose` always
    /// rearming a fresh `connect()`.
    fn spawn_read_loop(
        ws_url: String,
        status: RwSignal<Status>,
        sink: Sink,
        on_message: OnMessage,
        mut read: futures::stream::SplitStream<WebSocket>,
        retry_ms: Rc<Cell<u32>>,
    ) {
        wasm_bindgen_futures::spawn_local(async move {
            while let Some(msg) = read.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        status.set(Status::Connected);
                        // A frame proves the connection: reset the backoff,
                        // same as Svelte resetting `#retryMs` in `ws.onopen`.
                        retry_ms.set(INITIAL_RETRY_MS);
                        if let Some(frame) = decode(&text) {
                            on_message(frame);
                        }
                    }
                    Ok(Message::Bytes(_)) => {} // binary: nothing to decode
                    Err(err) => {
                        log(&format!("transport: socket error: {err}"));
                        break;
                    }
                }
            }
            status.set(Status::Closed);
            schedule_reconnect(ws_url, status, sink, on_message, retry_ms);
        });
    }

    /// Waits the current backoff, then reopens the socket — 500ms, doubling,
    /// capped at 10s (mirrors core/transport.svelte.ts's
    /// `setTimeout(() => this.connect(), retryMs)` followed by
    /// `retryMs = min(retryMs * 2, 10_000)`).
    fn schedule_reconnect(ws_url: String, status: RwSignal<Status>, sink: Sink, on_message: OnMessage, retry_ms: Rc<Cell<u32>>) {
        let delay_ms = retry_ms.get();
        retry_ms.set((delay_ms * 2).min(MAX_RETRY_MS));
        set_timeout(
            move || attempt_reconnect(ws_url, status, sink, on_message, retry_ms),
            Duration::from_millis(delay_ms as u64),
        );
    }

    /// One reconnect attempt. A synchronous open failure (the socket
    /// constructor itself rejecting, distinct from a later close) is treated
    /// the same as a dropped connection: log it and back off again.
    fn attempt_reconnect(ws_url: String, status: RwSignal<Status>, sink: Sink, on_message: OnMessage, retry_ms: Rc<Cell<u32>>) {
        status.set(Status::Connecting);
        match WebSocket::open(&ws_url) {
            Ok(ws) => {
                let (write, read) = ws.split();
                *sink.borrow_mut() = write;
                spawn_read_loop(ws_url, status, sink, on_message, read, retry_ms);
            }
            Err(err) => {
                log(&format!("transport: reconnect failed: {err}"));
                status.set(Status::Closed);
                schedule_reconnect(ws_url, status, sink, on_message, retry_ms);
            }
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use wasm::Transport;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_valid_frame() {
        let text = r#"{"type":"row","conv":"a","lastEvent":1,"lastKind":"message"}"#;
        assert!(matches!(decode(text), Some(ServerMsg::Row { .. })));
    }

    #[test]
    fn an_unparseable_frame_is_skipped_not_fatal() {
        assert!(decode("not json").is_none());
    }

    #[test]
    fn ids_are_unique_and_ordered() {
        let mut ids = IdCounter::default();
        assert_eq!(ids.next(), "r1");
        assert_eq!(ids.next(), "r2");
    }
}
