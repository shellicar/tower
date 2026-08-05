//! Many worker events becoming one delivery per handler.
//!
//! Batching is what a funnel is, not an optimisation: not batching would be
//! the special case needing a reason. N wakes for N notes is how a supervisor
//! drowns the thing it supervises.
//!
//! A digest carries pointers, never payloads: which worker, which edge, and
//! enough for the handler to go and read it. The conversation is already
//! durable where it sits, and a relay of its content is a chance to distort
//! it for no gain.

use crate::classify::State;
use std::collections::BTreeMap;

/// One worker's change of state, as the handler receives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub worker: String,
    pub state: State,
    /// How long the worker has been silent when the digest was built, in
    /// milliseconds. The fact behind the reading, so a handler can judge the
    /// reading rather than take it.
    pub silent_for_ms: i64,
}

/// Everything one handler is told in one turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub handler: String,
    pub edges: Vec<Edge>,
}

/// Group edges by the owner on the line. The narrow end of the funnel is one
/// handler, so there is a delivery per handler rather than one per fleet.
pub fn batch(edges: Vec<(String, Edge)>) -> Vec<Delivery> {
    let mut by_handler: BTreeMap<String, Vec<Edge>> = BTreeMap::new();
    for (handler, edge) in edges {
        by_handler.entry(handler).or_default().push(edge);
    }
    by_handler
        .into_iter()
        .map(|(handler, edges)| Delivery { handler, edges })
        .collect()
}

/// What one handler reads. Every line names a worker's conversation id in
/// full, because that id is the whole of the pointer: it is what the handler
/// reads the conversation with.
pub fn render(delivery: &Delivery) -> String {
    let count = delivery.edges.len();
    let opening = if count == 1 {
        "1 worker on your reporting line has changed state.".to_string()
    } else {
        format!("{count} workers on your reporting line have changed state.")
    };
    let lines: Vec<String> = delivery.edges.iter().map(render_edge).collect();
    format!(
        "{opening}\n\n{}\n\nRead a worker by its conversation id. These are facts, not \
         verdicts: whether the work is good is yours to judge.",
        lines.join("\n")
    )
}

fn render_edge(edge: &Edge) -> String {
    let silence = humanise(edge.silent_for_ms);
    let reading = match edge.state {
        // Named even though it is never rendered: leaving it to a catch-all
        // would make a future state silently read as one of these.
        State::Working => format!("is working, and last spoke {silence} ago"),
        State::DeadMidTurn => format!(
            "has a query still open and has not spoken for {silence}: it died mid-turn, and \
             whatever it had done is unpushed"
        ),
        State::Finished => {
            format!("finished a turn and last spoke {silence} ago: there is something to read")
        }
        State::Idle => format!("has been idle for {silence}: it is waiting on someone"),
    };
    format!("- {} {}", edge.worker, reading)
}

/// Coarse on purpose: the handler is deciding whether to go and look, and no
/// decision turns on the difference between 23 and 24 hours.
fn humanise(ms: i64) -> String {
    let seconds = ms.max(0) / 1_000;
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3_600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3_600),
        s => format!("{}d", s / 86_400),
    }
}

#[cfg(test)]
mod batch {
    use super::*;

    fn edge(worker: &str) -> Edge {
        Edge {
            worker: worker.into(),
            state: State::Finished,
            silent_for_ms: 30_000,
        }
    }

    #[test]
    fn many_workers_on_one_line_become_one_delivery() {
        let expected = vec![Delivery {
            handler: "handler-1".into(),
            edges: vec![edge("worker-1"), edge("worker-2")],
        }];

        let actual = batch(vec![
            ("handler-1".into(), edge("worker-1")),
            ("handler-1".into(), edge("worker-2")),
        ]);

        assert_eq!(actual, expected);
    }

    #[test]
    fn workers_on_different_lines_become_a_delivery_each() {
        let expected = vec![
            Delivery {
                handler: "handler-1".into(),
                edges: vec![edge("worker-1")],
            },
            Delivery {
                handler: "handler-2".into(),
                edges: vec![edge("worker-2")],
            },
        ];

        let actual = batch(vec![
            ("handler-2".into(), edge("worker-2")),
            ("handler-1".into(), edge("worker-1")),
        ]);

        assert_eq!(actual, expected);
    }

    #[test]
    fn nothing_to_say_is_no_delivery_at_all() {
        let expected: Vec<Delivery> = vec![];

        let actual = batch(vec![]);

        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod render {
    use super::*;

    fn delivery(edges: Vec<Edge>) -> Delivery {
        Delivery {
            handler: "handler-1".into(),
            edges,
        }
    }

    #[test]
    fn names_the_worker_its_state_and_how_long_it_has_been_silent() {
        let expected = "1 worker on your reporting line has changed state.\n\n\
             - 45fb4f20-a222-42ff-9b35-ea434224772c finished a turn and last spoke 30s ago: \
             there is something to read\n\n\
             Read a worker by its conversation id. These are facts, not verdicts: whether the \
             work is good is yours to judge.";

        let actual = render(&delivery(vec![Edge {
            worker: "45fb4f20-a222-42ff-9b35-ea434224772c".into(),
            state: State::Finished,
            silent_for_ms: 30_000,
        }]));

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_the_workers_when_several_changed_at_once() {
        let expected = true;

        let actual = render(&delivery(vec![
            Edge {
                worker: "worker-1".into(),
                state: State::Finished,
                silent_for_ms: 30_000,
            },
            Edge {
                worker: "worker-2".into(),
                state: State::DeadMidTurn,
                silent_for_ms: 82_800_000,
            },
        ]))
        .starts_with("2 workers on your reporting line have changed state.");

        assert_eq!(actual, expected);
    }

    /// The digest is a pointer, so a worker that has been dead for a day is
    /// named by its id and its silence, and nothing it said travels.
    #[test]
    fn a_worker_dead_mid_turn_is_reported_by_id_and_silence() {
        let expected = "- worker-2 has a query still open and has not spoken for 23h: it died \
             mid-turn, and whatever it had done is unpushed";

        let actual = render_edge(&Edge {
            worker: "worker-2".into(),
            state: State::DeadMidTurn,
            silent_for_ms: 82_800_000,
        });

        assert_eq!(actual, expected);
    }

    #[test]
    fn an_idle_worker_is_reported_as_waiting_on_someone() {
        let expected = "- worker-3 has been idle for 3h: it is waiting on someone";

        let actual = render_edge(&Edge {
            worker: "worker-3".into(),
            state: State::Idle,
            silent_for_ms: 10_800_000,
        });

        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod humanise {
    use super::*;

    #[test]
    fn reads_seconds_below_a_minute() {
        let expected = "45s";

        let actual = humanise(45_000);

        assert_eq!(actual, expected);
    }

    #[test]
    fn reads_minutes_below_an_hour() {
        let expected = "12m";

        let actual = humanise(12 * 60_000);

        assert_eq!(actual, expected);
    }

    #[test]
    fn reads_hours_below_a_day() {
        let expected = "23h";

        let actual = humanise(23 * 3_600_000);

        assert_eq!(actual, expected);
    }

    #[test]
    fn reads_days_beyond_that() {
        let expected = "2d";

        let actual = humanise(2 * 86_400_000);

        assert_eq!(actual, expected);
    }

    /// A clock that disagrees with an event's own timestamp can make silence
    /// look negative; it reads as no time at all rather than as a negative
    /// duration.
    #[test]
    fn reads_a_negative_duration_as_none_at_all() {
        let expected = "0s";

        let actual = humanise(-5_000);

        assert_eq!(actual, expected);
    }
}
