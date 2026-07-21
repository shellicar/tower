//! The usage concern's own store — helm's slice of `telemetry.usage`.
//! Modelled on tower frontend's `concerns/usage.svelte.ts`, with one wire
//! difference: tower's WS `usage` frame is an absolute snapshot (towerd
//! accumulates), but the raw conv.v2 `telemetry.usage` frames helm folds are
//! per-turn — the API reports usage in frames across a turn — so helm owns
//! the accumulation itself. Facts only: dollars and percentages are display
//! policy, derived where they are read.

use wire::{ConvTelemetry, EventKind};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    pub input_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    /// Summed from the frames that carried one; None until any did — absent
    /// is not zero (report what you know, fabricate nothing).
    pub cost_usd: Option<f64>,
    /// Frames folded, so a renderer can distinguish "no usage yet" at a
    /// glance without a second flag.
    pub frames: u64,
}

impl Usage {
    pub fn fold(&mut self, kind: &EventKind) {
        let EventKind::Telemetry(ConvTelemetry::Usage(u)) = kind else {
            return; // not this concern's
        };
        self.input_tokens += u.input_tokens;
        self.cache_creation_tokens += u.cache_creation_tokens;
        self.cache_read_tokens += u.cache_read_tokens;
        self.output_tokens += u.output_tokens;
        if let Some(cost) = u.cost_usd {
            *self.cost_usd.get_or_insert(0.0) += cost;
        }
        self.frames += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::WireEvent;

    /// The same fixture replay discipline as the conversation fold's tests.
    fn replay(fixture: &str) -> Usage {
        let mut usage = Usage::default();
        for line in fixture.lines().filter(|l| !l.is_empty()) {
            let record: serde_json::Value =
                serde_json::from_str(line).expect("fixture line is json");
            let subject = record["subject"].as_str().expect("subject");
            let payload = serde_json::to_vec(&record["message"]).expect("message");
            if let Some(WireEvent::Conv(event)) = wire::parse_wire(subject, &payload) {
                usage.fold(&event.kind);
            }
        }
        usage
    }

    const SCENARIO_1: &str = include_str!("../../../../docs/spec/fixtures/v2/scenario-1.jsonl");

    #[test]
    fn scenario_1_accumulates_both_turns() {
        let usage = replay(SCENARIO_1);
        assert_eq!(usage.frames, 2);
        assert_eq!(usage.input_tokens, 1200 + 1400);
        assert_eq!(usage.cache_read_tokens, 1200);
        assert_eq!(usage.output_tokens, 80 + 150);
        assert_eq!(usage.cost_usd, Some(0.005 + 0.006));
    }

    #[test]
    fn cost_stays_none_until_a_frame_carries_one() {
        let usage = Usage::default();
        assert_eq!(usage.cost_usd, None);
    }

    #[test]
    fn non_usage_events_are_a_no_op() {
        let mut usage = Usage::default();
        usage.fold(&EventKind::Delta(wire::ConvDelta { text: "x".into() }));
        assert_eq!(usage, Usage::default());
    }
}
