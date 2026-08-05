//! The two facts, and the whole of what the lookout reads off an event.
//!
//! Whether a query is open is a subject leaf plus a `queryId`; how long a
//! conversation has been silent is a timestamp. Neither requires reading what
//! anybody said, so the readable thing that looks like state is never
//! consulted for state. `Observation` is that rule expressed as a data
//! dependency rather than as a warning: there is nowhere in it for content to
//! go, so no classification downstream can depend on content even by mistake.

use serde::Deserialize;
use std::collections::BTreeSet;

/// What one change event says. A commit opens a query and is the activity
/// silence is measured against; a close pairs off an open query and is
/// deliberately not activity — a conversation whose only recent event is its
/// own turn ending has still stopped speaking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
    Committed { query: String, at_ms: i64 },
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

/// One worker's two facts, folded from its own change subtree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// Queries seen on a committed message with no close paired against them.
    /// The pairing is by id and is exact, which is what keeps the whole fold
    /// free of content.
    pub open: BTreeSet<String>,
    pub last_commit_ms: Option<i64>,
}

impl Facts {
    pub fn apply(&mut self, observation: &Observation) {
        match observation {
            Observation::Committed { query, at_ms } => {
                self.open.insert(query.clone());
                self.last_commit_ms = Some(self.last_commit_ms.map_or(*at_ms, |m| m.max(*at_ms)));
            }
            Observation::Closed { query } => {
                self.open.remove(query);
            }
        }
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
    fn the_last_commit_is_the_newest_message_seen() {
        let expected = Some(300);

        let actual = fold(&[committed("q-1", 100), committed("q-1", 300)]).last_commit_ms;

        assert_eq!(actual, expected);
    }

    /// Stream order is commit order, but a replayed frame's own timestamp is
    /// what silence is measured from, so an out-of-order pair must not move
    /// the clock backwards.
    #[test]
    fn an_older_message_arriving_late_does_not_move_the_last_commit_back() {
        let expected = Some(300);

        let actual = fold(&[committed("q-1", 300), committed("q-1", 100)]).last_commit_ms;

        assert_eq!(actual, expected);
    }

    /// A close is the conversation's own turn ending, not the conversation
    /// speaking: counting it as activity is what would hide a worker that
    /// finished and then went quiet.
    #[test]
    fn a_close_is_not_activity() {
        let expected = Some(100);

        let actual = fold(&[committed("q-1", 100), closed("q-1")]).last_commit_ms;

        assert_eq!(actual, expected);
    }
}
