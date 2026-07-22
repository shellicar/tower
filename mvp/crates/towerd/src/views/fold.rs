//! The event fold: `WireEvent` → committed sqlite rows + cursor advance +
//! `ViewEvent` broadcast, one transaction per event. Publish after commit:
//! subscribers read the db they can now see.

use serde_json::Value;

use wire::{
    AgentEvent, AgentKind, AgentTelemetry, ApprovalEvent, ApprovalKind, ApprovalLifecycle,
    ConvChange, ConvTelemetry, Event, EventKind, WireEvent, parse_ts,
};

use crate::refs::{Blob, externalise};

use super::Views;
use super::schema::read_usage_row;
use super::types::{AgentFact, ConversationMessage, RowChanged, UsageState, ViewEvent};

impl Views {
    /// One event → one transaction (tables + cursor), then the broadcast.
    pub fn apply(&mut self, stream_name: &str, seq: u64, event: &WireEvent) {
        let result = match event {
            WireEvent::Conv(e) => self.apply_conv(stream_name, seq, e),
            WireEvent::Approval(e) => self.apply_approval(stream_name, seq, e),
            WireEvent::Agent(e) => self.apply_agent(stream_name, seq, e),
        };
        if let Err(e) = result {
            // A poisoned frame must not kill the fold; it is logged and the
            // cursor still advances past it (skipping forever beats halting).
            eprintln!("views: apply failed at seq {seq}: {e:#}");
            let _ = self.db.execute(
                "INSERT INTO cursor (stream_name, seq) VALUES (?1, ?2)
                 ON CONFLICT (stream_name) DO UPDATE SET seq = excluded.seq",
                rusqlite::params![stream_name, seq as i64],
            );
        }
    }

    /// The approval fold (approval-spec, The outstanding set): raised inserts
    /// the candidate, the pulse refreshes `last_pulse`, settled records the
    /// outcome. Idempotent under replay; a raised re-delivered after settled
    /// never erases the settlement (the settled columns are not in the
    /// upsert). A pulse or settlement for an id never raised (pre-retention)
    /// is skipped — an ask is unreviewable without its raise.
    fn apply_approval(
        &mut self,
        stream_name: &str,
        seq: u64,
        event: &ApprovalEvent,
    ) -> anyhow::Result<()> {
        let id = &event.id;
        let tx = self.db.transaction()?;
        match &event.kind {
            ApprovalKind::Lifecycle(ApprovalLifecycle::Raised {
                ts,
                ask,
                correlation,
            }) => {
                let ts_ms = parse_ts(ts)
                    .ok_or_else(|| anyhow::anyhow!("raised {id} has unparseable ts {ts}"))?;
                let conv = correlation
                    .as_ref()
                    .and_then(|c| c.get("conversationId"))
                    .and_then(Value::as_str);
                tx.execute(
                    "INSERT INTO approvals (id, ask, correlation, conv, raised_ts, last_pulse)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                         ask = excluded.ask,
                         correlation = excluded.correlation,
                         conv = excluded.conv,
                         raised_ts = excluded.raised_ts,
                         last_pulse = max(approvals.last_pulse, excluded.last_pulse)",
                    rusqlite::params![
                        id.0,
                        serde_json::to_string(ask)?,
                        correlation
                            .as_ref()
                            .map(serde_json::to_string)
                            .transpose()?,
                        conv,
                        ts_ms,
                    ],
                )?;
            }
            ApprovalKind::Lifecycle(ApprovalLifecycle::Settled { ts, approved, by }) => {
                let ts_ms = parse_ts(ts)
                    .ok_or_else(|| anyhow::anyhow!("settled {id} has unparseable ts {ts}"))?;
                tx.execute(
                    "UPDATE approvals SET settled_approved = ?1, settled_by = ?2, settled_ts = ?3
                     WHERE id = ?4",
                    rusqlite::params![*approved as i64, serde_json::to_string(by)?, ts_ms, id.0],
                )?;
            }
            ApprovalKind::Heartbeat { ts } => {
                if let Some(ts_ms) = parse_ts(ts) {
                    tx.execute(
                        "UPDATE approvals SET last_pulse = max(last_pulse, ?1) WHERE id = ?2",
                        rusqlite::params![ts_ms, id.0],
                    )?;
                }
            }
            // Unknown approval traffic: represented at ingest, nothing to
            // fold; the cursor still advances.
            ApprovalKind::Unknown { .. } => {}
        }
        tx.execute(
            "INSERT INTO cursor (stream_name, seq) VALUES (?1, ?2)
             ON CONFLICT (stream_name) DO UPDATE SET seq = excluded.seq",
            rusqlite::params![stream_name, seq as i64],
        )?;
        tx.commit()?;

        if let Some(state) = self.get_approval(id)? {
            let _ = self.events.send(ViewEvent::Approval(state));
        }
        Ok(())
    }

    /// The agent fold (agent-spec, Telemetry): `ready`/`pulse` upsert the
    /// instance's one liveness fact; `attached` upserts, `detached` deletes —
    /// a released attachment is absence. Never touches `rows`: staleness is
    /// conversation activity, and these are facts about the instance.
    fn apply_agent(
        &mut self,
        stream_name: &str,
        seq: u64,
        event: &AgentEvent,
    ) -> anyhow::Result<()> {
        let world = &event.world;
        let tx = self.db.transaction()?;
        let fact = match &event.kind {
            AgentKind::Telemetry(AgentTelemetry::Ready(r)) => {
                let ts_ms = parse_ts(&r.ts)
                    .ok_or_else(|| anyhow::anyhow!("ready has unparseable ts {}", r.ts))?;
                tx.execute(
                    "INSERT INTO agent_instances (world, instance_id, host, last_pulse)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(world, instance_id) DO UPDATE SET
                         host       = excluded.host,
                         last_pulse = max(agent_instances.last_pulse, excluded.last_pulse)",
                    rusqlite::params![world.0, r.instance_id.0, r.host, ts_ms],
                )?;
                Some(AgentFact::Ready {
                    world: world.clone(),
                    instance: r.instance_id.clone(),
                    ts: ts_ms,
                    host: r.host.clone(),
                })
            }
            AgentKind::Telemetry(AgentTelemetry::Pulse(p)) => {
                let ts_ms = parse_ts(&p.ts)
                    .ok_or_else(|| anyhow::anyhow!("pulse has unparseable ts {}", p.ts))?;
                // A pulse for an instance never seen ready (pre-retention)
                // still creates it: the pulse is self-describing.
                tx.execute(
                    "INSERT INTO agent_instances (world, instance_id, last_pulse, interval_s)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(world, instance_id) DO UPDATE SET
                         last_pulse = max(agent_instances.last_pulse, excluded.last_pulse),
                         interval_s = excluded.interval_s",
                    rusqlite::params![world.0, p.instance_id.0, ts_ms, p.interval_s],
                )?;
                Some(AgentFact::Pulse {
                    world: world.clone(),
                    instance: p.instance_id.clone(),
                    ts: ts_ms,
                    interval_s: p.interval_s,
                })
            }
            AgentKind::Telemetry(AgentTelemetry::Attached(a)) => {
                let ts_ms = parse_ts(&a.ts)
                    .ok_or_else(|| anyhow::anyhow!("attached has unparseable ts {}", a.ts))?;
                // Re-attach (chdir's new cwd) is last-write-wins in place.
                tx.execute(
                    "INSERT OR REPLACE INTO agent_attachments
                         (world, instance_id, conv, cwd, attached_ts)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![world.0, a.instance_id.0, a.conversation_id.0, a.cwd, ts_ms],
                )?;
                // Attaching is itself evidence of life, and may carry the
                // liveness promise a `pulse` would otherwise be the only
                // source of (docs/spec/agent-spec.md: the gap where an
                // instance that dies before its first pulse read as alive
                // forever). COALESCE keeps a held interval when this fact
                // doesn't carry one, rather than clobbering it with NULL.
                tx.execute(
                    "INSERT INTO agent_instances (world, instance_id, last_pulse, interval_s)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(world, instance_id) DO UPDATE SET
                         last_pulse = max(agent_instances.last_pulse, excluded.last_pulse),
                         interval_s = COALESCE(excluded.interval_s, agent_instances.interval_s)",
                    rusqlite::params![world.0, a.instance_id.0, ts_ms, a.interval_s],
                )?;
                Some(AgentFact::Attached {
                    world: world.clone(),
                    instance: a.instance_id.clone(),
                    ts: ts_ms,
                    conv: a.conversation_id.clone(),
                    cwd: a.cwd.clone(),
                    interval_s: a.interval_s,
                })
            }
            AgentKind::Telemetry(AgentTelemetry::Detached(d)) => {
                let ts_ms = parse_ts(&d.ts)
                    .ok_or_else(|| anyhow::anyhow!("detached has unparseable ts {}", d.ts))?;
                tx.execute(
                    "DELETE FROM agent_attachments
                     WHERE world = ?1 AND instance_id = ?2 AND conv = ?3",
                    rusqlite::params![world.0, d.instance_id.0, d.conversation_id.0],
                )?;
                Some(AgentFact::Detached {
                    world: world.clone(),
                    instance: d.instance_id.clone(),
                    ts: ts_ms,
                    conv: d.conversation_id.clone(),
                })
            }
            // Unknown agent traffic: represented at ingest, nothing to fold;
            // the cursor still advances.
            AgentKind::Unknown { .. } => None,
        };
        tx.execute(
            "INSERT INTO cursor (stream_name, seq) VALUES (?1, ?2)
             ON CONFLICT (stream_name) DO UPDATE SET seq = excluded.seq",
            rusqlite::params![stream_name, seq as i64],
        )?;
        tx.commit()?;

        if let Some(fact) = fact {
            let _ = self.events.send(ViewEvent::Agent(fact));
        }
        Ok(())
    }

    fn apply_conv(&mut self, stream_name: &str, seq: u64, event: &Event) -> anyhow::Result<()> {
        let conv = &event.conv;

        // Deltas are ephemeral: never stored, no row touch (the wire's own
        // rule — the committed message is the record), just fanned out.
        if let EventKind::Delta(d) = &event.kind {
            let tx = self.db.transaction()?;
            tx.execute(
                "INSERT INTO cursor (stream_name, seq) VALUES (?1, ?2)
             ON CONFLICT (stream_name) DO UPDATE SET seq = excluded.seq",
                rusqlite::params![stream_name, seq as i64],
            )?;
            tx.commit()?;
            let _ = self.events.send(ViewEvent::Streaming {
                conv: conv.clone(),
                text: d.text.clone(),
            });
            // A delta is still activity: the row touches with kind "delta".
            // Timestamp: deltas carry no ts by design; the row keeps its
            // last committed time rather than inventing one.
            return Ok(());
        }

        // Block markers are stream punctuation, like deltas: never stored,
        // no row touch (no ts to honestly claim), fanned out for open
        // conversations' streaming displays.
        if let EventKind::Block(b) = &event.kind {
            let tx = self.db.transaction()?;
            tx.execute(
                "INSERT INTO cursor (stream_name, seq) VALUES (?1, ?2)
             ON CONFLICT (stream_name) DO UPDATE SET seq = excluded.seq",
                rusqlite::params![stream_name, seq as i64],
            )?;
            tx.commit()?;
            let _ = self.events.send(ViewEvent::StreamBlock {
                conv: conv.clone(),
                block_type: b.block_type.clone(),
            });
            return Ok(());
        }

        let (kind_label, ts) = match &event.kind {
            EventKind::Telemetry(t) => (t.type_name().to_string(), parse_ts(t.ts())),
            EventKind::Change(c) => (c.type_name().to_string(), parse_ts(c.ts())),
            EventKind::Unknown { label, ts } => (label.clone(), ts.as_deref().and_then(parse_ts)),
            EventKind::Delta(_) | EventKind::Block(_) => unreachable!("handled above"),
        };

        let mut stored_message: Option<ConversationMessage> = None;
        let mut minted_unread: Option<String> = None;
        let tx = self.db.transaction()?;

        // Staleness: every event with a readable ts touches the row — but the
        // guard (WHERE excluded.last_event >= rows.last_event) refuses a
        // regression. Capture whether the row actually moved, so the broadcast
        // below never announces a ts the db just refused, which would regress
        // every live client's row until reconnect.
        let touched_ts: Option<i64> = match ts {
            Some(ts) => {
                let changed = tx.execute(
                    "INSERT INTO rows (conv, last_event, last_kind) VALUES (?1, ?2, ?3)
                     ON CONFLICT(conv) DO UPDATE SET
                         last_event = excluded.last_event,
                         last_kind  = excluded.last_kind
                     WHERE excluded.last_event >= rows.last_event",
                    rusqlite::params![conv.0, ts, kind_label],
                )? > 0;
                changed.then_some(ts)
            }
            None => None,
        };

        if let EventKind::Change(change) = &event.kind {
            match change {
                ConvChange::Message(m) => {
                    let (ts, id, query_id, turn_id, role, from, content) = (
                        &m.ts,
                        &m.id,
                        &m.query_id,
                        &m.turn_id,
                        &m.role,
                        &m.from,
                        &m.content,
                    );
                    let ts_ms = parse_ts(ts)
                        .ok_or_else(|| anyhow::anyhow!("message {id} has unparseable ts {ts}"))?;
                    let mut content = content.clone();
                    store_refs(&tx, &mut content)?;
                    let sender = from.as_ref().map(serde_json::to_string).transpose()?;
                    tx.execute(
                        "INSERT OR REPLACE INTO messages
                             (conv, message_id, query_id, turn_id, role, sender, content, ts)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        rusqlite::params![
                            conv.0,
                            id.0,
                            query_id.0,
                            turn_id.0,
                            role,
                            sender,
                            serde_json::to_string(&content)?,
                            ts_ms,
                        ],
                    )?;
                    stored_message = Some(ConversationMessage {
                        id: id.clone(),
                        query: query_id.clone(),
                        turn: turn_id.clone(),
                        role: role.clone(),
                        from: from.clone(),
                        content,
                        ts: ts_ms,
                    });
                    // The qualifying event for the unread signal: an
                    // assistant turn landing is new content nobody's seen.
                    if role == "assistant" {
                        minted_unread = super::unread::note_turn_finished(&tx, conv)?;
                    }
                }
                ConvChange::Revision(r) => {
                    let (message_id, content) = (&r.message_id, &r.content);
                    // Last-write-wins per id: content changed under a stable
                    // id; position and ts stay. A revision for a message the
                    // views never saw (pre-retention) is a no-op.
                    let mut content = content.clone();
                    store_refs(&tx, &mut content)?;
                    tx.execute(
                        "UPDATE messages SET content = ?1 WHERE message_id = ?2 AND conv = ?3",
                        rusqlite::params![serde_json::to_string(&content)?, message_id.0, conv.0],
                    )?;
                }
                // The tip is the servicer's; v1 views render stored messages
                // by ts and don't fold reachability. The row touch above is
                // the tip movement's whole effect here.
                ConvChange::TipMoved(_) => {}
                // Query closure: nothing stored (towerd keeps no query
                // state); forwarded to sessions after the commit below.
                ConvChange::Query(_) => {}
            }
        }

        // Usage fold: each per-turn usage telemetry accumulates into the
        // conversation's running totals. The fold is additive, so it must be
        // applied exactly once — safe because the cursor advances past every
        // event and rematerialisation truncates this table before replay. The
        // totals are read back for the absolute snapshot the broadcast carries.
        //
        // A turn's usage arrives as two frames (a SDK producer quirk, not a
        // wire guarantee): a context frame (input + cache, the real point-in-
        // time snapshot) and an output-only frame that reports outputTokens
        // alone, with input/cache all zero. `context_tokens` is a snapshot,
        // never a running sum (docs/mvp/tower-ws-spec.md: "the latest turn's"),
        // so the output-only frame's zero must never overwrite the real value
        // — the same guard claude-sdk-cli's own StatusState.update() carries
        // locally ("the output frame would otherwise clobber it to zero").
        let mut usage_snapshot: Option<UsageState> = None;
        if let EventKind::Telemetry(ConvTelemetry::Usage(u)) = &event.kind {
            let context = u.input_tokens + u.cache_creation_tokens + u.cache_read_tokens;
            let context = if context > 0 { Some(context) } else { None };
            let cc5 = u.cache_creation_5m_tokens.unwrap_or(0);
            let cc1h = u.cache_creation_1h_tokens.unwrap_or(0);
            tx.execute(
                "INSERT INTO usage
                     (conv, input_tokens, cache_creation_tokens, cache_creation_5m_tokens,
                      cache_creation_1h_tokens, cache_read_tokens, output_tokens, turns,
                      context_tokens, model)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)
                 ON CONFLICT(conv) DO UPDATE SET
                     input_tokens = usage.input_tokens + excluded.input_tokens,
                     cache_creation_tokens =
                         usage.cache_creation_tokens + excluded.cache_creation_tokens,
                     cache_creation_5m_tokens =
                         usage.cache_creation_5m_tokens + excluded.cache_creation_5m_tokens,
                     cache_creation_1h_tokens =
                         usage.cache_creation_1h_tokens + excluded.cache_creation_1h_tokens,
                     cache_read_tokens = usage.cache_read_tokens + excluded.cache_read_tokens,
                     output_tokens = usage.output_tokens + excluded.output_tokens,
                     turns = usage.turns + 1,
                     context_tokens =
                         CASE WHEN excluded.context_tokens > 0
                              THEN excluded.context_tokens ELSE usage.context_tokens END,
                     model = excluded.model",
                rusqlite::params![
                    conv.0,
                    u.input_tokens,
                    u.cache_creation_tokens,
                    cc5,
                    cc1h,
                    u.cache_read_tokens,
                    u.output_tokens,
                    context.unwrap_or(0),
                    u.model,
                ],
            )?;
            usage_snapshot = Some(read_usage_row(&tx, conv)?);
        }

        tx.execute(
            "INSERT INTO cursor (stream_name, seq) VALUES (?1, ?2)
             ON CONFLICT (stream_name) DO UPDATE SET seq = excluded.seq",
            rusqlite::params![stream_name, seq as i64],
        )?;
        tx.commit()?;

        // Broadcast the row only if the db actually moved (touched_ts): an
        // out-of-order event is a no-op in the db, and must be one to clients
        // too, or they regress until reconnect.
        if let Some(ts) = touched_ts {
            let _ = self.events.send(ViewEvent::Row(RowChanged {
                conv: conv.clone(),
                last_event: ts,
                last_kind: kind_label,
            }));
        }
        if let Some(message) = stored_message {
            let _ = self.events.send(ViewEvent::Message {
                conv: conv.clone(),
                message,
            });
        }
        if let EventKind::Change(ConvChange::Query(q)) = &event.kind {
            let _ = self.events.send(ViewEvent::QueryClosed {
                conv: conv.clone(),
                query: q.query_id.clone(),
                reason: q.reason.clone(),
            });
        }
        if let Some(snapshot) = usage_snapshot {
            let _ = self.events.send(ViewEvent::Usage(snapshot));
        }
        // The mint itself is silent (no broadcast) — only the timer schedules
        // here, after the transaction that recorded it has committed.
        if let Some(read_id) = minted_unread {
            self.spawn_stale_timer(conv.clone(), read_id);
        }
        Ok(())
    }
}

/// Externalise into the open transaction. Content-addressed: an existing id
/// is left alone (`INSERT OR IGNORE`), which is also the dedupe.
fn store_refs(tx: &rusqlite::Transaction<'_>, content: &mut [Value]) -> anyhow::Result<()> {
    let mut failure: Option<rusqlite::Error> = None;
    externalise(content, &mut |blob: Blob| {
        if failure.is_none()
            && let Err(e) = tx.execute(
                "INSERT OR IGNORE INTO refs (id, hint, bytes) VALUES (?1, ?2, ?3)",
                rusqlite::params![blob.id, blob.hint, blob.bytes],
            )
        {
            failure = Some(e);
        }
    });
    match failure {
        Some(e) => Err(e.into()),
        None => Ok(()),
    }
}
