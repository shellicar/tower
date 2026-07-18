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
    use std::cell::RefCell;
    use std::rc::Rc;

    pub struct Transport {
        status: RwSignal<Status>,
        sink: Rc<RefCell<futures::stream::SplitSink<WebSocket, Message>>>,
    }

    impl Transport {
        /// Connects and spawns the read loop. `on_message` is invoked once per
        /// decoded frame — the composition root fans it out to every concern.
        pub fn connect(ws_url: &str, on_message: impl Fn(ServerMsg) + 'static) -> Result<Self, String> {
            let ws = WebSocket::open(ws_url).map_err(|e| e.to_string())?;
            let (write, mut read) = ws.split();
            let status = RwSignal::new(Status::Connecting);

            wasm_bindgen_futures::spawn_local({
                let status = status;
                async move {
                    while let Some(msg) = read.next().await {
                        match msg {
                            Ok(Message::Text(text)) => {
                                status.set(Status::Connected);
                                if let Some(frame) = decode(&text) {
                                    on_message(frame);
                                }
                            }
                            Ok(Message::Bytes(_)) => {} // binary: nothing to decode
                            Err(err) => {
                                log(&format!("transport: socket error: {err}"));
                                status.set(Status::Closed);
                            }
                        }
                    }
                    status.set(Status::Closed);
                }
            });

            Ok(Self {
                status,
                sink: Rc::new(RefCell::new(write)),
            })
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
