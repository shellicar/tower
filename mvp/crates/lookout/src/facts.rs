//! The two facts, and the whole of what the lookout reads off an event.
//!
//! Whether a query is open is a subject leaf plus a `queryId`; how long a
//! conversation has been silent is a timestamp. Neither requires interpreting
//! what anybody said, so the readable thing that looks like state is never
//! consulted for state. `Observation` is that rule expressed as a data
//! dependency rather than as a warning: there is nowhere in it for content to
//! go, so no classification downstream can depend on content even by mistake.
//!
//! Two subtrees feed it. `changes` carries the commits and the query closes.
//! `telemetry` carries the turn boundaries, which prove the conversation was
//! being worked on at a moment no commit landed — a turn that starts, is
//! cancelled, or aborts without committing anything is still life.

use serde::Deserialize;
use std::collections::BTreeSet;

/// What one event says. A commit opens a query and is activity; a turn event
/// is activity that opens nothing; a close pairs off an open query and is
/// deliberately not activity — a conversation whose only recent event is its
/// own turn ending has still stopped speaking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
    Committed { query: String, at_ms: i64 },
    Alive { at_ms: i64 },
    Closed { query: String },
}

/// The only two fields read out of any event body. `ts` is absent on a close
/// because a close is not activity, so its time is never needed.
#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    ts: Option<String>,
    #[serde(rename = "queryId")]
    query_id: Option<String>,
}

/// Read one event. `Ok(None)` is an event that carries nothing for either
/// fact (a revision, a tip move); `Err` is one that should have and did not,
/// which is named rather than dropped.
pub fn observe(subject: &str, payload: &[u8]) -> Result<Option<Observation>, String> {
    if let Some((_, leaf)) = subject.rsplit_once(".telemetry.") {
        return observe_telemetry(subject, leaf, payload);
    }
    let leaf = match subject.rsplit_once(".changes.") {
        Some((_, leaf)) => leaf,
        None => return Ok(None),
    };
    if leaf != "message" && leaf != "query" {
        return Ok(None);
    }
    let envelope: Envelope = serde_json::from_slice(payload)
        .map_err(|e| format!("{subject} carries no readable envelope: {e}"))?;
    let Some(query) = envelope.query_id else {
        return Err(format!("{subject} carries no queryId"));
    };
    if leaf == "query" {
        return Ok(Some(Observation::Closed { query }));
    }
    let at_ms = envelope
        .ts
        .as_deref()
        .and_then(wire::parse_ts)
        .ok_or_else(|| format!("{subject} carries no readable ts"))?;
    Ok(Some(Observation::Committed { query, at_ms }))
}

/// A turn boundary is life and nothing else: it says the conversation was
/// being worked on then. It never opens or closes a query, because the query
/// pairing has its own events and telemetry runs ahead of what is committed.
fn observe_telemetry(
    subject: &str,
    leaf: &str,
    payload: &[u8],
) -> Result<Option<Observation>, String> {
    if !leaf.starts_with("turn.") {
        return Ok(None);
    }
    let envelope: Envelope = serde_json::from_slice(payload)
        .map_err(|e| format!("{subject} carries no readable envelope: {e}"))?;
    let at_ms = envelope
        .ts
        .as_deref()
        .and_then(wire::parse_ts)
        .ok_or_else(|| format!("{subject} carries no readable ts"))?;
    Ok(Some(Observation::Alive { at_ms }))
}

/// One worker's two facts, folded from its own change and telemetry subtrees.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// Queries seen on a committed message with no close paired against them.
    /// The pairing is by id and is exact, which is what keeps the whole fold
    /// free of content.
    pub open: BTreeSet<String>,
    /// The last moment this conversation was observably being worked on: a
    /// commit, or a turn boundary.
    pub last_activity_ms: Option<i64>,
}

impl Facts {
    pub fn apply(&mut self, observation: &Observation) {
        match observation {
            Observation::Committed { query, at_ms } => {
                self.open.insert(query.clone());
                self.mark_alive(*at_ms);
            }
            Observation::Alive { at_ms } => self.mark_alive(*at_ms),
            Observation::Closed { query } => {
                self.open.remove(query);
            }
        }
    }

    fn mark_alive(&mut self, at_ms: i64) {
        self.last_activity_ms = Some(self.last_activity_ms.map_or(at_ms, |m| m.max(at_ms)));
    }
}

#[cfg(test)]
mod observe {
    use super::*;

    const MESSAGE: &str = "conv.v2.worker-1.changes.message";
    const QUERY: &str = "conv.v2.worker-1.changes.query";

    fn message(body: &str) -> Result<Option<Observation>, String> {
        observe(MESSAGE, body.as_bytes())
    }

    #[test]
    fn a_committed_message_opens_its_query() {
        let expected = Ok(Some(Observation::Committed {
            query: "q-1".into(),
            at_ms: 1_754_000_000_000,
        }));

        let actual = message(r#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1"}"#);

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_query_event_closes_its_query() {
        let expected = Ok(Some(Observation::Closed {
            query: "q-1".into(),
        }));

        let actual = observe(
            QUERY,
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","reason":"completed"}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_turn_starting_is_life_and_opens_nothing() {
        let expected = Ok(Some(Observation::Alive {
            at_ms: 1_754_000_000_000,
        }));

        let actual = observe(
            "conv.v2.worker-1.telemetry.turn.started",
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","turnId":"t-1","model":"m"}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_turn_ending_is_life() {
        let expected = Ok(Some(Observation::Alive {
            at_ms: 1_754_000_000_000,
        }));

        let actual = observe(
            "conv.v2.worker-1.telemetry.turn.ended",
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","stopReason":"end_turn"}"#,
        );

        assert_eq!(actual, expected);
    }

    /// A tool call announced before it runs says the conversation was alive,
    /// but it is not a turn boundary and the lookout does not read what tool
    /// it was or what it was given.
    #[test]
    fn a_tool_use_carries_neither_fact() {
        let expected = Ok(None);

        let actual = observe(
            "conv.v2.worker-1.telemetry.tool.use",
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","name":"Exec","input":{}}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_revision_carries_neither_fact() {
        let expected = Ok(None);

        let actual = observe(
            "conv.v2.worker-1.changes.revision",
            br#"{"ts":"2025-07-31T22:13:20.000Z","messageId":"m-1","content":[]}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_tip_move_carries_neither_fact() {
        let expected = Ok(None);

        let actual = observe(
            "conv.v2.worker-1.changes.tip.moved",
            br#"{"ts":"2025-07-31T22:13:20.000Z","to":"m-1"}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn names_a_message_it_cannot_read_rather_than_dropping_it() {
        let actual = message("not json");

        assert!(actual.is_err());
    }

    /// The invariant, pinned: what a worker actually said cannot reach the
    /// facts. Two messages that differ in every content block and in nothing
    /// else are the same observation.
    #[test]
    fn what_a_message_says_makes_no_difference_to_what_is_observed() {
        let expected = message(
            r#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","role":"assistant",
                "content":[{"type":"text","text":"blocked: I need a decision"}]}"#,
        );

        let actual = message(
            r#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","role":"user",
                "content":[{"type":"tool_result","content":"done, PR opened"}]}"#,
        );

        assert_eq!(actual, expected);
    }

    /// The same invariant from the other side: a body whose content is not
    /// even the shape a message parser would accept still yields the two
    /// facts. This is what fails if anyone ever makes the lookout
    /// deserialise a whole message.
    #[test]
    fn a_message_whose_content_is_unparseable_still_yields_both_facts() {
        let expected = Ok(Some(Observation::Committed {
            query: "q-1".into(),
            at_ms: 1_754_000_000_000,
        }));

        let actual = message(
            r#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1",
                "content":"not an array","from":42,"role":null}"#,
        );

        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod apply {
    use super::*;

    fn committed(query: &str, at_ms: i64) -> Observation {
        Observation::Committed {
            query: query.into(),
            at_ms,
        }
    }

    fn closed(query: &str) -> Observation {
        Observation::Closed {
            query: query.into(),
        }
    }

    fn fold(observations: &[Observation]) -> Facts {
        let mut facts = Facts::default();
        for observation in observations {
            facts.apply(observation);
        }
        facts
    }

    #[test]
    fn a_message_with_no_matching_close_leaves_its_query_open() {
        let expected = true;

        let actual = !fold(&[committed("q-1", 100)]).open.is_empty();

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_close_pairs_off_the_query_its_id_names() {
        let expected = true;

        let actual = fold(&[committed("q-1", 100), closed("q-1")])
            .open
            .is_empty();

        assert_eq!(actual, expected);
    }

    /// The pairing is by id, so a turn that closed does not close the turn
    /// that started after it.
    #[test]
    fn a_close_leaves_a_different_query_open() {
        let expected = BTreeSet::from(["q-2".to_string()]);

        let actual = fold(&[committed("q-1", 100), closed("q-1"), committed("q-2", 200)]).open;

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_close_for_a_query_never_seen_leaves_the_facts_alone() {
        let expected = Facts::default();

        let actual = fold(&[closed("q-unknown")]);

        assert_eq!(actual, expected);
    }

    #[test]
    fn the_last_activity_is_the_newest_message_seen() {
        let expected = Some(300);

        let actual = fold(&[committed("q-1", 100), committed("q-1", 300)]).last_activity_ms;

        assert_eq!(actual, expected);
    }

    /// The case telemetry exists for: a turn that started after the last
    /// commit is life, so a conversation mid-turn is not read as silent since
    /// whenever it last managed to commit something.
    #[test]
    fn a_turn_boundary_after_the_last_commit_is_the_last_activity() {
        let expected = Some(300);

        let actual =
            fold(&[committed("q-1", 100), Observation::Alive { at_ms: 300 }]).last_activity_ms;

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_turn_boundary_opens_no_query() {
        let expected = true;

        let actual = fold(&[Observation::Alive { at_ms: 300 }]).open.is_empty();

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_turn_boundary_closes_no_query() {
        let expected = BTreeSet::from(["q-1".to_string()]);

        let actual = fold(&[committed("q-1", 100), Observation::Alive { at_ms: 300 }]).open;

        assert_eq!(actual, expected);
    }

    /// Stream order is commit order, but a replayed frame's own timestamp is
    /// what silence is measured from, so an out-of-order pair must not move
    /// the clock backwards.
    #[test]
    fn an_older_message_arriving_late_does_not_move_the_last_activity_back() {
        let expected = Some(300);

        let actual = fold(&[committed("q-1", 300), committed("q-1", 100)]).last_activity_ms;

        assert_eq!(actual, expected);
    }

    /// A close is the conversation's own turn ending, not the conversation
    /// speaking: counting it as activity is what would hide a worker that
    /// finished and then went quiet.
    #[test]
    fn a_close_is_not_activity() {
        let expected = Some(100);

        let actual = fold(&[committed("q-1", 100), closed("q-1")]).last_activity_ms;

        assert_eq!(actual, expected);
    }
}
