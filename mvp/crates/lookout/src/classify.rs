//! Four states from two facts, and nothing else.
//!
//! Waking on every query close is not enough, and a live fleet showed why: on
//! 5 August a worker had opened an `Exec` running a long sleep, the process
//! went away mid-call, and the `tool_result` never arrived — so the query
//! never closed and no event was ever published again. It had been silently
//! finished-and-not-reporting for 23 hours, and the human found it, not the
//! machinery. Absence of events is the signal, and absence has no event,
//! which is why something must tick.

use crate::facts::Facts;
use crate::lines::ReportingLine;

/// The reading of the two facts. `Working` is the only one that is left
/// alone; the other three are worth a handler's attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// A query is open and the conversation is still speaking.
    Working,
    /// A query is open and the conversation has stopped speaking. The process
    /// died mid-turn, and it is holding unpushed work.
    DeadMidTurn,
    /// No query is open and the conversation spoke recently: a turn finished
    /// and there is something to read.
    Finished,
    /// No query is open and the conversation has been quiet: it is waiting on
    /// someone.
    Idle,
}

impl State {
    /// Whether this state is news. Working is the steady state and telling a
    /// handler about it every tick is how a supervisor drowns the thing it
    /// supervises.
    pub fn is_worth_telling(self) -> bool {
        self != State::Working
    }
}

pub fn classify(facts: &Facts, silent_since_ms: i64, now_ms: i64, quiet_after_ms: i64) -> State {
    let recent = now_ms.saturating_sub(silent_since_ms) < quiet_after_ms;
    match (facts.open.is_empty(), recent) {
        (false, true) => State::Working,
        (false, false) => State::DeadMidTurn,
        (true, true) => State::Finished,
        (true, false) => State::Idle,
    }
}

/// The moment silence is measured from. A worker that has committed nothing
/// has still been silent since somebody commissioned it, so the line's own
/// timestamp is the floor — otherwise a worker whose brief never landed would
/// read as busy for ever. A line with no timestamp leaves nothing to measure
/// against, and the worker is left alone until it speaks.
pub fn silent_since_ms(facts: &Facts, line: &ReportingLine) -> Option<i64> {
    facts.last_commit_ms.or(line.written_at_ms)
}

#[cfg(test)]
mod four_states {
    use super::*;
    use crate::facts::Observation;

    const QUIET_AFTER_MS: i64 = 600_000;
    const NOW_MS: i64 = 1_754_000_000_000;

    fn working_on(query: &str, at_ms: i64) -> Facts {
        let mut facts = Facts::default();
        facts.apply(&Observation::Committed {
            query: query.into(),
            at_ms,
        });
        facts
    }

    fn finished(query: &str, at_ms: i64) -> Facts {
        let mut facts = working_on(query, at_ms);
        facts.apply(&Observation::Closed {
            query: query.into(),
        });
        facts
    }

    #[test]
    fn an_open_query_on_a_conversation_that_just_spoke_is_working() {
        let expected = State::Working;

        let actual = classify(
            &working_on("q-1", NOW_MS - 8 * 60_000),
            NOW_MS - 8 * 60_000,
            NOW_MS,
            QUIET_AFTER_MS,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn an_open_query_on_a_conversation_that_has_gone_quiet_is_dead_mid_turn() {
        let expected = State::DeadMidTurn;

        let actual = classify(
            &working_on("q-1", NOW_MS - 23 * 3_600_000),
            NOW_MS - 23 * 3_600_000,
            NOW_MS,
            QUIET_AFTER_MS,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn no_open_query_on_a_conversation_that_just_spoke_is_finished() {
        let expected = State::Finished;

        let actual = classify(
            &finished("q-1", NOW_MS - 30_000),
            NOW_MS - 30_000,
            NOW_MS,
            QUIET_AFTER_MS,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn no_open_query_on_a_conversation_that_has_gone_quiet_is_idle() {
        let expected = State::Idle;

        let actual = classify(
            &finished("q-1", NOW_MS - 3 * 3_600_000),
            NOW_MS - 3 * 3_600_000,
            NOW_MS,
            QUIET_AFTER_MS,
        );

        assert_eq!(actual, expected);
    }

    /// A worker on its very first turn has an open query and no close at all,
    /// which is the second row of the fleet reading: working normally, not a
    /// missing close to worry about.
    #[test]
    fn a_first_turn_with_no_close_yet_is_working() {
        let expected = State::Working;

        let actual = classify(
            &working_on("q-1", NOW_MS - 1_000),
            NOW_MS - 1_000,
            NOW_MS,
            QUIET_AFTER_MS,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn only_working_is_left_alone() {
        let expected = vec![false, true, true, true];

        let actual = vec![
            State::Working.is_worth_telling(),
            State::DeadMidTurn.is_worth_telling(),
            State::Finished.is_worth_telling(),
            State::Idle.is_worth_telling(),
        ];

        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod silent_since_ms {
    use super::*;
    use crate::facts::Observation;

    fn line(written_at_ms: Option<i64>) -> ReportingLine {
        ReportingLine {
            worker: "worker-1".into(),
            owner: "handler-1".into(),
            written_at_ms,
        }
    }

    #[test]
    fn measures_from_the_last_committed_message() {
        let expected = Some(500);
        let mut facts = Facts::default();
        facts.apply(&Observation::Committed {
            query: "q-1".into(),
            at_ms: 500,
        });

        let actual = silent_since_ms(&facts, &line(Some(100)));

        assert_eq!(actual, expected);
    }

    /// A worker that was commissioned and never spoke is not busy; it is a
    /// worker whose brief never landed, and the line is the only clock.
    #[test]
    fn falls_back_to_when_the_line_was_written_when_nothing_was_ever_committed() {
        let expected = Some(100);

        let actual = silent_since_ms(&Facts::default(), &line(Some(100)));

        assert_eq!(actual, expected);
    }

    #[test]
    fn has_nothing_to_measure_when_neither_exists() {
        let expected = None;

        let actual = silent_since_ms(&Facts::default(), &line(None));

        assert_eq!(actual, expected);
    }
}
