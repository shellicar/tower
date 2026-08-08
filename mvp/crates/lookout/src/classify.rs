//! The reading, from the facts and two thresholds.
//!
//! Waking on every query close is not enough, and a live fleet showed why: on
//! 5 August a worker had opened an `Exec` running a long sleep, the process
//! went away mid-call, and the `tool_result` never arrived — so the query
//! never closed and no event was ever published again. It had been silently
//! finished-and-not-reporting for 23 hours, and the human found it, not the
//! machinery. Absence of events is the signal, and absence has no event, which
//! is why something must tick.
//!
//! Silence alone cannot carry that, though, and no threshold fixes it. The
//! agent host publishes nothing whatever between committing a tool call and
//! committing its result, so a worker twelve minutes into a build is silent in
//! exactly the way a corpse is. What separates them is not a better number but
//! a different fact: the tool was announced before it ran, so a tool
//! outstanding with nothing committed since is positive evidence that work was
//! started, and the silence has a cause rather than a guess.
//!
//! So an outstanding tool absorbs the silence edge, but only up to the longest
//! a tool can actually run. Past that the absorb has stopped explaining
//! anything and the wait itself is the thing to report. That is what the
//! 5 August worker was: an `Exec` outstanding for 23 hours, which no running
//! tool can be.

use crate::facts::Facts;
use crate::lines::ReportingLine;

/// How long each kind of quiet is allowed to run before it is worth saying.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    /// How long a conversation may say nothing before its silence is a fact
    /// worth reporting. The longest legitimate silence seen on this fleet is
    /// a workspace build; the dead ones were silent for hours.
    pub quiet_after_ms: i64,
    /// The longest a tool can be outstanding and still be running. This is a
    /// property of the agent host rather than a tuning knob: `Exec` carries a
    /// hard maximum, so a tool outstanding for longer than that has not
    /// finished late, it has not finished at all. Configurable because the
    /// host's limit can move, and the two must not drift apart silently.
    pub tool_max_ms: i64,
}

/// The reading. `Working` is the only one that is left alone; the rest are
/// worth a handler's attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// A query is open, and either the conversation is still speaking or a
    /// tool it announced could still be running.
    Working,
    /// A tool has been outstanding longer than a tool can run. What that means
    /// is the handler's to judge: the fact is the wait, not a death.
    ToolOverrun,
    /// A query is open, the conversation has stopped speaking, and no tool is
    /// out to account for it.
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

/// A state and the query it is about. The query is what makes two readings
/// different when the state alone is the same: a worker that finishes, is
/// briefed again and finishes again has two things to say, not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    pub state: State,
    pub query: Option<String>,
}

pub fn classify(
    facts: &Facts,
    silent_since_ms: i64,
    now_ms: i64,
    thresholds: &Thresholds,
) -> Reading {
    let recent = now_ms.saturating_sub(silent_since_ms) < thresholds.quiet_after_ms;
    let open = facts.open.as_ref().map(|open| open.id.clone());
    let state = match (&facts.open, recent) {
        (None, true) => State::Finished,
        (None, false) => State::Idle,
        (Some(_), true) => State::Working,
        (Some(_), false) => match facts.tool_outstanding_since() {
            Some(since) if now_ms.saturating_sub(since) > thresholds.tool_max_ms => {
                State::ToolOverrun
            }
            Some(_) => State::Working,
            None => State::DeadMidTurn,
        },
    };
    let query = match state {
        // A finished or idle worker is between queries, so the reading is
        // about the one that ended.
        State::Finished | State::Idle => facts.last_closed_query.clone(),
        _ => open,
    };
    Reading { state, query }
}

/// The moment silence is measured from. A worker that has committed nothing
/// has still been silent since somebody commissioned it, so the line's own
/// timestamp is the floor — otherwise a worker whose brief never landed would
/// read as busy for ever. A line with no timestamp leaves nothing to measure
/// against, and the worker is left alone until it speaks.
pub fn silent_since_ms(facts: &Facts, line: &ReportingLine) -> Option<i64> {
    facts.last_activity_ms.or(line.written_at_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::facts::Observation;

    const NOW_MS: i64 = 1_754_000_000_000;
    const MINUTE: i64 = 60_000;
    const HOUR: i64 = 3_600_000;

    fn thresholds() -> Thresholds {
        Thresholds {
            quiet_after_ms: 10 * MINUTE,
            tool_max_ms: 15 * MINUTE,
        }
    }

    fn fold(observations: &[Observation]) -> Facts {
        let mut facts = Facts::default();
        for observation in observations {
            facts.apply(observation);
        }
        facts
    }

    fn committed(at_ms: i64) -> Observation {
        Observation::Committed {
            query: "q-1".into(),
            at_ms,
        }
    }

    fn tool(at_ms: i64) -> Observation {
        Observation::ToolStarted {
            query: "q-1".into(),
            at_ms,
        }
    }

    fn read(facts: &Facts, silent_since_ms: i64) -> State {
        classify(facts, silent_since_ms, NOW_MS, &thresholds()).state
    }

    mod four_states {
        use super::*;

        #[test]
        fn an_open_query_on_a_conversation_that_just_spoke_is_working() {
            let expected = State::Working;
            let at = NOW_MS - 8 * MINUTE;

            let actual = read(&fold(&[committed(at)]), at);

            assert_eq!(actual, expected);
        }

        #[test]
        fn an_open_query_on_a_conversation_that_has_gone_quiet_is_dead_mid_turn() {
            let expected = State::DeadMidTurn;
            let at = NOW_MS - 23 * HOUR;

            let actual = read(&fold(&[committed(at)]), at);

            assert_eq!(actual, expected);
        }

        #[test]
        fn no_open_query_on_a_conversation_that_just_spoke_is_finished() {
            let expected = State::Finished;
            let at = NOW_MS - 30_000;

            let actual = read(
                &fold(&[
                    committed(at),
                    Observation::Closed {
                        query: "q-1".into(),
                    },
                ]),
                at,
            );

            assert_eq!(actual, expected);
        }

        #[test]
        fn no_open_query_on_a_conversation_that_has_gone_quiet_is_idle() {
            let expected = State::Idle;
            let at = NOW_MS - 3 * HOUR;

            let actual = read(
                &fold(&[
                    committed(at),
                    Observation::Closed {
                        query: "q-1".into(),
                    },
                ]),
                at,
            );

            assert_eq!(actual, expected);
        }

        #[test]
        fn only_working_is_left_alone() {
            let expected = vec![false, true, true, true, true];

            let actual = vec![
                State::Working.is_worth_telling(),
                State::ToolOverrun.is_worth_telling(),
                State::DeadMidTurn.is_worth_telling(),
                State::Finished.is_worth_telling(),
                State::Idle.is_worth_telling(),
            ];

            assert_eq!(actual, expected);
        }
    }

    mod the_absorb {
        use super::*;

        /// The twelve minute build. Silence past the quiet threshold, but a
        /// tool was announced and nothing has committed since, so the silence
        /// has a cause and the worker is left alone.
        #[test]
        fn a_worker_waiting_on_a_tool_within_the_bound_is_working() {
            let expected = State::Working;
            let at = NOW_MS - 12 * MINUTE;

            let actual = read(&fold(&[committed(at), tool(at)]), at);

            assert_eq!(actual, expected);
        }

        /// The founding case: an `Exec` outstanding for 23 hours, which no
        /// running tool can be. Absorbing it without limit is what made the
        /// daemon blind to the incident it was built for.
        #[test]
        fn a_worker_waiting_on_a_tool_past_the_bound_is_a_tool_overrun() {
            let expected = State::ToolOverrun;
            let at = NOW_MS - 23 * HOUR;

            let actual = read(&fold(&[committed(at), tool(at)]), at);

            assert_eq!(actual, expected);
        }

        /// Once the tool's result commits the explanation is spent, so a
        /// worker that then goes quiet is surfaced as before.
        #[test]
        fn a_worker_quiet_since_its_tool_came_back_is_dead_mid_turn() {
            let expected = State::DeadMidTurn;

            let actual = read(
                &fold(&[
                    committed(NOW_MS - 2 * HOUR),
                    tool(NOW_MS - 2 * HOUR),
                    committed(NOW_MS - HOUR),
                ]),
                NOW_MS - HOUR,
            );

            assert_eq!(actual, expected);
        }

        /// An announcement from a query that has since closed must not go on
        /// explaining a silence that outlived it.
        #[test]
        fn a_tool_from_a_closed_query_does_not_absorb() {
            let expected = State::Idle;
            let at = NOW_MS - 3 * HOUR;

            let actual = read(
                &fold(&[
                    committed(at),
                    tool(at),
                    Observation::Closed {
                        query: "q-1".into(),
                    },
                ]),
                at,
            );

            assert_eq!(actual, expected);
        }

        /// The bound is the agent host's limit, not a reading of this fleet,
        /// so it has to be able to move without touching the classifier.
        #[test]
        fn the_bound_is_configurable() {
            let expected = State::Working;
            let at = NOW_MS - 23 * HOUR;
            let generous = Thresholds {
                quiet_after_ms: 10 * MINUTE,
                tool_max_ms: 24 * HOUR,
            };

            let actual = classify(&fold(&[committed(at), tool(at)]), at, NOW_MS, &generous).state;

            assert_eq!(actual, expected);
        }
    }

    mod what_a_reading_is_about {
        use super::*;

        #[test]
        fn a_finished_reading_names_the_query_that_closed() {
            let expected = Some("q-1".to_string());
            let at = NOW_MS - 30_000;

            let actual = classify(
                &fold(&[
                    committed(at),
                    Observation::Closed {
                        query: "q-1".into(),
                    },
                ]),
                at,
                NOW_MS,
                &thresholds(),
            )
            .query;

            assert_eq!(actual, expected);
        }

        /// Two turns finishing are two things to say. Keying only on the
        /// state made the second one look like the first.
        #[test]
        fn a_second_turn_finishing_names_a_different_query() {
            let expected = Some("q-2".to_string());
            let at = NOW_MS - 30_000;

            let actual = classify(
                &fold(&[
                    committed(NOW_MS - 3 * MINUTE),
                    Observation::Closed {
                        query: "q-1".into(),
                    },
                    Observation::Committed {
                        query: "q-2".into(),
                        at_ms: at,
                    },
                    Observation::Closed {
                        query: "q-2".into(),
                    },
                ]),
                at,
                NOW_MS,
                &thresholds(),
            )
            .query;

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_reading_about_an_open_query_names_that_query() {
            let expected = Some("q-1".to_string());
            let at = NOW_MS - 23 * HOUR;

            let actual = classify(&fold(&[committed(at)]), at, NOW_MS, &thresholds()).query;

            assert_eq!(actual, expected);
        }
    }

    mod silent_since {
        use super::*;

        fn line(written_at_ms: Option<i64>) -> ReportingLine {
            ReportingLine {
                worker: "worker-1".into(),
                owner: "handler-1".into(),
                written_at_ms,
            }
        }

        #[test]
        fn measures_from_the_last_activity() {
            let expected = Some(500);

            let actual = silent_since_ms(&fold(&[committed(500)]), &line(Some(100)));

            assert_eq!(actual, expected);
        }

        /// A worker that was commissioned and never spoke is not busy; it is
        /// a worker whose brief never landed, and the line is the only clock.
        #[test]
        fn falls_back_to_when_the_line_was_written_when_nothing_was_committed() {
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
}
