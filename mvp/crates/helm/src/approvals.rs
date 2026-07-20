//! The approvals concern's own store — helm's slice of the approval stream,
//! arriving over the attach fd like everything else (bridge mirrors
//! `approval.v1.*` there since the tee was extended to the gate). Modelled on
//! tower frontend's `concerns/approvals.svelte.ts`: upsert by id, void is the
//! client's own derivation against its clock (~3 missed 15s pulses — the
//! spec's fold, never a stored verdict), answering is a request whose
//! settlement arrives back as an ordinary lifecycle event.

use std::collections::HashMap;

use wire::{ApprovalKind, ApprovalLifecycle};

/// ~3 missed 15s heartbeats: the holder has gone quiet, the ask is void —
/// greyed for display, dismissed rather than answered.
const VOID_AFTER_MS: i64 = 45_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    /// Verbatim `{ type, ... }` — rendered, never interpreted.
    pub ask: serde_json::Value,
    pub correlation: Option<serde_json::Value>,
    pub raised_ts: String,
    /// The freshest liveness evidence: the raise seeds it, heartbeats and
    /// the settlement advance it.
    pub last_pulse_ms: i64,
    /// None while pending; the settlement's verdict once one lands.
    pub settled: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct Approvals {
    asks: HashMap<String, Ask>,
}

impl Approvals {
    /// Fold one approval event, keyed by the approval id the subject carried.
    /// An unknown id on a heartbeat or settlement is an ask raised before we
    /// attached — represented as far as the event allows, never dropped:
    /// a heartbeat alone can't reconstruct the ask, so it is skipped, but a
    /// raise always lands whole.
    pub fn fold(&mut self, id: &str, kind: &ApprovalKind) {
        match kind {
            ApprovalKind::Lifecycle(ApprovalLifecycle::Raised {
                ts,
                ask,
                correlation,
            }) => {
                self.asks.insert(
                    id.to_string(),
                    Ask {
                        ask: ask.clone(),
                        correlation: correlation.clone(),
                        raised_ts: ts.clone(),
                        last_pulse_ms: wire::parse_ts(ts).unwrap_or(0),
                        settled: None,
                    },
                );
            }
            ApprovalKind::Lifecycle(ApprovalLifecycle::Settled { ts, approved, .. }) => {
                if let Some(ask) = self.asks.get_mut(id) {
                    ask.settled = Some(*approved);
                    if let Some(ms) = wire::parse_ts(ts) {
                        ask.last_pulse_ms = ask.last_pulse_ms.max(ms);
                    }
                }
            }
            ApprovalKind::Heartbeat { ts } => {
                if let Some(ask) = self.asks.get_mut(id)
                    && let Some(ms) = wire::parse_ts(ts)
                {
                    ask.last_pulse_ms = ask.last_pulse_ms.max(ms);
                }
            }
            ApprovalKind::Unknown { .. } => {}
        }
    }

    /// Pending asks oldest-first — a waiting agent burns wall-clock.
    pub fn pending(&self) -> Vec<(&str, &Ask)> {
        let mut pending: Vec<_> = self
            .asks
            .iter()
            .filter(|(_, a)| a.settled.is_none())
            .map(|(id, a)| (id.as_str(), a))
            .collect();
        pending.sort_by(|a, b| a.1.raised_ts.cmp(&b.1.raised_ts));
        pending
    }

    /// The client's own verdict against its own clock — facts in, judgement
    /// out; nothing stores "void".
    pub fn is_void(&self, ask: &Ask, now_ms: i64) -> bool {
        now_ms - ask.last_pulse_ms > VOID_AFTER_MS
    }

    /// The asks actually waiting on a human: pending AND alive.
    pub fn live(&self, now_ms: i64) -> Vec<(&str, &Ask)> {
        self.pending()
            .into_iter()
            .filter(|(_, a)| !self.is_void(a, now_ms))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::WireEvent;

    fn replay(fixture: &str) -> Approvals {
        let mut approvals = Approvals::default();
        for line in fixture.lines().filter(|l| !l.is_empty()) {
            let record: serde_json::Value = serde_json::from_str(line).expect("fixture line is json");
            let subject = record["subject"].as_str().expect("subject");
            let payload = serde_json::to_vec(&record["message"]).expect("message");
            if let Some(WireEvent::Approval(event)) = wire::parse_wire(subject, &payload) {
                approvals.fold(&event.id.0, &event.kind);
            }
        }
        approvals
    }

    const SCENARIO_6A: &str = include_str!("../../../../docs/spec/fixtures/scenario-6a.jsonl");
    const SCENARIO_6B: &str = include_str!("../../../../docs/spec/fixtures/scenario-6b.jsonl");

    #[test]
    fn scenario_6a_raises_pulses_and_settles_approved() {
        let approvals = replay(SCENARIO_6A);
        let ask = approvals.asks.get("apr-1").expect("apr-1 exists");
        assert_eq!(ask.settled, Some(true));
        assert_eq!(ask.ask["name"], "DeleteFile");
        assert_eq!(
            ask.correlation.as_ref().expect("correlation")["conversationId"],
            "conv-abc"
        );
        assert!(approvals.pending().is_empty());
    }

    #[test]
    fn scenario_6b_pending_ask_goes_void_when_the_pulse_stops() {
        let approvals = replay(SCENARIO_6B);
        let pending = approvals.pending();
        assert_eq!(pending.len(), 1);
        let (_, ask) = pending[0];
        assert_eq!(ask.settled, None);
        // Just after the last pulse: alive. Beyond three missed pulses: void.
        assert!(!approvals.is_void(ask, ask.last_pulse_ms + 1_000));
        assert!(approvals.is_void(ask, ask.last_pulse_ms + VOID_AFTER_MS + 1));
        assert!(approvals.live(ask.last_pulse_ms + VOID_AFTER_MS + 1).is_empty());
    }

    #[test]
    fn a_heartbeat_for_an_unraised_ask_is_skipped_not_a_panic() {
        let mut approvals = Approvals::default();
        approvals.fold(
            "apr-ghost",
            &ApprovalKind::Heartbeat {
                ts: "2026-07-07T21:00:00+10:00".into(),
            },
        );
        assert!(approvals.asks.get("apr-ghost").is_none());
    }
}
