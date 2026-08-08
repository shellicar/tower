//! The facts, and the whole of what the lookout reads off an event.
//!
//! Which query is open is a subject leaf plus a `queryId`; how long a
//! conversation has been silent is a timestamp; whether a tool is still out is
//! a subject, a `queryId` and two timestamps. None of it requires interpreting
//! what anybody said, so the readable thing that looks like state is never
//! consulted for state. `Observation` is that rule expressed as a data
//! dependency rather than as a warning: there is nowhere in it for content to
//! go, so no classification downstream can depend on content even by mistake.
//!
//! Two subtrees feed it. `changes` carries the commits and the query closes.
//! `telemetry` carries the turn boundaries and, the one that matters, the
//! announcement of a tool before it runs.

use serde::Deserialize;

/// What one event says. A commit opens a query and is activity; a turn event
/// is activity that opens nothing; a tool starting is activity and also the
/// beginning of a wait; a close ends a query and is deliberately not activity
/// — a conversation whose only recent event is its own turn ending has still
/// stopped speaking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observation {
    Committed { query: String, at_ms: i64 },
    Alive { at_ms: i64 },
    ToolStarted { query: String, at_ms: i64 },
    Closed { query: String },
}

/// The only fields read out of any event body.
#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    ts: Option<String>,
    #[serde(rename = "queryId")]
    query_id: Option<String>,
}

/// Read one event. `Ok(None)` is an event that carries nothing for any fact (a
/// revision, a tip move, usage); `Err` is one that should have and did not,
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
    let envelope = read(subject, payload)?;
    let Some(query) = envelope.query_id else {
        return Err(format!("{subject} carries no queryId"));
    };
    if leaf == "query" {
        return Ok(Some(Observation::Closed { query }));
    }
    Ok(Some(Observation::Committed {
        query,
        at_ms: at(subject, &envelope.ts)?,
    }))
}

/// The telemetry the lookout reads: a turn boundary, and a tool starting.
/// Neither opens or closes a query, because the query pairing has its own
/// events and telemetry runs ahead of what is committed.
///
/// The tool is the one that matters. The agent host announces a tool before it
/// runs and commits its result afterwards, and publishes nothing whatever in
/// between, so a tool that has started with nothing committed since is the
/// only positive evidence that the silence has a cause.
fn observe_telemetry(
    subject: &str,
    leaf: &str,
    payload: &[u8],
) -> Result<Option<Observation>, String> {
    if leaf == "tool.use" {
        let envelope = read(subject, payload)?;
        let Some(query) = envelope.query_id else {
            return Err(format!("{subject} carries no queryId"));
        };
        return Ok(Some(Observation::ToolStarted {
            query,
            at_ms: at(subject, &envelope.ts)?,
        }));
    }
    if !leaf.starts_with("turn.") {
        return Ok(None);
    }
    let envelope = read(subject, payload)?;
    Ok(Some(Observation::Alive {
        at_ms: at(subject, &envelope.ts)?,
    }))
}

fn read(subject: &str, payload: &[u8]) -> Result<Envelope, String> {
    serde_json::from_slice(payload)
        .map_err(|e| format!("{subject} carries no readable envelope: {e}"))
}

fn at(subject: &str, ts: &Option<String>) -> Result<i64, String> {
    ts.as_deref()
        .and_then(wire::parse_ts)
        .ok_or_else(|| format!("{subject} carries no readable ts"))
}

/// The query a conversation is currently in, and when it was last seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenQuery {
    pub id: String,
    pub at_ms: i64,
}

/// A tool announced as about to run, and the query that announced it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutstandingTool {
    pub query: String,
    pub at_ms: i64,
}

/// One worker's facts, folded from its own change and telemetry subtrees.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Facts {
    /// The query in progress. At most one: the tip precondition admits a
    /// single query at a time, so queries on a conversation are sequential.
    pub open: Option<OpenQuery>,
    /// The last query observed to close. It is what a finished or idle
    /// reading is *about*, and a handler needs it to tell one stop from the
    /// next.
    pub last_closed_query: Option<String>,
    /// The last moment this conversation was observably being worked on: a
    /// commit, a turn boundary, or a tool starting.
    pub last_activity_ms: Option<i64>,
    /// The last commit alone. A tool's result arrives as a commit, so this is
    /// what a tool's announcement is measured against.
    pub last_commit_ms: Option<i64>,
    pub outstanding_tool: Option<OutstandingTool>,
}

impl Facts {
    pub fn apply(&mut self, observation: &Observation) {
        match observation {
            Observation::Committed { query, at_ms } => {
                self.open_query(query, *at_ms);
                self.last_commit_ms = Some(newer(self.last_commit_ms, *at_ms));
                self.mark_alive(*at_ms);
            }
            Observation::Alive { at_ms } => self.mark_alive(*at_ms),
            Observation::ToolStarted { query, at_ms } => {
                self.outstanding_tool = Some(OutstandingTool {
                    query: query.clone(),
                    at_ms: match &self.outstanding_tool {
                        Some(held) => held.at_ms.max(*at_ms),
                        None => *at_ms,
                    },
                });
                self.mark_alive(*at_ms);
            }
            Observation::Closed { query } => {
                if self.open.as_ref().is_some_and(|open| &open.id == query) {
                    self.open = None;
                }
                self.last_closed_query = Some(query.clone());
                // Whatever that query announced is finished with, however it
                // ended. An announcement must not outlive the query that made
                // it and go on explaining a later silence.
                if self
                    .outstanding_tool
                    .as_ref()
                    .is_some_and(|tool| &tool.query == query)
                {
                    self.outstanding_tool = None;
                }
            }
        }
    }

    /// A later query is proof the earlier one will never close.
    ///
    /// A process that dies mid-query publishes no closure, ever, so without
    /// this an unclosed query would hold a worker un-finishable for the life
    /// of the daemon — the worker would be re-serviced, work normally, and
    /// never read as finished again. Queries are sequential, so the existence
    /// of a later one settles the earlier one.
    fn open_query(&mut self, query: &str, at_ms: i64) {
        match &mut self.open {
            Some(open) if open.id == query => open.at_ms = open.at_ms.max(at_ms),
            // An older query's frame arriving late does not unseat the newer
            // one that superseded it.
            Some(open) if open.at_ms > at_ms => {}
            _ => {
                self.open = Some(OpenQuery {
                    id: query.to_string(),
                    at_ms,
                })
            }
        }
    }

    /// When the outstanding tool was announced, if one is still out.
    ///
    /// The agent host commits a tool's result, so a commit strictly later than
    /// the announcement is the tool coming back. A tool announced in the same
    /// millisecond as the commit before it is still out: the call commits and
    /// the announcement follows it immediately, so the two share a timestamp
    /// routinely.
    ///
    /// This is the whole of the evidence there is. It says work was started,
    /// never that the process is still there to finish it.
    pub fn tool_outstanding_since(&self) -> Option<i64> {
        let tool = self.outstanding_tool.as_ref()?;
        match self.last_commit_ms {
            Some(commit) if commit > tool.at_ms => None,
            _ => Some(tool.at_ms),
        }
    }

    fn mark_alive(&mut self, at_ms: i64) {
        self.last_activity_ms = Some(newer(self.last_activity_ms, at_ms));
    }
}

fn newer(held: Option<i64>, at_ms: i64) -> i64 {
    held.map_or(at_ms, |m| m.max(at_ms))
}

#[cfg(test)]
mod observe {
    use super::*;

    const MESSAGE: &str = "conv.v2.worker-1.changes.message";
    const QUERY: &str = "conv.v2.worker-1.changes.query";
    const TOOL: &str = "conv.v2.worker-1.telemetry.tool.use";

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

    /// A tool announced before it runs is when the wait began, and it carries
    /// the query that announced it so the wait can be scoped to that query.
    /// What tool it was and what it was given are not read: the name and the
    /// input sit in the same body and neither reaches the fold.
    #[test]
    fn a_tool_use_is_a_tool_starting_under_its_own_query() {
        let expected = Ok(Some(Observation::ToolStarted {
            query: "q-1".into(),
            at_ms: 1_754_000_000_000,
        }));

        let actual = observe(
            TOOL,
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","name":"Exec",
                "input":{"command":"rm -rf /"}}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn what_a_tool_was_given_makes_no_difference_to_what_is_observed() {
        let expected = observe(
            TOOL,
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","name":"Exec",
                "input":{"command":"cargo build"}}"#,
        );

        let actual = observe(
            TOOL,
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","name":"Read",
                "input":{"paths":["/etc/shadow"]}}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_tool_with_no_query_is_named_rather_than_dropped() {
        let actual = observe(TOOL, br#"{"ts":"2025-07-31T22:13:20.000Z","name":"Exec"}"#);

        assert!(actual.is_err());
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
    fn telemetry_the_lookout_has_no_use_for_carries_nothing() {
        let expected = Ok(None);

        let actual = observe(
            "conv.v2.worker-1.telemetry.usage",
            br#"{"ts":"2025-07-31T22:13:20.000Z","queryId":"q-1","outputTokens":42}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_revision_carries_nothing() {
        let expected = Ok(None);

        let actual = observe(
            "conv.v2.worker-1.changes.revision",
            br#"{"ts":"2025-07-31T22:13:20.000Z","messageId":"m-1","content":[]}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn a_tip_move_carries_nothing() {
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
    /// even the shape a message parser would accept still yields the facts.
    /// This is what fails if anyone ever makes the lookout deserialise a whole
    /// message.
    #[test]
    fn a_message_whose_content_is_unparseable_still_yields_its_facts() {
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

    fn tool(query: &str, at_ms: i64) -> Observation {
        Observation::ToolStarted {
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

    fn open_id(facts: &Facts) -> Option<String> {
        facts.open.as_ref().map(|open| open.id.clone())
    }

    mod queries {
        use super::*;

        #[test]
        fn a_message_with_no_matching_close_leaves_its_query_open() {
            let expected = Some("q-1".to_string());

            let actual = open_id(&fold(&[committed("q-1", 100)]));

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_close_ends_the_query_its_id_names() {
            let expected = None;

            let actual = open_id(&fold(&[committed("q-1", 100), closed("q-1")]));

            assert_eq!(actual, expected);
        }

        /// The recovery case. A process that dies mid-query publishes no
        /// closure ever, so without this the worker could never read as
        /// finished again once it was re-serviced and working normally.
        /// Queries are sequential, so a later one settles the earlier one.
        #[test]
        fn a_later_query_supersedes_one_that_never_closed() {
            let expected = Some("q-2".to_string());

            let actual = open_id(&fold(&[committed("q-1", 100), committed("q-2", 200)]));

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_superseded_query_closing_late_does_not_end_the_current_one() {
            let expected = Some("q-2".to_string());

            let actual = open_id(&fold(&[
                committed("q-1", 100),
                committed("q-2", 200),
                closed("q-1"),
            ]));

            assert_eq!(actual, expected);
        }

        #[test]
        fn an_older_query_s_frame_arriving_late_does_not_unseat_the_newer_one() {
            let expected = Some("q-2".to_string());

            let actual = open_id(&fold(&[
                committed("q-1", 100),
                committed("q-2", 200),
                committed("q-1", 150),
            ]));

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_close_is_remembered_as_what_a_finished_reading_is_about() {
            let expected = Some("q-1".to_string());

            let actual = fold(&[committed("q-1", 100), closed("q-1")]).last_closed_query;

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_close_for_a_query_never_seen_opens_nothing() {
            let expected = None;

            let actual = open_id(&fold(&[closed("q-unknown")]));

            assert_eq!(actual, expected);
        }
    }

    mod activity {
        use super::*;

        #[test]
        fn the_last_activity_is_the_newest_message_seen() {
            let expected = Some(300);

            let actual = fold(&[committed("q-1", 100), committed("q-1", 300)]).last_activity_ms;

            assert_eq!(actual, expected);
        }

        /// Stream order is commit order, but a replayed frame's own timestamp
        /// is what silence is measured from, so an out-of-order pair must not
        /// move the clock backwards.
        #[test]
        fn an_older_message_arriving_late_does_not_move_the_last_activity_back() {
            let expected = Some(300);

            let actual = fold(&[committed("q-1", 300), committed("q-1", 100)]).last_activity_ms;

            assert_eq!(actual, expected);
        }

        /// A close is the conversation's own turn ending, not the
        /// conversation speaking: counting it as activity is what would hide a
        /// worker that finished and then went quiet.
        #[test]
        fn a_close_is_not_activity() {
            let expected = Some(100);

            let actual = fold(&[committed("q-1", 100), closed("q-1")]).last_activity_ms;

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_turn_boundary_is_activity() {
            let expected = Some(300);

            let actual =
                fold(&[committed("q-1", 100), Observation::Alive { at_ms: 300 }]).last_activity_ms;

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_turn_boundary_opens_no_query() {
            let expected = None;

            let actual = open_id(&fold(&[Observation::Alive { at_ms: 300 }]));

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_tool_starting_is_activity() {
            let expected = Some(110);

            let actual = fold(&[committed("q-1", 100), tool("q-1", 110)]).last_activity_ms;

            assert_eq!(actual, expected);
        }

        /// A tool is not a commit, so it must not end its own wait.
        #[test]
        fn a_tool_starting_is_not_a_commit() {
            let expected = Some(100);

            let actual = fold(&[committed("q-1", 100), tool("q-1", 110)]).last_commit_ms;

            assert_eq!(actual, expected);
        }
    }

    mod outstanding_tool {
        use super::*;

        /// The tool round, as the agent host publishes it: the call commits,
        /// the tool is announced, and nothing at all follows until the result
        /// commits. In that gap the tool is outstanding.
        #[test]
        fn a_tool_announced_after_the_last_commit_is_outstanding() {
            let expected = Some(110);

            let actual = fold(&[committed("q-1", 100), tool("q-1", 110)]).tool_outstanding_since();

            assert_eq!(actual, expected);
        }

        /// The call commits and the announcement follows immediately, so the
        /// two share a millisecond routinely. Reading that as the tool having
        /// already come back is what made the absorb miss the case it exists
        /// for.
        #[test]
        fn a_tool_announced_in_the_same_millisecond_as_the_commit_is_outstanding() {
            let expected = Some(100);

            let actual = fold(&[committed("q-1", 100), tool("q-1", 100)]).tool_outstanding_since();

            assert_eq!(actual, expected);
        }

        /// The result of a tool arrives as a commit, which is how the wait
        /// ends.
        #[test]
        fn a_commit_after_the_tool_ends_the_wait() {
            let expected = None;

            let actual = fold(&[
                committed("q-1", 100),
                tool("q-1", 110),
                committed("q-1", 900),
            ])
            .tool_outstanding_since();

            assert_eq!(actual, expected);
        }

        /// Scoped to the query that announced it. The subtrees are replayed
        /// one after the other rather than interleaved, so every commit is
        /// folded before any announcement and no ordering rule could carry
        /// this — the query id has to.
        #[test]
        fn a_close_of_the_announcing_query_ends_the_wait() {
            let expected = None;

            let actual = fold(&[committed("q-1", 100), tool("q-1", 110), closed("q-1")])
                .tool_outstanding_since();

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_close_of_some_other_query_leaves_the_wait_alone() {
            let expected = Some(110);

            let actual = fold(&[committed("q-1", 100), tool("q-1", 110), closed("q-2")])
                .tool_outstanding_since();

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_conversation_that_has_announced_no_tool_has_none_outstanding() {
            let expected = None;

            let actual = fold(&[committed("q-1", 100)]).tool_outstanding_since();

            assert_eq!(actual, expected);
        }

        /// Several tools in one round are announced together and answered by
        /// a single commit, so the wait runs from the last of them.
        #[test]
        fn the_wait_runs_from_the_last_tool_announced() {
            let expected = Some(120);

            let actual = fold(&[committed("q-1", 100), tool("q-1", 110), tool("q-1", 120)])
                .tool_outstanding_since();

            assert_eq!(actual, expected);
        }
    }
}
