//! concerns/rail — the staleness rail's owned store (docs/mvp/
//! frontend-architecture.md), ported verbatim from frontend-rs's rail.rs: the
//! fold logic is render-framework-agnostic, only the wrapper at the
//! composition root differs (a `RwSignal<Rail>` instead of a plain field
//! re-read each egui frame). It folds its OWN slices of three event
//! families: rows (the staleness list), agent facts (liveness + potential
//! conversations), and approval facts (the per-conversation pending marker).
//! Time verdicts take `now` as an argument at read time; the app owns the
//! clock and passes it in.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use ws_types::{ClientMsg, ServerMsg, WsAgent, WsApproval, WsRow, WsUnread};

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
    cwd: Option<String>,
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
    /// Conversations currently announced stale (the unread/ticket-system
    /// signal), folded from `StaleConversations` (replace) and
    /// `StaleConversation` (add/remove one, by its own `stale` flag).
    stale: HashSet<String>,
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
                                cwd: a.cwd.clone(),
                            },
                        )
                    })
                    .collect();
            }
            ServerMsg::Agent(fact) => self.fold_agent(fact),
            ServerMsg::Approvals { approvals } => {
                self.asks = approvals
                    .iter()
                    .map(|a| (a.id.clone(), ask_of(a)))
                    .collect();
            }
            ServerMsg::Approval(a) => {
                self.asks.insert(a.id.clone(), ask_of(a));
            }
            // A human dismissed it (tower's own annotation, never a claim
            // the agent detached) — drop it from the potential-conversation
            // list, same as a real `detached` would.
            ServerMsg::AttachmentDismissed { world, instance_id, conv } => {
                self.attachments.remove(&format!("{world}/{instance_id}/{conv}"));
            }
            ServerMsg::StaleConversations { conversations } => {
                self.stale = conversations.iter().map(|u| u.conv.clone()).collect();
            }
            ServerMsg::StaleConversation(WsUnread { conv, stale, .. }) => {
                if *stale {
                    self.stale.insert(conv.clone());
                } else {
                    self.stale.remove(conv);
                }
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
                // Attaching is itself evidence of life, and may carry the
                // liveness promise a `pulse` would otherwise be the only
                // source of — the gap where an instance that dies before its
                // first pulse read as alive forever (docs/spec/agent-spec.md).
                let held = self.instances.get(&ikey);
                let instance = Instance {
                    last_pulse: fact.ts.max(held.map(|h| h.last_pulse).unwrap_or(0)),
                    interval_s: fact.interval_s.or_else(|| held.and_then(|h| h.interval_s)),
                };
                self.instances.insert(ikey.clone(), instance);
                if let Some(conv) = &fact.conv {
                    self.attachments.insert(
                        format!("{ikey}/{conv}"),
                        Attachment {
                            conv: conv.clone(),
                            world: fact.world.clone(),
                            instance_id: fact.instance_id.clone(),
                            cwd: fact.cwd.clone(),
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

    /// The row for one conversation — its header facts and annotations.
    pub fn row(&self, conv: &str) -> Option<&WsRow> {
        self.rows.get(conv)
    }

    /// Every known tag key's colour — the shared colour language, identical
    /// on every client (ws-spec: `tagKeys` on `list`).
    pub fn tag_keys(&self) -> &HashMap<String, String> {
        &self.tag_keys
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
            .filter_map(|a| {
                self.instances
                    .get(&format!("{}/{}", a.world, a.instance_id))
            })
            .max_by_key(|i| i.last_pulse)
    }

    /// Potential conversations: attached, no row yet — served, silent. They
    /// vanish with the attachment; the first committed message births a row.
    /// Carries the cwd (mvp/frontend's `RowList` shows it under the id) and
    /// the liveness verdict, so the rail can render the same dot it uses for
    /// ordinary rows.
    pub fn attached_only(&self, now: Millis) -> Vec<PotentialConv<'_>> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for a in self.attachments.values() {
            if !self.rows.contains_key(&a.conv) && seen.insert(a.conv.as_str()) {
                out.push(PotentialConv {
                    conv: a.conv.as_str(),
                    cwd: a.cwd.as_deref(),
                    verdict: self.verdict(&a.conv, now),
                });
            }
        }
        out
    }

    /// Conversations currently flagged stale (unread/ticket-system signal) —
    /// the rail's own slice, a plain set (no clock derivation needed: towerd
    /// already re-checked the episode before broadcasting).
    pub fn stale_convs(&self) -> &HashSet<String> {
        &self.stale
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

    /// Rename a conversation — owned-fact optimism (mirrors the Svelte
    /// control's `setTitle`): the write leads, a reconnect's `list` is the
    /// authority if it ever disagrees. Empty title clears back to the id.
    /// None if the conversation has no row yet (nothing to rename).
    pub fn set_title(&mut self, conv: &str, title: String, id: String) -> Option<ClientMsg> {
        let row = self.rows.get_mut(conv)?;
        row.title = if title.is_empty() { None } else { Some(title.clone()) };
        Some(ClientMsg::SetTitle {
            id,
            conv: conv.to_owned(),
            title,
        })
    }

    /// A human's own decision ("connection is authority") to stop tracking a
    /// stranded potential conversation — not a claim the agent detached
    /// (that fact stays the agent's alone to publish). Persisted server-side
    /// via the request; the removal itself happens when the
    /// `AttachmentDismissed` broadcast arrives back, same as any other fold.
    /// `None` if nothing is attached under that key (nothing to dismiss).
    pub fn dismiss_attachment(&self, conv: &str, id: String) -> Option<ClientMsg> {
        let a = self.attachments.values().find(|a| a.conv == conv)?;
        Some(ClientMsg::DismissAttachment {
            id,
            world: a.world.clone(),
            instance_id: a.instance_id.clone(),
            conv: conv.to_owned(),
        })
    }
}

/// One attached-but-message-less conversation, as the rail renders it.
pub struct PotentialConv<'a> {
    pub conv: &'a str,
    pub cwd: Option<&'a str>,
    pub verdict: Option<Liveness>,
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
        assert_eq!(row.title.as_deref(), Some("named"));
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
        assert_eq!(
            rail.verdict("a", 100_000 + 46_000),
            Some(Liveness::Stranded)
        );
        assert_eq!(rail.verdict("unknown", 100_000), None);
    }

    #[test]
    fn attaching_alone_gives_a_liveness_basis_without_a_pulse() {
        let mut rail = Rail::default();
        // No pulse ever — attach is the only fact, and it carries the
        // interval itself (the closed gap).
        rail.apply(&ServerMsg::Agent(WsAgent {
            kind: "attached".into(),
            world: "w".into(),
            instance_id: "i".into(),
            ts: 100_000,
            conv: Some("a".into()),
            cwd: None,
            interval_s: Some(15),
            host: None,
        }));
        assert_eq!(rail.verdict("a", 100_000), Some(Liveness::Alive));
        assert_eq!(rail.verdict("a", 100_000 + 46_000), Some(Liveness::Stranded));
    }

    #[test]
    fn attaching_with_no_interval_still_strands_after_the_default() {
        let mut rail = Rail::default();
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
        assert_eq!(
            rail.verdict("a", 100_000 + 61_000),
            Some(Liveness::Stranded)
        );
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
        let potential = rail.attached_only(1);
        assert_eq!(potential.len(), 1);
        assert_eq!(potential[0].conv, "ghost");
        rail.apply(&row_event("ghost", 2));
        assert!(rail.attached_only(1).is_empty());
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
                dismissed: false,
            })
        };
        rail.apply(&approval("p1", 100_000, false));
        assert!(rail.pending_by_conv(100_000).contains("a"));
        assert!(!rail.pending_by_conv(100_000 + 46_000).contains("a"));
        rail.apply(&approval("p1", 100_000, true));
        assert!(!rail.pending_by_conv(100_000).contains("a"));
    }

    #[test]
    fn set_title_writes_optimistically_and_sends() {
        let mut rail = Rail::default();
        rail.apply(&row_event("a", 1));
        let msg = rail.set_title("a", "named".into(), "r1".into()).unwrap();
        assert!(matches!(msg, ClientMsg::SetTitle { .. }));
        assert_eq!(conv_of(&rail, "a").title.as_deref(), Some("named"));
        rail.set_title("a", "".into(), "r2".into());
        assert_eq!(conv_of(&rail, "a").title, None);
    }

    #[test]
    fn set_title_on_an_unknown_conversation_is_a_no_op() {
        let mut rail = Rail::default();
        assert!(rail.set_title("ghost", "x".into(), "r1".into()).is_none());
    }

    #[test]
    fn dismiss_attachment_sends_then_the_broadcast_removes_it() {
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
        let msg = rail.dismiss_attachment("ghost", "r1".into()).unwrap();
        assert!(matches!(msg, ClientMsg::DismissAttachment { .. }));
        // Not removed until the broadcast confirms it.
        assert_eq!(rail.attached_only(1).len(), 1);
        rail.apply(&ServerMsg::AttachmentDismissed {
            world: "w".into(),
            instance_id: "i".into(),
            conv: "ghost".into(),
        });
        assert!(rail.attached_only(1).is_empty());
    }

    #[test]
    fn dismiss_attachment_on_an_unknown_conversation_is_a_no_op() {
        let rail = Rail::default();
        assert!(rail.dismiss_attachment("ghost", "r1".into()).is_none());
    }
}
