//! transport — the one thing that touches the wire (docs/mvp/
//! frontend-architecture.md). It owns the socket, decodes each frame into a
//! typed `ServerMsg`, and holds connection state. It holds NO domain state: it
//! knows bytes and frames, never conversations, approvals, or rows.
//!
//! The socket is the frontend's one real concurrency boundary; `ewebsock`
//! already models it the idiomatic way — a channel pair drained by `try_recv`
//! each frame. Past that boundary everything is single-threaded ownership, so
//! `drain` hands the app an owned `Vec<ServerMsg>` and the borrow ends there;
//! the app then offers each frame to every concern's `apply`.
//!
//! Request/response correlation (say/answer/cancel) is deliberately NOT here:
//! in the fan-out shape each concern mints and matches its own request id, so
//! transport stays purely bytes<->frames with no id map to keep. The seam for
//! any shared correlation appears if a second consumer ever needs it.

use ewebsock::{WsEvent, WsMessage, WsReceiver, WsSender};
use ws_types::{ClientMsg, ServerMsg};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Connecting,
    Connected,
    Closed,
}

pub struct Transport {
    sender: WsSender,
    receiver: WsReceiver,
    status: Status,
    next_id: u64,
}

impl Transport {
    pub fn connect(ws_url: &str) -> Result<Self, String> {
        let (sender, receiver) = ewebsock::connect(ws_url, ewebsock::Options::default())?;
        Ok(Self {
            sender,
            receiver,
            status: Status::Connecting,
            next_id: 1,
        })
    }

    pub fn status(&self) -> Status {
        self.status
    }

    /// A client-minted request id; any unique string (ws-spec). One counter
    /// for the whole client, so ids never collide across concerns.
    pub fn next_id(&mut self) -> String {
        let id = format!("r{}", self.next_id);
        self.next_id += 1;
        id
    }

    /// Fire-and-forget send. Frames are JSON text (the ws-spec wire form).
    pub fn send(&mut self, msg: &ClientMsg) {
        match serde_json::to_string(msg) {
            Ok(text) => self.sender.send(WsMessage::Text(text)),
            Err(err) => web_log(&format!("transport: failed to encode {msg:?}: {err}")),
        }
    }

    /// Drain everything the socket has produced since last frame, decoding text
    /// into typed frames. Tolerant: an unparseable frame is skipped, never
    /// fatal (the client's own version of the wire's leniency). Socket
    /// lifecycle events fold into `status`.
    pub fn drain(&mut self) -> Vec<ServerMsg> {
        let mut out = Vec::new();
        while let Some(event) = self.receiver.try_recv() {
            match event {
                WsEvent::Opened => self.status = Status::Connected,
                WsEvent::Closed => self.status = Status::Closed,
                WsEvent::Error(err) => {
                    self.status = Status::Closed;
                    web_log(&format!("transport: socket error: {err}"));
                }
                WsEvent::Message(WsMessage::Text(text)) => {
                    match serde_json::from_str::<ServerMsg>(&text) {
                        Ok(frame) => out.push(frame),
                        Err(err) => web_log(&format!("transport: unparseable frame: {err}")),
                    }
                }
                WsEvent::Message(_) => {} // ping/pong/binary: nothing to decode
            }
        }
        out
    }
}

/// A log line that reaches the browser console on wasm and stderr on native
/// (tests). Keeps the transport free of `cfg` noise at each call site.
fn web_log(msg: &str) {
    #[cfg(target_arch = "wasm32")]
    web_sys::console::log_1(&msg.into());
    #[cfg(not(target_arch = "wasm32"))]
    eprintln!("{msg}");
}
