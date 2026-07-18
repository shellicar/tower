//! concerns/conversation — the open conversations' owned store (docs/mvp/
//! frontend-architecture.md), ported verbatim from frontend-rs's
//! conversation.rs: the fold logic is render-framework-agnostic. It owns a
//! keyed map of open conversations and their content, folds its OWN slices of
//! the wire (its convs' messages, streaming, query closures), and drives
//! say/cancel.
//!
//! Correlation is local, the fan-out way: an outbound say/cancel mints a
//! request id, the concern records it, and the matching
//! `say_result`/`cancel_result` frame is resolved in `apply` by that id — no
//! promise, no await; the result arrives through the same fan-out as every
//! other frame. Action methods return the `ClientMsg` to send; the app (which
//! owns the transport and the id mint) sends it. So this concern touches no
//! socket and, like every concern, its `apply(&mut self, &ServerMsg)` borrows
//! only itself.

use std::collections::HashMap;

use serde_json::Value;
use ws_types::{ClientMsg, ServerMsg, WsMessage};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueryState {
    /// The client's own knowledge — a fresh connection has no evidence.
    Unknown,
    Idle,
    Live,
}

/// One stretch of the in-flight stream: the marker said what it is, the chunks
/// accumulate into it. `block_type` is an open set — styled, never branched on.
#[derive(Debug, Clone)]
pub struct StreamSegment {
    pub block_type: String,
    pub text: String,
}

pub struct ConversationState {
    /// ts-ordered, deduped by message id.
    pub messages: Vec<WsMessage>,
    /// The in-flight stream as typed segments; cleared when the committed
    /// message lands.
    pub streaming: Vec<StreamSegment>,
    pub loaded: bool,
    pub query_state: QueryState,
    /// The query THIS client started, while live — what cancel targets.
    pub live_query: Option<String>,
    /// The say in flight: accepted but not committed — greyed, superseded by
    /// its committed message, returned to the editor if the query closes first.
    pub pending_say: Option<String>,
    pub pending_attachments: Vec<Value>,
    /// A revoked say handed back to the editor; the panel consumes it.
    pub restore_say: Option<String>,
    pub restore_attachments: Vec<Value>,
    /// Outcome of the last say, shown until the next.
    pub last_say: Option<String>,
}

impl ConversationState {
    fn fresh() -> Self {
        ConversationState {
            messages: Vec::new(),
            streaming: Vec::new(),
            loaded: false,
            query_state: QueryState::Unknown,
            live_query: None,
            pending_say: None,
            pending_attachments: Vec::new(),
            restore_say: None,
            restore_attachments: Vec::new(),
            last_say: None,
        }
    }

    /// The pending say comes home: words to the editor, files to the chips. One
    /// path for every failure shape — rejection, unreachable, revoked closure.
    fn restore_pending(&mut self) {
        if self.pending_say.is_some() {
            self.restore_say = self.pending_say.take();
        }
        if !self.pending_attachments.is_empty() {
            self.restore_attachments
                .append(&mut self.pending_attachments);
        }
    }
}

/// What an outstanding request will resolve, keyed by its minted id. The result
/// frames carry the id, not the conv, so the id is how they find their home.
enum Pending {
    Say { conv: String },
    Cancel { conv: String },
}

#[derive(Default)]
pub struct Conversations {
    open: HashMap<String, ConversationState>,
    pending: HashMap<String, Pending>,
}

impl Conversations {
    /// The state a panel renders, or None if not open.
    pub fn get(&self, conv: &str) -> Option<&ConversationState> {
        self.open.get(conv)
    }

    // ---- open-set: the app (composition root) mints the id and sends ----

    pub fn open(&mut self, conv: &str, id: String) -> Option<ClientMsg> {
        if self.open.contains_key(conv) {
            return None;
        }
        self.open
            .insert(conv.to_owned(), ConversationState::fresh());
        Some(ClientMsg::Open {
            id,
            conv: conv.to_owned(),
            after: None,
        })
    }

    pub fn close(&mut self, conv: &str, id: String) -> Option<ClientMsg> {
        self.open.remove(conv)?;
        Some(ClientMsg::Close {
            id,
            conv: conv.to_owned(),
        })
    }

    // ---- speaking: id-correlated, optimism reconciled by the wire ----

    pub fn say(&mut self, conv: &str, text: String, id: String) -> Option<ClientMsg> {
        let oc = self.open.get_mut(conv)?;
        // The premise is the sender's view of the tip; None claims empty.
        let tip = oc.messages.last().map(|m| m.id.clone());
        // Optimistic: greyed pending say.
        oc.last_say = None;
        oc.pending_say = Some(text.clone());
        // The accumulated uploads ride this say and stay pending until the
        // committed message supersedes them (or a failure hands them back).
        let attachments = oc.pending_attachments.clone();
        self.pending.insert(
            id.clone(),
            Pending::Say {
                conv: conv.to_owned(),
            },
        );
        Some(ClientMsg::Say {
            id,
            conv: conv.to_owned(),
            text,
            tip,
            attachments,
        })
    }

    /// Fold an uploaded attachment reference into the open conversation's
    /// pending set — it rides the next say. Called by the app when an upload
    /// completes, arriving over a channel: the async boundary is handled by
    /// communicating, not by a shared mutable write across an await.
    pub fn attach(&mut self, conv: &str, refs: Vec<Value>) {
        if let Some(oc) = self.open.get_mut(conv) {
            oc.pending_attachments.extend(refs);
        }
    }

    /// Drop one queued attachment before it rides a say — the chip's ×
    /// (mvp/frontend's `removeAttachment`). Silently a no-op past the end;
    /// the chip that fired this is already gone from a re-render by then.
    pub fn remove_pending_attachment(&mut self, conv: &str, index: usize) {
        if let Some(oc) = self.open.get_mut(conv)
            && index < oc.pending_attachments.len()
        {
            oc.pending_attachments.remove(index);
        }
    }

    pub fn cancel(&mut self, conv: &str, id: String) -> Option<ClientMsg> {
        let oc = self.open.get(conv)?;
        let query = oc.live_query.clone()?;
        self.pending.insert(
            id.clone(),
            Pending::Cancel {
                conv: conv.to_owned(),
            },
        );
        Some(ClientMsg::Cancel {
            id,
            conv: conv.to_owned(),
            query,
        })
    }

    pub fn apply(&mut self, event: &ServerMsg) {
        match event {
            ServerMsg::Conversation { conv, messages, .. } => {
                if let Some(oc) = self.open.get_mut(conv) {
                    for m in messages {
                        insert_message(&mut oc.messages, m.clone());
                    }
                    oc.loaded = true;
                }
            }
            ServerMsg::Message { conv, message } => {
                if let Some(oc) = self.open.get_mut(conv) {
                    let supersedes_pending = oc.pending_say.is_some()
                        && message.role == "user"
                        && oc.live_query.as_deref() == Some(message.query.as_str());
                    insert_message(&mut oc.messages, message.clone());
                    oc.streaming.clear(); // a committed message supersedes the stream
                    if supersedes_pending {
                        oc.pending_say = None;
                        oc.pending_attachments.clear();
                    }
                }
            }
            ServerMsg::Streaming { conv, text } => {
                if let Some(oc) = self.open.get_mut(conv) {
                    // Evidence a query is live (maybe not ours). Append to the
                    // current segment, or start a text one.
                    match oc.streaming.last_mut() {
                        Some(seg) => seg.text.push_str(text),
                        None => oc.streaming.push(StreamSegment {
                            block_type: "text".to_owned(),
                            text: text.clone(),
                        }),
                    }
                    oc.query_state = QueryState::Live;
                }
            }
            ServerMsg::StreamBlock { conv, block_type } => {
                if let Some(oc) = self.open.get_mut(conv) {
                    oc.streaming.push(StreamSegment {
                        block_type: block_type.clone(),
                        text: String::new(),
                    });
                }
            }
            ServerMsg::Query {
                conv,
                query_id,
                reason,
            } => {
                if let Some(oc) = self.open.get_mut(conv) {
                    oc.query_state = QueryState::Idle;
                    oc.streaming.clear();
                    if oc.live_query.as_deref() == Some(query_id.as_str()) {
                        oc.live_query = None;
                    }
                    if reason != "completed" {
                        oc.last_say = Some(format!("query {reason}"));
                    }
                    oc.restore_pending();
                }
            }
            ServerMsg::SayResult {
                id,
                outcome,
                query,
                reason,
            } => {
                if let Some(Pending::Say { conv }) = self.pending.remove(id)
                    && let Some(oc) = self.open.get_mut(&conv)
                {
                    match outcome.as_str() {
                        "accepted" => {
                            oc.last_say = None;
                            oc.live_query = query.clone();
                            oc.query_state = QueryState::Live;
                        }
                        "rejected" => {
                            oc.last_say =
                                Some(format!("rejected: {}", reason.as_deref().unwrap_or("")));
                            oc.restore_pending();
                        }
                        _ => {
                            oc.last_say = Some(
                                "unreachable — nothing is serving this conversation".to_owned(),
                            );
                            oc.restore_pending();
                        }
                    }
                }
            }
            ServerMsg::CancelResult {
                id,
                outcome,
                reason,
            } => {
                if let Some(Pending::Cancel { conv }) = self.pending.remove(id)
                    && let Some(oc) = self.open.get_mut(&conv)
                {
                    match outcome.as_str() {
                        "rejected" => {
                            oc.last_say = Some(format!(
                                "cancel rejected: {}",
                                reason.as_deref().unwrap_or("")
                            ));
                        }
                        "unreachable" => {
                            // No closure will arrive, so free the input.
                            oc.last_say = Some(
                                "cancel unreachable — nothing is serving this conversation"
                                    .to_owned(),
                            );
                            oc.live_query = None;
                            oc.query_state = QueryState::Unknown;
                            oc.restore_pending();
                        }
                        _ => {}
                    }
                }
            }
            _ => {} // not this concern's
        }
    }

    /// The panel consumed the revoked say and its attachments.
    pub fn consume_restore(&mut self, conv: &str) {
        if let Some(oc) = self.open.get_mut(conv) {
            oc.restore_say = None;
            oc.restore_attachments.clear();
        }
    }
}

/// Insert in ts order, dedupe by id (boundary overlap is expected). Same id =
/// replace (revisions keep the id; last write wins).
fn insert_message(messages: &mut Vec<WsMessage>, m: WsMessage) {
    if let Some(existing) = messages.iter_mut().find(|x| x.id == m.id) {
        *existing = m;
        return;
    }
    let ts = m.ts;
    let mut i = messages.len();
    while i > 0 && messages[i - 1].ts > ts {
        i -= 1;
    }
    messages.insert(i, m);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::time::Millis;
    use serde_json::json;

    fn msg(id: &str, query: &str, role: &str, ts: Millis) -> WsMessage {
        WsMessage {
            id: id.into(),
            query: query.into(),
            turn: "t".into(),
            role: role.into(),
            from: json!({ "kind": "human" }),
            content: vec![json!({ "type": "text", "text": "hi" })],
            ts,
        }
    }

    fn open(convs: &mut Conversations, conv: &str) {
        convs.open(conv, "r1".into());
    }

    #[test]
    fn content_is_gated_by_open() {
        let mut c = Conversations::default();
        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m1", "q1", "assistant", 1),
        });
        assert!(c.get("a").is_none());
        open(&mut c, "a");
        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m1", "q1", "assistant", 1),
        });
        assert_eq!(c.get("a").unwrap().messages.len(), 1);
    }

    #[test]
    fn messages_order_by_ts_and_dedupe_by_id() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        for m in [
            msg("m2", "q", "assistant", 20),
            msg("m1", "q", "user", 10),
            msg("m2", "q", "assistant", 20), // duplicate id → replace, not append
        ] {
            c.apply(&ServerMsg::Message {
                conv: "a".into(),
                message: m,
            });
        }
        let ids: Vec<&str> = c
            .get("a")
            .unwrap()
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(ids, ["m1", "m2"]);
    }

    #[test]
    fn say_is_optimistic_then_accepted_goes_live() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        let out = c.say("a", "hello".into(), "req1".into()).unwrap();
        assert!(matches!(out, ClientMsg::Say { .. }));
        assert_eq!(c.get("a").unwrap().pending_say.as_deref(), Some("hello"));
        c.apply(&ServerMsg::SayResult {
            id: "req1".into(),
            outcome: "accepted".into(),
            query: Some("q9".into()),
            reason: None,
        });
        let oc = c.get("a").unwrap();
        assert_eq!(oc.query_state, QueryState::Live);
        assert_eq!(oc.live_query.as_deref(), Some("q9"));
    }

    #[test]
    fn a_rejected_say_comes_home_to_the_editor() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.say("a", "hello".into(), "req1".into());
        c.apply(&ServerMsg::SayResult {
            id: "req1".into(),
            outcome: "rejected".into(),
            query: None,
            reason: Some("stale".into()),
        });
        let oc = c.get("a").unwrap();
        assert_eq!(oc.pending_say, None);
        assert_eq!(oc.restore_say.as_deref(), Some("hello"));
        assert_eq!(oc.last_say.as_deref(), Some("rejected: stale"));
    }

    #[test]
    fn the_committed_say_supersedes_the_pending_one() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.say("a", "hello".into(), "req1".into());
        c.apply(&ServerMsg::SayResult {
            id: "req1".into(),
            outcome: "accepted".into(),
            query: Some("q9".into()),
            reason: None,
        });
        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m1", "q9", "user", 5),
        });
        assert_eq!(c.get("a").unwrap().pending_say, None);
    }

    #[test]
    fn attachments_ride_the_say_and_clear_on_commit() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.attach(
            "a",
            vec![json!({ "type": "image", "source": { "type": "object", "id": "o1" } })],
        );
        let out = c.say("a", "look".into(), "req1".into()).unwrap();
        match out {
            ClientMsg::Say { attachments, .. } => assert_eq!(attachments.len(), 1),
            _ => panic!("expected a say"),
        }
        assert_eq!(c.get("a").unwrap().pending_attachments.len(), 1); // still pending
        c.apply(&ServerMsg::SayResult {
            id: "req1".into(),
            outcome: "accepted".into(),
            query: Some("q9".into()),
            reason: None,
        });
        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m1", "q9", "user", 5),
        });
        assert!(c.get("a").unwrap().pending_attachments.is_empty()); // committed clears
    }

    #[test]
    fn a_pending_attachment_can_be_dropped_before_it_ships() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.attach(
            "a",
            vec![json!({ "type": "image" }), json!({ "type": "document" })],
        );
        c.remove_pending_attachment("a", 0);
        let remaining = &c.get("a").unwrap().pending_attachments;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["type"], "document");
    }

    #[test]
    fn streaming_appends_then_a_committed_message_clears_it() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.apply(&ServerMsg::Streaming {
            conv: "a".into(),
            text: "hel".into(),
        });
        c.apply(&ServerMsg::Streaming {
            conv: "a".into(),
            text: "lo".into(),
        });
        assert_eq!(c.get("a").unwrap().streaming[0].text, "hello");
        assert_eq!(c.get("a").unwrap().query_state, QueryState::Live);
        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m1", "q", "assistant", 1),
        });
        assert!(c.get("a").unwrap().streaming.is_empty());
    }

    #[test]
    fn a_non_completed_closure_notes_and_idles() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.say("a", "hi".into(), "req1".into());
        c.apply(&ServerMsg::SayResult {
            id: "req1".into(),
            outcome: "accepted".into(),
            query: Some("q9".into()),
            reason: None,
        });
        c.apply(&ServerMsg::Query {
            conv: "a".into(),
            query_id: "q9".into(),
            reason: "cancelled".into(),
        });
        let oc = c.get("a").unwrap();
        assert_eq!(oc.query_state, QueryState::Idle);
        assert_eq!(oc.live_query, None);
        assert_eq!(oc.last_say.as_deref(), Some("query cancelled"));
    }
}
