//! concerns/rail — the staleness rail's owned store (docs/mvp/
//! frontend-architecture.md), mirroring the control's rail.svelte.ts. It folds
//! its OWN slices of three event families: rows (the staleness list), agent
//! facts (liveness + potential conversations), and approval facts (the
//! per-conversation pending marker). It reads no other concern's state, and it
//! holds no transport and no clock — `apply(&mut self, &ServerMsg)` gives it a
//! mutable borrow of only itself and a read-only frame, so it cannot reach a
//! sibling concern (the isolation is the signature, not a remembered rule). The
//! time verdicts take `now` as an argument at read time; the app owns the
//! clock and passes it in.
//!
//! The annotation writes (set_title/set_tag, optimistic self-patch) and the
//! `row()` read the open panel needs are deliberately absent until their slices
//! land — this concern surfaces exactly what a consumer reads today.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use ws_types::{ServerMsg, WsAgent, WsApproval, WsRow};

use crate::time::{Liveness, Millis, approval_void, liveness_verdict};

#[derive(Debug, Clone)]
struct Instance {
    last_pulse: Millis,
    interval_s: Option<i64>,
}

#[derive(Debug, Clone)]
struct Attachment {
    conv: String,
    world: String,
    instance_id: String,
}

#[derive(Debug, Clone)]
struct Ask {
    conv: Option<String>,
    last_pulse: Millis,
    settled: bool,
}

#[derive(Default)]
pub struct Rail {
    rows: HashMap<String, WsRow>,
    tag_keys: HashMap<String, String>,
    instances: HashMap<String, Instance>,
    attachments: HashMap<String, Attachment>,
    asks: HashMap<String, Ask>,
}

impl Rail {
    pub fn apply(&mut self, event: &ServerMsg) {
        match event {
            ServerMsg::List { rows, tag_keys } => {
                self.rows = rows.iter().map(|r| (r.conv.clone(), r.clone())).collect();
                if !tag_keys.is_empty() {
                    self.tag_keys = tag_keys.clone();
                }
            }
            // A row never carries annotations, so held title/tags survive: a
            // rename is not fleet activity and must not touch staleness.
            ServerMsg::Row {
                conv,
                last_event,
                last_kind,
            } => {
                let held = self.rows.get(conv);
                let row = WsRow {
                    conv: conv.clone(),
                    last_event: *last_event,
                    last_kind: last_kind.clone(),
                    title: held.and_then(|h| h.title.clone()),
                    tags: held.map(|h| h.tags.clone()).unwrap_or_default(),
                };
                self.rows.insert(conv.clone(), row);
            }
            ServerMsg::Agents {
                instances,
                attachments,
            } => {
                self.instances = instances
                    .iter()
                    .map(|i| {
                        (
                            format!("{}/{}", i.world, i.instance_id),
                            Instance {
                                last_pulse: i.last_pulse,
                                interval_s: i.interval_s,
                            },
                        )
                    })
                    .collect();
                self.attachments = attachments
                    .iter()
                    .map(|a| {
                        (
                            format!("{}/{}/{}", a.world, a.instance_id, a.conv),
                            Attachment {
                                conv: a.conv.clone(),
                                world: a.world.clone(),
                                instance_id: a.instance_id.clone(),
                            },
                        )
                    })
                    .collect();
            }
            ServerMsg::Agent(fact) => self.fold_agent(fact),
            ServerMsg::Approvals { approvals } => {
                self.asks = approvals.iter().map(|a| (a.id.clone(), ask_of(a))).collect();
            }
            ServerMsg::Approval(a) => {
                self.asks.insert(a.id.clone(), ask_of(a));
            }
            _ => {} // not the rail's concern
        }
    }

    fn fold_agent(&mut self, fact: &WsAgent) {
        let ikey = format!("{}/{}", fact.world, fact.instance_id);
        match fact.kind.as_str() {
            "ready" | "pulse" => {
                let held = self.instances.get(&ikey);
                let instance = Instance {
                    last_pulse: fact.ts.max(held.map(|h| h.last_pulse).unwrap_or(0)),
                    interval_s: fact.interval_s.or_else(|| held.and_then(|h| h.interval_s)),
                };
                self.instances.insert(ikey, instance);
            }
            "attached" => {
                if let Some(conv) = &fact.conv {
                    self.attachments.insert(
                        format!("{ikey}/{conv}"),
                        Attachment {
                            conv: conv.clone(),
                            world: fact.world.clone(),
                            instance_id: fact.instance_id.clone(),
                        },
                    );
                }
            }
            "detached" => {
                if let Some(conv) = &fact.conv {
                    self.attachments.remove(&format!("{ikey}/{conv}"));
                }
            }
            _ => {} // unknown/other kind: represented as nothing to fold
        }
    }

    /// Rows by lastEvent descending — the staleness order is the product.
    pub fn ordered(&self) -> Vec<&WsRow> {
        let mut rows: Vec<&WsRow> = self.rows.values().collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.last_event));
        rows
    }

    /// The liveness verdict for a conversation — facts in, judgement out
    /// (agent-spec: a fold, never declared). None = no live attachment.
    pub fn verdict(&self, conv: &str, now: Millis) -> Option<Liveness> {
        self.best_liveness(conv)
            .map(|i| liveness_verdict(now, i.last_pulse, i.interval_s))
    }

    fn best_liveness(&self, conv: &str) -> Option<&Instance> {
        self.attachments
            .values()
            .filter(|a| a.conv == conv)
            .filter_map(|a| self.instances.get(&format!("{}/{}", a.world, a.instance_id)))
            .max_by_key(|i| i.last_pulse)
    }

    /// Potential conversations: attached, no row yet — served, silent. They
    /// vanish with the attachment; the first committed message births a row.
    pub fn attached_only(&self) -> Vec<&str> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for a in self.attachments.values() {
            if !self.rows.contains_key(&a.conv) && seen.insert(a.conv.as_str()) {
                out.push(a.conv.as_str());
            }
        }
        out
    }

    /// Conversations with a LIVE pending ask (unsettled and not void), for the
    /// rail's marker — the rail's own slice of the approval stream, derived
    /// against the passed clock.
    pub fn pending_by_conv(&self, now: Millis) -> HashSet<String> {
        self.asks
            .values()
            .filter(|a| !a.settled)
            .filter(|a| !approval_void(now, a.last_pulse))
            .filter_map(|a| a.conv.clone())
            .collect()
    }
}

/// The rail's slice of an approval: which conversation, how fresh the holder,
/// whether it settled — the `correlation.conversationId` read verbatim.
fn ask_of(a: &WsApproval) -> Ask {
    Ask {
        conv: a
            .correlation
            .as_ref()
            .and_then(|c| c.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        last_pulse: a.last_pulse,
        settled: a.settled.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row_event(conv: &str, last_event: Millis) -> ServerMsg {
        ServerMsg::Row {
            conv: conv.to_owned(),
            last_event,
            last_kind: "message".to_owned(),
        }
    }

    fn conv_of<'a>(rail: &'a Rail, conv: &str) -> &'a WsRow {
        rail.ordered()
            .into_iter()
            .find(|r| r.conv == conv)
            .expect("row present")
    }

    #[test]
    fn rows_order_by_staleness_descending() {
        let mut rail = Rail::default();
        rail.apply(&row_event("a", 10));
        rail.apply(&row_event("b", 30));
        rail.apply(&row_event("c", 20));
        let order: Vec<&str> = rail.ordered().iter().map(|r| r.conv.as_str()).collect();
        assert_eq!(order, ["b", "c", "a"]);
    }

    #[test]
    fn a_row_upsert_preserves_held_annotations() {
        let mut rail = Rail::default();
        rail.apply(&ServerMsg::List {
            rows: vec![WsRow {
                conv: "a".into(),
                last_event: 1,
                last_kind: "message".into(),
                title: Some("named".into()),
                tags: HashMap::new(),
            }],
            tag_keys: HashMap::new(),
        });
        rail.apply(&row_event("a", 5));
        let row = conv_of(&rail, "a");
        assert_eq!(row.last_event, 5);
        assert_eq!(row.title.as_deref(), Some("named")); // survived the row event
    }

    #[test]
    fn liveness_folds_from_pulse_and_attachment() {
        let mut rail = Rail::default();
        rail.apply(&ServerMsg::Agent(WsAgent {
            kind: "pulse".into(),
            world: "w".into(),
            instance_id: "i".into(),
            ts: 100_000,
            conv: None,
            cwd: None,
            interval_s: Some(15),
            host: None,
        }));
        rail.apply(&ServerMsg::Agent(WsAgent {
            kind: "attached".into(),
            world: "w".into(),
            instance_id: "i".into(),
            ts: 100_000,
            conv: Some("a".into()),
            cwd: None,
            interval_s: None,
            host: None,
        }));
        assert_eq!(rail.verdict("a", 100_000), Some(Liveness::Alive));
        assert_eq!(rail.verdict("a", 100_000 + 46_000), Some(Liveness::Stranded));
        assert_eq!(rail.verdict("unknown", 100_000), None);
    }

    #[test]
    fn attached_without_a_row_is_a_potential_conversation() {
        let mut rail = Rail::default();
        rail.apply(&ServerMsg::Agent(WsAgent {
            kind: "attached".into(),
            world: "w".into(),
            instance_id: "i".into(),
            ts: 1,
            conv: Some("ghost".into()),
            cwd: None,
            interval_s: None,
            host: None,
        }));
        assert_eq!(rail.attached_only(), ["ghost"]);
        rail.apply(&row_event("ghost", 2)); // a message births the row
        assert!(rail.attached_only().is_empty());
    }

    #[test]
    fn pending_marker_excludes_settled_and_void() {
        let mut rail = Rail::default();
        let approval = |id: &str, pulse: Millis, settled: bool| {
            ServerMsg::Approval(WsApproval {
                id: id.into(),
                ask: json!({ "type": "bash" }),
                correlation: Some(json!({ "conversationId": "a" })),
                raised_ts: 0,
                last_pulse: pulse,
                settled: settled.then(|| ws_types::WsSettled {
                    approved: true,
                    by: json!({ "kind": "human" }),
                    ts: pulse,
                }),
            })
        };
        rail.apply(&approval("p1", 100_000, false));
        assert!(rail.pending_by_conv(100_000).contains("a"));
        assert!(!rail.pending_by_conv(100_000 + 46_000).contains("a")); // void
        rail.apply(&approval("p1", 100_000, true));
        assert!(!rail.pending_by_conv(100_000).contains("a")); // settled
    }
}
