//! Outcome resolution: the agent's decisions as pure functions over its
//! state. No I/O, no channels, no clocks (the ws.rs `Session` pattern).
//! The select loop in agent.rs is the shell that carries the decisions out;
//! every poisonous ordering (the scenario 2b cancel-after-completion race)
//! is a deterministic test here instead of a timing accident there.

use serde_json::{Value, json};

/// A committed message: id + the API-shaped halves the model call needs.
#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: Vec<Value>,
}

/// What a finished query reports back for the tree. Every variant carries
/// every message the query committed, assistant turns and tool results
/// alike: they are on the wire, so the tree must hold them whatever else
/// happened.
#[derive(Debug)]
pub enum QueryEnd {
    Completed { messages: Vec<Message> },
    Cancelled { messages: Vec<Message> },
    Aborted { messages: Vec<Message> },
}

#[derive(Debug, PartialEq)]
pub enum SayDecision {
    /// The premise held: commit the user message and start the query.
    Accept,
    /// Tip mismatch, or a query is live against this premise (scenario 5).
    Stale,
}

#[derive(Debug, PartialEq)]
pub enum CancelDecision {
    /// The query is live: signal it to wind down, reply accepted. The
    /// outcome is the task's to publish; acceptance is all a reply means.
    Signal,
    /// The query already closed (scenario 2b's answer, the spec's word).
    AlreadyComplete,
    NotFound,
}

/// One conversation as this servicer knows it: the committed tree, the
/// query live against it, and the last closed one (so a late cancel reads
/// as `already_complete`, never `not_found`).
#[derive(Default)]
pub struct Conversation {
    tree: Vec<Message>,
    live: Option<String>,
    last_ended: Option<String>,
}

impl Conversation {
    /// The premise check: the sender's tip must be the tree's, and no query
    /// may be live against it. A live acceptance makes the same premise
    /// stale (scenario 5).
    pub fn on_say(&self, tip: Option<&str>) -> SayDecision {
        let current = self.tree.last().map(|m| m.id.as_str());
        if tip != current || self.live.is_some() {
            SayDecision::Stale
        } else {
            SayDecision::Accept
        }
    }

    /// The query goes live. Nothing enters the tree here: the say's user
    /// half is PENDING until the query first commits (the spec's
    /// recommended declaration) - a cancel revokes the say, not just the
    /// turn, so a query cancelled before its first commit leaves the tree
    /// and the tip exactly as they were.
    pub fn start_query(&mut self, query: String) {
        self.live = Some(query);
    }

    pub fn on_cancel(&mut self, query: &str) -> CancelDecision {
        if self.live.as_deref() == Some(query) {
            return CancelDecision::Signal;
        }
        if self.last_ended.as_deref() == Some(query) {
            return CancelDecision::AlreadyComplete;
        }
        CancelDecision::NotFound
    }

    /// Fold one finished query. The tree-extend is unconditional on purpose:
    /// every carried message is already on the wire and every consumer has
    /// it, so the tree must carry it too, whatever ended the query;
    /// dropping one would desync the tip from the world forever.
    pub fn on_query_end(&mut self, query: String, end: QueryEnd) {
        if self.live.as_deref() == Some(query.as_str()) {
            self.live = None;
        }
        self.last_ended = Some(query);
        let (QueryEnd::Completed { messages }
        | QueryEnd::Cancelled { messages }
        | QueryEnd::Aborted { messages }) = end;
        self.tree.extend(messages);
    }

    /// The API-shaped history for the next model call.
    pub fn history(&self) -> Vec<Value> {
        self.tree
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.tree.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, role: &str) -> Message {
        Message {
            id: id.into(),
            role: role.into(),
            content: vec![json!({ "type": "text", "text": id })],
        }
    }

    #[test]
    fn premise_check_scenarios_one_and_five() {
        let mut conversation = Conversation::default();
        // Empty conversation: only the null tip holds.
        assert_eq!(conversation.on_say(None), SayDecision::Accept);
        assert_eq!(conversation.on_say(Some("m9")), SayDecision::Stale);

        conversation.start_query("q1".into());
        // A live acceptance makes any premise stale (scenario 5) - even the
        // still-current null tip, whose premise now has a live acceptance.
        assert_eq!(conversation.on_say(None), SayDecision::Stale);

        conversation.on_query_end(
            "q1".into(),
            QueryEnd::Completed {
                messages: vec![msg("m1", "user"), msg("m2", "assistant")],
            },
        );
        // The tip moved to the committed reply.
        assert_eq!(conversation.on_say(Some("m2")), SayDecision::Accept);
        assert_eq!(conversation.on_say(Some("m1")), SayDecision::Stale);
    }

    /// A query cancelled before its first commit leaves nothing: no user
    /// message, no tip movement - the say was revoked, not just the turn.
    /// The released premise is the tip the sender already knew, so the same
    /// say re-sent is accepted.
    #[test]
    fn cancelled_query_commits_nothing_and_the_premise_survives() {
        let mut conversation = Conversation::default();
        conversation.start_query("q1".into());
        conversation.on_query_end("q1".into(), QueryEnd::Cancelled { messages: vec![] });

        assert!(conversation.is_empty());
        assert_eq!(conversation.on_say(None), SayDecision::Accept);
    }

    /// Scenario 2b, the race that shipped unproven: the query completes,
    /// then the cancel arrives. The decision must be `already_complete`
    /// (never a signal, never not_found), and the tree must hold every
    /// committed message.
    #[test]
    fn cancel_after_completion_is_already_complete() {
        let mut conversation = Conversation::default();
        conversation.start_query("q2".into());
        conversation.on_query_end(
            "q2".into(),
            QueryEnd::Completed {
                messages: vec![msg("m5", "user"), msg("m6", "assistant")],
            },
        );

        assert_eq!(
            conversation.on_cancel("q2"),
            CancelDecision::AlreadyComplete
        );
        // The tree kept the wire's truth through the ordering.
        assert_eq!(conversation.history().len(), 2);
    }

    #[test]
    fn cancel_of_a_live_query_signals_and_of_an_unknown_is_not_found() {
        let mut conversation = Conversation::default();
        conversation.start_query("q1".into());
        assert_eq!(conversation.on_cancel("q1"), CancelDecision::Signal);
        // Cancel is idempotent while live: a second click signals again.
        assert_eq!(conversation.on_cancel("q1"), CancelDecision::Signal);
        assert_eq!(conversation.on_cancel("q9"), CancelDecision::NotFound);
    }

    /// A cancelled or aborted query's committed messages still enter the
    /// tree: they are on the wire, and dropping them desyncs the tip forever.
    #[test]
    fn cancelled_and_aborted_messages_still_fold() {
        let mut conversation = Conversation::default();
        conversation.start_query("q1".into());
        // Cancelled mid-tool-round: the first turn's commits (user, tool
        // call, tool result) are on the wire and stand.
        conversation.on_query_end(
            "q1".into(),
            QueryEnd::Cancelled {
                messages: vec![msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user")],
            },
        );
        assert_eq!(conversation.history().len(), 3);
        // The tip is the last committed message, cancelled or not.
        assert_eq!(conversation.on_say(Some("m3")), SayDecision::Accept);

        conversation.start_query("q2".into());
        conversation.on_query_end(
            "q2".into(),
            QueryEnd::Aborted {
                messages: vec![msg("m4", "user"), msg("m5", "assistant")],
            },
        );
        assert_eq!(conversation.history().len(), 5);
        assert_eq!(
            conversation.on_cancel("q2"),
            CancelDecision::AlreadyComplete
        );
    }
}
