//! The conversation concern's own store — helm's document model for the one
//! conversation it attached to. Folds its OWN slice of the wire (messages,
//! streaming deltas, query state); everything else is another concern's
//! (usage, approvals — not yet built). Modelled directly on tower frontend's
//! `concerns/conversation.svelte.ts`: one fold, ts-ordered dedup-by-id
//! messages, streaming cleared the moment a committed message supersedes it.
//!
//! Pure and terminal-agnostic on purpose (tui-architecture.md's document
//! model layer): no I/O here, so it tests against the conformance fixtures
//! directly, the same discipline `wire`'s own fold tests use.

use wire::{ConvChange, ConvTelemetry, EventKind, Message as WireMessage};

/// One stretch of the in-flight stream: a block marker says what kind it is,
/// deltas accumulate into it. `block_type` is an open set (tui-architecture.md's
/// per-type rendering with fallback) — styled by layout later, never branched
/// on here.
#[derive(Debug, Clone, PartialEq)]
pub struct StreamSegment {
    pub block_type: String,
    pub text: String,
}

/// This client's own knowledge of the live query, learned only from its own
/// connection's evidence — a fresh attach knows nothing (`Unknown`), same as
/// tower's `QueryState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum QueryState {
    #[default]
    Unknown,
    Idle,
    Live,
}

#[derive(Debug, Clone, Default)]
pub struct Conversation {
    /// ts-ordered, deduped by message id (a revision replaces in place).
    pub messages: Vec<WireMessage>,
    /// The in-flight stream as typed segments; cleared when a committed
    /// message supersedes it.
    pub streaming: Vec<StreamSegment>,
    pub query_state: QueryState,
    /// The query this attach has seen start, while live.
    pub live_query: Option<String>,
    /// The say in flight: accepted but not committed — rendered greyed,
    /// superseded by its committed message (tower's pendingSay pattern).
    pub pending_say: Option<String>,
    /// A revoked say handed back for the editor; the input loop consumes it.
    pub restore_say: Option<String>,
}

impl Conversation {
    /// Insert in ts order; same id replaces (revisions keep the id, last
    /// write wins — conversation-spec). Boundary overlap on a reconnect is
    /// expected and handled the same way. Ordering compares parsed instants,
    /// never strings: wire timestamps carry mixed offsets and strings
    /// misorder (tower-v1-design, the ts rule); unparseable stamps fall back
    /// to string order rather than being dropped.
    fn insert_message(&mut self, m: WireMessage) {
        if let Some(existing) = self.messages.iter_mut().find(|x| x.id == m.id) {
            *existing = m;
            return;
        }
        let after = |a: &str, b: &str| match (wire::parse_ts(a), wire::parse_ts(b)) {
            (Some(a), Some(b)) => a > b,
            _ => a > b,
        };
        let pos = self
            .messages
            .iter()
            .position(|x| after(&x.ts, &m.ts))
            .unwrap_or(self.messages.len());
        self.messages.insert(pos, m);
    }

    /// Fold one already-decoded wire event into the document model. Anything
    /// not this concern's (agent/approval events, an Unknown frame) is a
    /// silent no-op — the same "not this concern's" tolerance every tower
    /// concern's fold uses.
    pub fn fold(&mut self, kind: &EventKind) {
        match kind {
            EventKind::Change(ConvChange::Message(m)) => {
                // A committed human say supersedes the pending one. Matching
                // on provenance, not just role: tool_results also commit as
                // role user, but nobody sent them.
                if m.role == "user"
                    && m.from.as_ref().and_then(|f| f["kind"].as_str()) == Some("human")
                {
                    self.pending_say = None;
                }
                self.insert_message(m.clone());
                self.streaming.clear(); // a committed message supersedes the stream
            }
            EventKind::Change(ConvChange::Revision(r)) => {
                if let Some(existing) = self.messages.iter_mut().find(|x| x.id == r.message_id) {
                    existing.content = r.content.clone();
                }
            }
            EventKind::Change(ConvChange::Query(q)) => {
                self.query_state = QueryState::Idle;
                self.streaming.clear();
                if self.live_query.as_deref() == Some(q.query_id.0.as_str()) {
                    self.live_query = None;
                }
                // The query closed with the say still pending: it never
                // committed (a cancel revoked it) — words go home, not away.
                if let Some(text) = self.pending_say.take() {
                    self.restore_say = Some(text);
                }
            }
            EventKind::Change(ConvChange::TipMoved(_)) => {}
            EventKind::Telemetry(ConvTelemetry::TurnStarted(t)) => {
                self.query_state = QueryState::Live;
                self.live_query = Some(t.query_id.0.clone());
            }
            EventKind::Delta(d) => {
                self.query_state = QueryState::Live; // evidence a query is live, ours or not
                match self.streaming.last_mut() {
                    Some(seg) => seg.text.push_str(&d.text),
                    None => self.streaming.push(StreamSegment {
                        block_type: "text".into(),
                        text: d.text.clone(),
                    }),
                }
            }
            EventKind::Block(b) => {
                self.streaming.push(StreamSegment {
                    block_type: b.block_type.clone(),
                    text: String::new(),
                });
            }
            // Telemetry beyond turn_started, and Unknown frames: not this
            // concern's (usage belongs to its own concern once it exists).
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::WireEvent;

    /// Replays a fixture line-by-line the same way helm's transport hands
    /// events to this fold: (subject, payload) in, decoded once by
    /// `wire::parse_wire`, then folded. Non-conv frames (the `requests.say`
    /// header line the v2 fixtures also carry) are skipped, same as a real
    /// attach stream only ever carries conv.v2 traffic.
    fn replay(fixture: &str) -> Conversation {
        let mut conv = Conversation::default();
        for line in fixture.lines().filter(|l| !l.is_empty()) {
            let record: serde_json::Value = serde_json::from_str(line).expect("fixture line is json");
            let subject = record["subject"].as_str().expect("subject");
            let payload = serde_json::to_vec(&record["message"]).expect("message");
            if let Some(WireEvent::Conv(event)) = wire::parse_wire(subject, &payload) {
                conv.fold(&event.kind);
            }
        }
        conv
    }

    const SCENARIO_1: &str = include_str!("../../../../docs/spec/fixtures/v2/scenario-1.jsonl");

    #[test]
    fn scenario_1_folds_to_four_messages_idle_and_no_stream() {
        let conv = replay(SCENARIO_1);
        assert_eq!(conv.messages.len(), 4);
        assert_eq!(conv.messages[0].id.0, "m1");
        assert_eq!(conv.messages[3].id.0, "m4");
        assert_eq!(conv.query_state, QueryState::Idle);
        assert!(conv.live_query.is_none());
        // The scenario's one delta was cleared by m4's commit superseding it.
        assert!(conv.streaming.is_empty());
    }

    #[test]
    fn a_delta_before_its_committing_message_accumulates_then_clears() {
        let mut conv = Conversation::default();
        conv.fold(&EventKind::Delta(wire::ConvDelta {
            text: "File X".into(),
        }));
        assert_eq!(conv.streaming.len(), 1);
        assert_eq!(conv.streaming[0].text, "File X");
        conv.fold(&EventKind::Delta(wire::ConvDelta {
            text: " contains".into(),
        }));
        assert_eq!(conv.streaming[0].text, "File X contains");
    }

    fn message(id: &str, ts: &str, role: &str, content: Vec<serde_json::Value>) -> WireMessage {
        WireMessage {
            ts: ts.into(),
            id: wire::MessageId(id.into()),
            query_id: wire::QueryId("q1".into()),
            turn_id: wire::TurnId("t1".into()),
            role: role.into(),
            from: None,
            content,
        }
    }

    #[test]
    fn a_committed_human_say_supersedes_the_pending_one_but_a_tool_result_does_not() {
        let mut conv = Conversation::default();
        conv.pending_say = Some("hello".into());
        // A tool_result commits as role user with agent provenance — the
        // pending say must survive it.
        let mut tool_result = message("m1", "2026-07-07T21:00:00+10:00", "user", vec![]);
        tool_result.from = Some(serde_json::json!({ "kind": "agent" }));
        conv.fold(&EventKind::Change(ConvChange::Message(tool_result)));
        assert_eq!(conv.pending_say.as_deref(), Some("hello"));
        // The human say's own commit clears it.
        let mut say = message("m2", "2026-07-07T21:00:01+10:00", "user", vec![]);
        say.from = Some(serde_json::json!({ "kind": "human" }));
        conv.fold(&EventKind::Change(ConvChange::Message(say)));
        assert_eq!(conv.pending_say, None);
    }

    #[test]
    fn a_query_closing_with_the_say_still_pending_sends_it_home() {
        let mut conv = Conversation::default();
        conv.pending_say = Some("hello".into());
        let closure = wire::Query {
            ts: "2026-07-07T21:00:02+10:00".into(),
            query_id: wire::QueryId("q1".into()),
            reason: "cancelled".into(),
        };
        conv.fold(&EventKind::Change(ConvChange::Query(closure)));
        assert_eq!(conv.pending_say, None);
        assert_eq!(conv.restore_say.as_deref(), Some("hello"));
    }

    #[test]
    fn mixed_offset_timestamps_order_by_instant_not_string() {
        // 21:00+10:00 (11:00Z) precedes 12:00Z as an instant, but follows it
        // as a string ("2026-07-07T21" > "2026-07-07T12") — the misorder the
        // ts rule exists to prevent.
        let mut conv = Conversation::default();
        conv.insert_message(message("m2", "2026-07-07T12:00:00Z", "assistant", vec![]));
        conv.insert_message(message("m1", "2026-07-07T21:00:00+10:00", "user", vec![]));
        assert_eq!(conv.messages[0].id.0, "m1");
        assert_eq!(conv.messages[1].id.0, "m2");
    }

    #[test]
    fn a_revision_replaces_content_in_place_keeping_the_id() {
        let mut conv = Conversation::default();
        conv.insert_message(message("m1", "2026-07-07T21:00:00+10:00", "user", vec![]));
        let revision = wire::Revision {
            ts: "2026-07-07T21:05:00+10:00".into(),
            message_id: wire::MessageId("m1".into()),
            content: vec![serde_json::json!({"type":"text","text":"corrected"})],
        };
        conv.fold(&EventKind::Change(ConvChange::Revision(revision)));
        assert_eq!(
            conv.messages[0].content,
            vec![serde_json::json!({"type":"text","text":"corrected"})]
        );
    }
}
