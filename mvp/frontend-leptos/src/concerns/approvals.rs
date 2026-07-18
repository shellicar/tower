//! concerns/approvals — the approvals' owned store (docs/mvp/
//! frontend-architecture.md), ported verbatim from frontend-rs's
//! approvals.rs: the fold logic is render-framework-agnostic. It folds its
//! OWN slice of the approval stream: void is derived against the passed
//! clock, answer is an id-correlated request (recorded and matched locally,
//! the fan-out way), and the settlement arrives as an `approval` frame like
//! any other.
//!
//! This is the "shared value" done by events, not a shared store — Decision
//! 2's hard case. The rail folds its own marker, the panel its own, this view
//! the whole list; no approval surface is shared. The conversation LABEL for
//! an ask is read from the rail concern by the renderer, not folded here.

use std::collections::HashMap;

use serde_json::Value;
use ws_types::{ClientMsg, ServerMsg, WsApproval};

use crate::time::{Millis, approval_void};

#[derive(Default)]
pub struct Approvals {
    approvals: HashMap<String, WsApproval>,
    /// Transient outcome of the last answer per approval id, for display.
    answer_notes: HashMap<String, String>,
    /// req_id → approval id, so an `answer_result` finds the ask it answered.
    pending: HashMap<String, String>,
}

impl Approvals {
    pub fn apply(&mut self, event: &ServerMsg) {
        match event {
            // The outstanding snapshot replaces the map — once per connection.
            ServerMsg::Approvals { approvals } => {
                self.approvals = approvals
                    .iter()
                    .map(|a| (a.id.clone(), a.clone()))
                    .collect();
            }
            // Upsert by id: an unknown id is a new ask being born.
            ServerMsg::Approval(a) => {
                self.approvals.insert(a.id.clone(), a.clone());
            }
            ServerMsg::AnswerResult {
                id,
                outcome,
                reason,
            } => {
                if let Some(approval_id) = self.pending.remove(id)
                    && outcome != "accepted"
                {
                    let note = if outcome == "rejected" {
                        format!("rejected: {}", reason.as_deref().unwrap_or(""))
                    } else {
                        "unreachable — the holder is gone".to_owned()
                    };
                    self.answer_notes.insert(approval_id, note);
                }
            }
            _ => {} // not this concern's
        }
    }

    /// Pending asks oldest-first — a waiting Claude burns wall-clock.
    /// Dismissed asks are excluded, same footing as settled: a human's own
    /// decision, not a claim the ask was answered (docs/spec/agent-spec.md's
    /// "connection is authority" — settled 19 Jul).
    pub fn pending(&self) -> Vec<&WsApproval> {
        let mut asks: Vec<&WsApproval> = self
            .approvals
            .values()
            .filter(|a| a.settled.is_none() && !a.dismissed)
            .collect();
        asks.sort_by_key(|a| a.raised_ts);
        asks
    }

    /// Void is this client's derivation (~3 missed 15s pulses): the holder died.
    /// A void ask stays visible, greyed, to be dismissed — not answered.
    pub fn is_void(&self, a: &WsApproval, now: Millis) -> bool {
        approval_void(now, a.last_pulse)
    }

    /// The asks actually waiting on a human: pending AND alive.
    pub fn live(&self, now: Millis) -> Vec<&WsApproval> {
        self.pending()
            .into_iter()
            .filter(|a| !self.is_void(a, now))
            .collect()
    }

    /// Live asks for one conversation — the panel's in-context answer surface.
    pub fn live_for_conv<'a>(&'a self, conv: &str, now: Millis) -> Vec<&'a WsApproval> {
        self.live(now)
            .into_iter()
            .filter(|a| conv_of(a) == Some(conv))
            .collect()
    }

    pub fn answer_note(&self, id: &str) -> Option<&str> {
        self.answer_notes.get(id).map(String::as_str)
    }

    /// Answer a pending approval. First valid answer wins; losing the race comes
    /// back as `rejected`/unreachable and is shown, not treated as error. The
    /// settlement arrives as an `approval` frame.
    pub fn answer(&mut self, approval_id: &str, approved: bool, req_id: String) -> ClientMsg {
        self.answer_notes.remove(approval_id);
        self.pending.insert(req_id.clone(), approval_id.to_owned());
        ClientMsg::Answer {
            id: req_id,
            approval: approval_id.to_owned(),
            approved,
        }
    }

    /// A human's own decision ("connection is authority") to stop tracking
    /// this ask — not an answer (nobody settles an abandoned ask), and not a
    /// merely-local hide: persisted server-side, so it survives a reconnect
    /// and reaches every other connected client too. The updated state
    /// (`dismissed: true`) arrives back through the ordinary `Approval`
    /// broadcast, same as any other fold — this method only sends.
    pub fn dismiss(&self, id: &str, req_id: String) -> ClientMsg {
        ClientMsg::DismissApproval {
            id: req_id,
            approval: id.to_owned(),
        }
    }
}

/// The conversation an ask belongs to — `correlation.conversationId`, verbatim.
pub fn conv_of(a: &WsApproval) -> Option<&str> {
    a.correlation
        .as_ref()
        .and_then(|c| c.get("conversationId"))
        .and_then(Value::as_str)
}

/// The ask's kind — `ask.type`, an open set.
pub fn ask_kind(a: &WsApproval) -> &str {
    a.ask.get("type").and_then(Value::as_str).unwrap_or("ask")
}

/// The reviewable label: a `tool_use` ask carries the tool `name` (approval-
/// spec); anything else falls back to its kind.
pub fn ask_label(a: &WsApproval) -> &str {
    a.ask
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_else(|| ask_kind(a))
}

/// The ask's raw `input`, rendered compact — the reviewable primitive today
/// (approval-spec: raw tool input, read against tool knowledge). None when the
/// ask carries no input.
pub fn ask_input(a: &WsApproval) -> Option<String> {
    a.ask
        .get("input")
        .map(|v| serde_json::to_string(v).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ask(id: &str, conv: &str, raised: Millis, pulse: Millis, settled: bool) -> WsApproval {
        WsApproval {
            id: id.into(),
            ask: json!({ "type": "bash" }),
            correlation: Some(json!({ "conversationId": conv })),
            raised_ts: raised,
            last_pulse: pulse,
            settled: settled.then(|| ws_types::WsSettled {
                approved: true,
                by: json!({ "kind": "human" }),
                ts: pulse,
            }),
            dismissed: false,
        }
    }

    #[test]
    fn pending_is_oldest_first_and_excludes_settled() {
        let mut a = Approvals::default();
        a.apply(&ServerMsg::Approval(ask("p2", "c", 20, 100_000, false)));
        a.apply(&ServerMsg::Approval(ask("p1", "c", 10, 100_000, false)));
        a.apply(&ServerMsg::Approval(ask("done", "c", 5, 100_000, true)));
        let ids: Vec<&str> = a.pending().iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["p1", "p2"]); // oldest first, settled gone
    }

    #[test]
    fn void_asks_drop_out_of_live_but_stay_pending() {
        let mut a = Approvals::default();
        a.apply(&ServerMsg::Approval(ask("p1", "c", 1, 100_000, false)));
        assert_eq!(a.live(100_000).len(), 1);
        assert_eq!(a.live(100_000 + 46_000).len(), 0); // void → not live
        assert_eq!(a.pending().len(), 1); // but still pending
    }

    #[test]
    fn live_for_conv_filters_by_correlation() {
        let mut a = Approvals::default();
        a.apply(&ServerMsg::Approval(ask("p1", "c1", 1, 100_000, false)));
        a.apply(&ServerMsg::Approval(ask("p2", "c2", 1, 100_000, false)));
        let ids: Vec<&str> = a
            .live_for_conv("c1", 100_000)
            .iter()
            .map(|x| x.id.as_str())
            .collect();
        assert_eq!(ids, ["p1"]);
    }

    #[test]
    fn answer_records_then_a_rejected_result_notes() {
        let mut a = Approvals::default();
        a.apply(&ServerMsg::Approval(ask("p1", "c", 1, 100_000, false)));
        let msg = a.answer("p1", true, "req1".into());
        assert!(matches!(msg, ClientMsg::Answer { .. }));
        a.apply(&ServerMsg::AnswerResult {
            id: "req1".into(),
            outcome: "rejected".into(),
            reason: Some("already_settled".into()),
        });
        assert_eq!(a.answer_note("p1"), Some("rejected: already_settled"));
    }

    #[test]
    fn ask_label_and_input_read_the_tool_use_payload() {
        let mut ask = ask("p1", "c", 1, 100_000, false);
        ask.ask = json!({ "type": "tool_use", "name": "Bash", "input": { "command": "ls -la" } });
        assert_eq!(ask_label(&ask), "Bash");
        assert_eq!(ask_input(&ask).as_deref(), Some(r#"{"command":"ls -la"}"#));
    }

    #[test]
    fn an_unknown_ask_falls_back_to_its_kind() {
        let mut ask = ask("p1", "c", 1, 100_000, false);
        ask.ask = json!({ "type": "some_future_ask" });
        assert_eq!(ask_label(&ask), "some_future_ask");
        assert_eq!(ask_input(&ask), None);
    }

    #[test]
    fn dismiss_sends_and_the_broadcast_drops_it_from_pending() {
        let mut a = Approvals::default();
        a.apply(&ServerMsg::Approval(ask("p1", "c", 1, 100_000, false)));
        let msg = a.dismiss("p1", "r1".into());
        assert!(matches!(
            msg,
            ClientMsg::DismissApproval { approval, .. } if approval == "p1"
        ));
        // Not removed until the server's own broadcast confirms it — this
        // fold is the same as any upsert, `dismissed` just another field.
        assert_eq!(a.pending().len(), 1);
        let mut dismissed = ask("p1", "c", 1, 100_000, false);
        dismissed.dismissed = true;
        a.apply(&ServerMsg::Approval(dismissed));
        assert!(a.pending().is_empty());
    }
}
