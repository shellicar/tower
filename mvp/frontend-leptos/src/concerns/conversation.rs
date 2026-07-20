//! concerns/conversation — the open conversations' owned store (docs/mvp/
//! frontend-architecture.md). Owns a keyed map of open conversations and
//! their content, folds its OWN slices of the wire (its convs' messages,
//! streaming, query closures), and drives say/cancel.
//!
//! Each open conversation gets its OWN `RwSignal<ConversationState>` rather
//! than one signal for the whole map: Leptos's reactivity is per-signal, so
//! a delta arriving for conversation A must only invalidate renders that
//! read A's state, never B's. With one shared signal, opening several
//! panels while any one of them streams re-rendered every open panel on
//! every chunk — measured live as CPU scaling with panel count, not message
//! rate. `Conversations` itself is NOT behind a Leptos signal (app.rs holds
//! it as a `StoredValue`, like `ids`/`transport`): which conversations exist
//! is already reactive through `view.tab().convs`; this struct is just the
//! lookup table plus the outstanding-request ledger, neither of which
//! anything renders directly.
//!
//! Correlation is local, the fan-out way: an outbound say/cancel mints a
//! request id, the concern records it, and the matching
//! `say_result`/`cancel_result` frame is resolved in `apply` by that id — no
//! promise, no await; the result arrives through the same fan-out as every
//! other frame. Action methods return the `ClientMsg` to send; the app (which
//! owns the transport and the id mint) sends it. So this concern touches no
//! socket.

use std::collections::HashMap;

use leptos::prelude::{Owner, RwSignal, Update, With};
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
    /// Whether the composer's Send should be enabled — pure and testable on
    /// purpose, instead of buried in a Leptos view closure (the trap named in
    /// the frontend-comparison doc: wasm-only UI code isn't native-checked).
    ///
    /// Priority, in order:
    /// 1. Uploading always blocks — nothing to send until it resolves.
    /// 2. OUR OWN live query always blocks: `decisions.rs`'s `on_say` makes
    ///    a say sent while our query is live `stale` (scenario 5) — sending
    ///    would just round-trip a guaranteed rejection, and disabling here
    ///    gives the same affordance the original design had ("query
    ///    running… cancel to speak"). Foreign activity (another sender's
    ///    query) is NOT this — it never reaches here because it isn't
    ///    `live_query`, only badges.
    /// 3. Real content (non-empty text or an attachment) is always sendable.
    /// 4. Empty otherwise: sendable only to resume — the tip is already a
    ///    dangling user-role message (a tool_result), matching
    ///    `decisions.rs`'s `SayDecision::Accept`-with-no-content case.
    pub fn can_send(&self, draft_empty: bool, has_attachments: bool, uploading: bool) -> bool {
        if uploading || self.live_query.is_some() {
            return false;
        }
        if !draft_empty || has_attachments {
            return true;
        }
        self.messages.last().is_some_and(|m| m.role == "user")
    }

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

pub struct Conversations {
    open: HashMap<String, RwSignal<ConversationState>>,
    /// Which convs we've actually asked the server to open — separate from
    /// `open`'s keys on purpose. `get_or_create` populates `open` purely so a
    /// render has a signal to bind to, lazily and with no wire side effect;
    /// if `open()` reused `open`'s own keys to decide whether to send
    /// `ClientMsg::Open`, a render racing ahead of the click handler that
    /// calls `open()` could find the slot already filled and skip sending it
    /// — observed live as a panel that exists and folds gated broadcasts
    /// (usage, message timestamps) fine, yet never gets the catch-up history
    /// because nothing ever told towerd this session was open on it.
    requested: std::collections::HashSet<String>,
    pending: HashMap<String, Pending>,
    /// Every per-conversation signal is created under THIS owner — never
    /// under whatever reactive scope happens to be calling `get_or_create`
    /// (a `<For>` list item, when a panel first renders). A signal's Leptos
    /// lifetime follows the scope active when `RwSignal::new` runs, not
    /// whichever struct later holds its handle: parented to a `<For>` item,
    /// it gets disposed the moment that item leaves the DOM — which happens
    /// on a tab SWITCH, not just closing the conversation, since only the
    /// active tab's convs are in the list. `Conversations` (and the
    /// conversation's logical open-ness) outlives that; reading a signal
    /// after its scope disposed it panics, and in wasm one panic can take
    /// the whole reactive runtime down — observed live as clicking between
    /// conversations eventually breaking the entire UI, not just one panel.
    /// This owner is independent (a child of whatever scope `Conversations`
    /// itself was constructed in — the app root, which only goes away on
    /// page unload), so every signal it parents survives exactly as long as
    /// `Conversations` does.
    owner: Owner,
}

impl Default for Conversations {
    fn default() -> Self {
        Conversations {
            open: HashMap::new(),
            requested: std::collections::HashSet::new(),
            pending: HashMap::new(),
            owner: Owner::new(),
        }
    }
}

impl Conversations {
    /// The signal a panel reads/renders from, or None if not open. A `Copy`
    /// handle, not a borrow — cheap to fetch once per panel and hold.
    pub fn get(&self, conv: &str) -> Option<RwSignal<ConversationState>> {
        self.open.get(conv).copied()
    }

    /// The signal a panel binds to, creating a fresh one on demand if the
    /// open-set hasn't caught up to the render yet. Rendering is driven by
    /// `view.tab().convs` (reactive); `self.open`'s own insert (via `open()`,
    /// called separately by the app's actions) is not — a `StoredValue` read
    /// can't retrigger a render just because this map changed. So the render
    /// path must tolerate finding nothing yet and supply a placeholder itself,
    /// never filter the render list on this map's current contents (that was
    /// tried and broke: the filter's dependency on a non-reactive read meant
    /// a newly opened conversation could stay excluded even once its state
    /// existed). Sends nothing — `open()` is still what puts `ClientMsg::Open`
    /// on the wire; this only ever fills the same slot, a no-op the second time.
    pub fn get_or_create(&mut self, conv: &str) -> RwSignal<ConversationState> {
        let owner = self.owner.clone();
        *self
            .open
            .entry(conv.to_owned())
            .or_insert_with(|| owner.with(|| RwSignal::new(ConversationState::fresh())))
    }

    // ---- open-set: the app (composition root) mints the id and sends ----

    pub fn open(&mut self, conv: &str, id: String) -> Option<ClientMsg> {
        if !self.requested.insert(conv.to_owned()) {
            return None; // already asked — idempotent
        }
        self.get_or_create(conv);
        Some(ClientMsg::Open {
            id,
            conv: conv.to_owned(),
            after: None,
        })
    }

    /// Doesn't dispose the removed signal: a close can race a panel still
    /// mid-render (e.g. the reconcile effect firing around a tab switch),
    /// and a read after dispose panics — observed live as the Send button
    /// getting stuck disabled forever once that happened. A leaked signal on
    /// close is a small, bounded cost against that; letting Leptos's own GC
    /// (page reload, or a future real disposal point once the ordering is
    /// provably safe) reclaim it is the safer default for now.
    pub fn close(&mut self, conv: &str, id: String) -> Option<ClientMsg> {
        if !self.requested.remove(conv) {
            return None; // wasn't open
        }
        self.open.remove(conv);
        Some(ClientMsg::Close {
            id,
            conv: conv.to_owned(),
        })
    }

    // ---- speaking: id-correlated, optimism reconciled by the wire ----

    pub fn say(&mut self, conv: &str, text: String, id: String) -> Option<ClientMsg> {
        let oc = self.get(conv)?;
        let mut tip = None;
        let mut attachments = Vec::new();
        oc.update(|s| {
            // The premise is the sender's view of the tip; None claims empty.
            tip = s.messages.last().map(|m| m.id.clone());
            // Optimistic: greyed pending say.
            s.last_say = None;
            s.pending_say = Some(text.clone());
            // The accumulated uploads ride this say and stay pending until the
            // committed message supersedes them (or a failure hands them back).
            attachments = s.pending_attachments.clone();
        });
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
        if let Some(oc) = self.get(conv) {
            oc.update(|s| s.pending_attachments.extend(refs));
        }
    }

    /// Reconcile the wire-open set against a wanted list — the view
    /// concern's tab switch, ported from mvp/frontend's `Conversations.setOpen`.
    /// Opens what's missing, closes what's no longer wanted; `next_id` mints
    /// one id per message, same as every other action here.
    pub fn set_open(
        &mut self,
        wanted: &[String],
        next_id: &mut impl FnMut() -> String,
    ) -> Vec<ClientMsg> {
        let mut out = Vec::new();
        let currently: Vec<String> = self.open.keys().cloned().collect();
        for conv in &currently {
            if !wanted.contains(conv)
                && let Some(msg) = self.close(conv, next_id())
            {
                out.push(msg);
            }
        }
        for conv in wanted {
            if let Some(msg) = self.open(conv, next_id()) {
                out.push(msg);
            }
        }
        out
    }

    pub fn cancel(&mut self, conv: &str, id: String) -> Option<ClientMsg> {
        let oc = self.get(conv)?;
        let query = oc.with(|s| s.live_query.clone())?;
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
                if let Some(oc) = self.get(conv) {
                    oc.update(|s| {
                        for m in messages {
                            insert_message(&mut s.messages, m.clone());
                        }
                        s.loaded = true;
                    });
                }
            }
            ServerMsg::Message { conv, message } => {
                if let Some(oc) = self.get(conv) {
                    oc.update(|s| {
                        let supersedes_pending = s.pending_say.is_some()
                            && message.role == "user"
                            && s.live_query.as_deref() == Some(message.query.as_str());
                        insert_message(&mut s.messages, message.clone());
                        s.streaming.clear(); // a committed message supersedes the stream
                        if supersedes_pending {
                            s.pending_say = None;
                            s.pending_attachments.clear();
                        }
                    });
                }
            }
            ServerMsg::Streaming { conv, text } => {
                if let Some(oc) = self.get(conv) {
                    oc.update(|s| {
                        // Evidence a query is live (maybe not ours). Append to the
                        // current segment, or start a text one.
                        match s.streaming.last_mut() {
                            Some(seg) => seg.text.push_str(text),
                            None => s.streaming.push(StreamSegment {
                                block_type: "text".to_owned(),
                                text: text.clone(),
                            }),
                        }
                        s.query_state = QueryState::Live;
                    });
                }
            }
            ServerMsg::StreamBlock { conv, block_type } => {
                if let Some(oc) = self.get(conv) {
                    oc.update(|s| {
                        s.streaming.push(StreamSegment {
                            block_type: block_type.clone(),
                            text: String::new(),
                        });
                    });
                }
            }
            ServerMsg::Query {
                conv,
                query_id,
                reason,
            } => {
                if let Some(oc) = self.get(conv) {
                    oc.update(|s| {
                        s.query_state = QueryState::Idle;
                        s.streaming.clear();
                        if s.live_query.as_deref() == Some(query_id.as_str()) {
                            s.live_query = None;
                        }
                        if reason != "completed" {
                            s.last_say = Some(format!("query {reason}"));
                        }
                        s.restore_pending();
                    });
                }
            }
            ServerMsg::SayResult {
                id,
                outcome,
                query,
                reason,
            } => {
                if let Some(Pending::Say { conv }) = self.pending.remove(id)
                    && let Some(oc) = self.get(&conv)
                {
                    oc.update(|s| match outcome.as_str() {
                        "accepted" => {
                            s.last_say = None;
                            s.live_query = query.clone();
                            s.query_state = QueryState::Live;
                        }
                        "rejected" => {
                            s.last_say =
                                Some(format!("rejected: {}", reason.as_deref().unwrap_or("")));
                            s.restore_pending();
                        }
                        _ => {
                            s.last_say = Some(
                                "unreachable — nothing is serving this conversation".to_owned(),
                            );
                            s.restore_pending();
                        }
                    });
                }
            }
            ServerMsg::CancelResult {
                id,
                outcome,
                reason,
            } => {
                if let Some(Pending::Cancel { conv }) = self.pending.remove(id)
                    && let Some(oc) = self.get(&conv)
                {
                    oc.update(|s| match outcome.as_str() {
                        "rejected" => {
                            s.last_say = Some(format!(
                                "cancel rejected: {}",
                                reason.as_deref().unwrap_or("")
                            ));
                        }
                        "unreachable" => {
                            // No closure will arrive, so free the input.
                            s.last_say = Some(
                                "cancel unreachable — nothing is serving this conversation"
                                    .to_owned(),
                            );
                            s.live_query = None;
                            s.query_state = QueryState::Unknown;
                            s.restore_pending();
                        }
                        _ => {}
                    });
                }
            }
            _ => {} // not this concern's
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
            from: Some(json!({ "kind": "human" })),
            content: vec![json!({ "type": "text", "text": "hi" })],
            ts,
        }
    }

    fn open(convs: &mut Conversations, conv: &str) {
        convs.open(conv, "r1".into());
    }

    #[test]
    fn a_live_query_blocks_send_regardless_of_content() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.say("a", "hello".into(), "req1".into());
        c.apply(&ServerMsg::SayResult {
            id: "req1".into(),
            outcome: "accepted".into(),
            query: Some("q1".into()),
            reason: None,
        });
        let oc = c.get("a").unwrap();
        assert!(oc.with(|s| s.live_query.is_some()));
        // Real content would normally be sendable, but our own live query
        // always wins — a say against it is a guaranteed `stale` (scenario
        // 5 in decisions.rs), so it must not look sendable here either.
        assert!(!oc.with(|s| s.can_send(false, false, false)));
        assert!(!oc.with(|s| s.can_send(true, true, false)));
    }

    #[test]
    fn uploading_always_blocks_even_with_content() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        let oc = c.get("a").unwrap();
        assert!(!oc.with(|s| s.can_send(false, false, true)));
        assert!(!oc.with(|s| s.can_send(true, true, true)));
    }

    #[test]
    fn real_content_is_always_sendable_when_not_busy_or_uploading() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        let oc = c.get("a").unwrap();
        assert!(oc.with(|s| s.can_send(false, false, false))); // text
        assert!(oc.with(|s| s.can_send(true, true, false))); // attachment alone
    }

    #[test]
    fn empty_send_is_sendable_only_to_resume_a_dangling_user_message() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        // No messages yet: nothing to resume.
        assert!(!c.get("a").unwrap().with(|s| s.can_send(true, false, false)));

        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m1", "q1", "assistant", 1),
        });
        // Tip is assistant: already answered, nothing to resume.
        assert!(!c.get("a").unwrap().with(|s| s.can_send(true, false, false)));

        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m2", "q1", "user", 2), // stands in for a tool_result
        });
        // Tip is a dangling user-role message: an empty send resumes it.
        assert!(c.get("a").unwrap().with(|s| s.can_send(true, false, false)));
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
        assert_eq!(c.get("a").unwrap().with(|s| s.messages.len()), 1);
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
        let ids: Vec<String> = c
            .get("a")
            .unwrap()
            .with(|s| s.messages.iter().map(|m| m.id.clone()).collect());
        assert_eq!(ids, ["m1", "m2"]);
    }

    #[test]
    fn say_is_optimistic_then_accepted_goes_live() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        let out = c.say("a", "hello".into(), "req1".into()).unwrap();
        assert!(matches!(out, ClientMsg::Say { .. }));
        assert_eq!(
            c.get("a").unwrap().with(|s| s.pending_say.clone()),
            Some("hello".to_owned())
        );
        c.apply(&ServerMsg::SayResult {
            id: "req1".into(),
            outcome: "accepted".into(),
            query: Some("q9".into()),
            reason: None,
        });
        let oc = c.get("a").unwrap();
        oc.with(|s| {
            assert_eq!(s.query_state, QueryState::Live);
            assert_eq!(s.live_query.as_deref(), Some("q9"));
        });
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
        oc.with(|s| {
            assert_eq!(s.pending_say, None);
            assert_eq!(s.restore_say.as_deref(), Some("hello"));
            assert_eq!(s.last_say.as_deref(), Some("rejected: stale"));
        });
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
        assert_eq!(c.get("a").unwrap().with(|s| s.pending_say.clone()), None);
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
        assert_eq!(
            c.get("a").unwrap().with(|s| s.pending_attachments.len()),
            1
        ); // still pending
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
        assert!(
            c.get("a")
                .unwrap()
                .with(|s| s.pending_attachments.is_empty())
        ); // committed clears
    }

    #[test]
    fn a_pending_attachment_can_be_dropped_before_it_ships() {
        let mut c = Conversations::default();
        open(&mut c, "a");
        c.attach(
            "a",
            vec![json!({ "type": "image" }), json!({ "type": "document" })],
        );
        let oc = c.get("a").unwrap();
        oc.update(|s| {
            if 0 < s.pending_attachments.len() {
                s.pending_attachments.remove(0);
            }
        });
        oc.with(|s| {
            assert_eq!(s.pending_attachments.len(), 1);
            assert_eq!(s.pending_attachments[0]["type"], "document");
        });
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
        let oc = c.get("a").unwrap();
        oc.with(|s| {
            assert_eq!(s.streaming[0].text, "hello");
            assert_eq!(s.query_state, QueryState::Live);
        });
        c.apply(&ServerMsg::Message {
            conv: "a".into(),
            message: msg("m1", "q", "assistant", 1),
        });
        assert!(c.get("a").unwrap().with(|s| s.streaming.is_empty()));
    }

    #[test]
    fn set_open_opens_the_missing_and_closes_the_unwanted() {
        let mut c = Conversations::default();
        let mut next = {
            let mut n = 0;
            move || {
                n += 1;
                format!("r{n}")
            }
        };
        open(&mut c, "a");
        open(&mut c, "b");
        let wanted = vec!["b".to_owned(), "c".to_owned()];
        let sent = c.set_open(&wanted, &mut next);
        assert!(c.get("a").is_none()); // closed
        assert!(c.get("b").is_some()); // stayed open
        assert!(c.get("c").is_some()); // newly opened
        assert_eq!(sent.len(), 2); // close a, open c
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
        oc.with(|s| {
            assert_eq!(s.query_state, QueryState::Idle);
            assert_eq!(s.live_query, None);
            assert_eq!(s.last_say.as_deref(), Some("query cancelled"));
        });
    }
}
