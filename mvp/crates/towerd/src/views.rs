//! `Views` — the only struct in towerd. Owns the rusqlite `Connection` on a
//! dedicated OS thread (sync sqlite on the tokio worker pool would delay
//! unrelated tasks); everything else reaches it through messages:
//!
//! - `(seq, Event)` in over an mpsc — the apply path. Event rows and the
//!   JetStream cursor commit in one transaction, so restart resumes exactly.
//! - `ViewEvent` out over a broadcast — sessions subscribe before they
//!   snapshot (duplicate-apply is harmless; a missed event is not).
//! - `ViewQuery` in over an mpsc, answered over oneshots — the read path.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot};

use wire::{
    AgentEvent, AgentKind, AgentTelemetry, ApprovalEvent, ApprovalId, ApprovalKind,
    ApprovalLifecycle, ConvChange, ConversationId, Event, EventKind, InstanceId, MessageId,
    QueryId, TurnId, WireEvent, WorldId, parse_ts,
};

use crate::refs::{Blob, externalise};

// ---------------------------------------------------------------------------
// Seam types (tower-v1-design.md, Seams)

#[derive(Debug, Clone)]
pub enum ViewEvent {
    Row(RowChanged),
    Message {
        conv: ConversationId,
        message: ConversationMessage,
    },
    Streaming {
        conv: ConversationId,
        text: String,
    },
    /// The in-flight stream changed character; the streaming chunks that
    /// follow are `block_type`. Ephemeral, like `Streaming`.
    StreamBlock {
        conv: ConversationId,
        block_type: String,
    },
    /// An approval's state changed — raised, pulsed, or settled. Awareness
    /// is unconditional, like `Row`.
    Approval(ApprovalState),
    /// One agent wire fact — one packet, however many conversations ride on
    /// it (a pulse never fans out per conversation). Awareness is
    /// unconditional, like `Row`.
    Agent(AgentFact),
    /// A query closed — the wire's committal closure, forwarded (not
    /// folded: towerd stores no query state; the client's knowledge is the
    /// client's). Gated by `open`, like `Message`.
    QueryClosed {
        conv: ConversationId,
        query: QueryId,
        reason: String,
    },
}

/// The agent concern's facts, verdict-free: alive/released/stranded is the
/// client's derivation from `last_pulse` against its own clock (the
/// approval-void pattern) — stored liveness would be false the moment it is
/// written.
#[derive(Debug, Clone)]
pub enum AgentFact {
    Ready {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        host: Option<String>,
    },
    Pulse {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        interval_s: i64,
    },
    Attached {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        conv: ConversationId,
        cwd: Option<String>,
    },
    Detached {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        conv: ConversationId,
    },
}

#[derive(Debug, Clone)]
pub struct AgentInstanceState {
    pub world: WorldId,
    pub instance: InstanceId,
    pub host: Option<String>,
    pub last_pulse: i64,
    /// The instance's own promise; `None` until its first pulse.
    pub interval_s: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct AgentAttachmentState {
    pub world: WorldId,
    pub instance: InstanceId,
    pub conv: ConversationId,
    pub cwd: Option<String>,
    pub attached_ts: i64,
}

/// `agents`'s answer: every retained instance and every live attachment.
pub type AgentsSnapshot = (Vec<AgentInstanceState>, Vec<AgentAttachmentState>);

#[derive(Debug, Clone)]
pub struct ApprovalState {
    pub id: ApprovalId,
    /// Verbatim from the wire; ask types are an open set.
    pub ask: Value,
    pub correlation: Option<Value>,
    pub raised_ts: i64,
    pub last_pulse: i64,
    pub settled: Option<SettledState>,
}

#[derive(Debug, Clone)]
pub struct SettledState {
    pub approved: bool,
    pub by: Value,
    pub ts: i64,
}

#[derive(Debug, Clone)]
pub struct RowChanged {
    pub conv: ConversationId,
    pub last_event: i64,
    pub last_kind: String,
}

#[derive(Debug, Clone)]
pub struct RowState {
    pub conv: ConversationId,
    pub last_event: i64,
    pub last_kind: String,
    /// Tower's own annotation (`titles` table) — never wire state.
    pub title: Option<String>,
    /// Tower's own annotations (`tags` table) — flat key:value, verbatim.
    pub tags: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ConversationMessage {
    pub id: MessageId,
    pub query: QueryId,
    pub turn: TurnId,
    pub role: String,
    pub from: Value,
    pub content: Vec<Value>,
    pub ts: i64,
}

/// `list`'s answer: the rows and the key→colour map (the shared colour
/// language), one round trip.
pub type ListSnapshot = (Vec<RowState>, Vec<(String, String)>);

pub enum ViewQuery {
    List {
        reply: oneshot::Sender<ListSnapshot>,
    },
    Conversation {
        conv: ConversationId,
        /// The client's high-water mark; `None` = from the start.
        after: Option<i64>,
        reply: oneshot::Sender<Vec<ConversationMessage>>,
    },
    Ref {
        id: String,
        reply: oneshot::Sender<Option<(String, Vec<u8>)>>,
    },
    /// Empty title clears the name. Last write wins.
    SetTitle {
        conv: ConversationId,
        title: String,
        reply: oneshot::Sender<()>,
    },
    /// Empty value clears the key. Last write wins. First use of a key
    /// assigns it a colour from the palette.
    SetTag {
        conv: ConversationId,
        key: String,
        value: String,
        reply: oneshot::Sender<()>,
    },
    /// The outstanding snapshot: every unsettled ask (void is the client's
    /// derivation from `last_pulse`; a dead holder's ask is information).
    Approvals {
        reply: oneshot::Sender<Vec<ApprovalState>>,
    },
    /// The servicing snapshot: facts only, never verdicts.
    Agents {
        reply: oneshot::Sender<AgentsSnapshot>,
    },
    /// Ingest's reconcile, on every consumer build: "the stream I found was
    /// created at `created` and its sequences end at `last_seq` — where do I
    /// resume?" The reply is the cursor to resume after (0 = replay from the
    /// start).
    SyncStream {
        created: String,
        last_seq: u64,
        reply: oneshot::Sender<u64>,
    },
}

/// What sessions hold: the read channel plus the event fan-out.
#[derive(Clone)]
pub struct ViewsHandle {
    pub queries: mpsc::Sender<ViewQuery>,
    pub events: broadcast::Sender<ViewEvent>,
}

// ---------------------------------------------------------------------------
// Schema

/// Numbered migrations over `user_version` (the CLI's migrate pattern).
/// Append-only: a shipped migration is never edited.
const MIGRATIONS: &[&str] = &[
    // 1 — the v1 schema (tower-v1-design.md, Views schema).
    "CREATE TABLE cursor (
         id  INTEGER PRIMARY KEY CHECK (id = 1),
         seq INTEGER NOT NULL
     );
     INSERT INTO cursor (id, seq) VALUES (1, 0);
     CREATE TABLE rows (
         conv       TEXT PRIMARY KEY,
         last_event INTEGER NOT NULL,
         last_kind  TEXT NOT NULL
     );
     CREATE TABLE messages (
         conv       TEXT NOT NULL,
         message_id TEXT NOT NULL,
         query_id   TEXT NOT NULL,
         turn_id    TEXT NOT NULL,
         role       TEXT NOT NULL,
         sender     TEXT NOT NULL,
         content    TEXT NOT NULL,
         ts         INTEGER NOT NULL,
         PRIMARY KEY (conv, message_id)
     );
     CREATE INDEX messages_by_conv_ts ON messages (conv, ts);
     CREATE TABLE refs (
         id    TEXT PRIMARY KEY,
         hint  TEXT NOT NULL,
         bytes BLOB NOT NULL
     );",
    // 2 — titles: tower's own annotation, keyed by conversation id. NOT a
    // materialised view: it is the one table rematerialisation must never
    // touch, because it derives from nothing — it is what the SC typed.
    "CREATE TABLE titles (
         conv  TEXT PRIMARY KEY,
         title TEXT NOT NULL
     );",
    // 3 — the capture stream's incarnation (its created time), recorded so a
    // recreated stream (sequences restart at 1) is detectable: the cursor is
    // only meaningful against the stream it was advanced by.
    "CREATE TABLE stream (
         id      INTEGER PRIMARY KEY CHECK (id = 1),
         created TEXT NOT NULL
     );",
    // 4 — approvals: the outstanding-set fold, derived from
    // approval.v1.*.{lifecycle,telemetry} (in the rematerialise truncation
    // set). `conv` is correlation.conversationId extracted for the rail's
    // row marker; ask/correlation/by stay verbatim JSON.
    "CREATE TABLE approvals (
         id               TEXT PRIMARY KEY,
         ask              TEXT NOT NULL,
         correlation      TEXT,
         conv             TEXT,
         raised_ts        INTEGER NOT NULL,
         last_pulse       INTEGER NOT NULL,
         settled_approved INTEGER,
         settled_by       TEXT,
         settled_ts       INTEGER
     );",
    // 5 — tags: tower's own annotations, flat key:value (one value per key
    // per conversation), plus the key's colour — the tag's identity IS the
    // key, so its colour is shared truth. NOT materialised views: never
    // touched by rematerialisation.
    "CREATE TABLE tags (
         conv  TEXT NOT NULL,
         key   TEXT NOT NULL,
         value TEXT NOT NULL,
         PRIMARY KEY (conv, key)
     );
     CREATE TABLE tag_keys (
         key    TEXT PRIMARY KEY,
         colour TEXT NOT NULL
     );",
    // 6 — agent liveness: two tables, never one (the pulse is one fact per
    // instance; per-conversation copies are the restatement agent-spec
    // forbids). Derived from agent.v1.*.telemetry.> — in the rematerialise
    // truncation set. No verdict column: alive/released/stranded is the
    // client's derivation.
    "CREATE TABLE agent_instances (
         world       TEXT NOT NULL,
         instance_id TEXT NOT NULL,
         host        TEXT,
         last_pulse  INTEGER NOT NULL,
         interval_s  INTEGER,
         PRIMARY KEY (world, instance_id)
     );
     CREATE TABLE agent_attachments (
         world       TEXT NOT NULL,
         instance_id TEXT NOT NULL,
         conv        TEXT NOT NULL,
         cwd         TEXT,
         attached_ts INTEGER NOT NULL,
         PRIMARY KEY (world, instance_id, conv)
     );",
];

pub fn apply_schema(db: &Connection) -> anyhow::Result<()> {
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, migration) in MIGRATIONS.iter().enumerate() {
        let target = (i + 1) as i64;
        if version < target {
            db.execute_batch(migration)?;
            db.pragma_update(None, "user_version", target)?;
        }
    }
    Ok(())
}

pub fn read_cursor(db: &Connection) -> anyhow::Result<u64> {
    Ok(
        db.query_row("SELECT seq FROM cursor WHERE id = 1", [], |r| {
            r.get::<_, i64>(0)
        })? as u64,
    )
}

// ---------------------------------------------------------------------------
// Views

pub struct Views {
    db: Connection,
    events: broadcast::Sender<ViewEvent>,
}

impl Views {
    pub fn new(db: Connection, events: broadcast::Sender<ViewEvent>) -> Self {
        Views { db, events }
    }

    /// The loop, on its own OS thread. Queries are checked first on purpose:
    /// reads are a trickle and latency-sensitive (a `list` at connect),
    /// applies are a flood and latency-tolerant — apply-first would starve
    /// the UI for the whole of a startup replay. Both channels closing ends
    /// the loop (shutdown = crash: transactions make them the same path).
    pub fn run_blocking(
        mut self,
        mut events_rx: mpsc::Receiver<(u64, WireEvent)>,
        mut queries_rx: mpsc::Receiver<ViewQuery>,
    ) {
        loop {
            // blocking_recv on two channels: poll whichever is ready by
            // draining queries opportunistically, then blocking on events.
            match queries_rx.try_recv() {
                Ok(q) => {
                    self.answer(q);
                    continue;
                }
                Err(mpsc::error::TryRecvError::Empty) => {}
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    // Reads gone; keep applying while ingest lives.
                    while let Some((seq, event)) = events_rx.blocking_recv() {
                        self.apply(seq, &event);
                    }
                    return;
                }
            }
            match events_rx.try_recv() {
                Ok((seq, event)) => {
                    self.apply(seq, &event);
                    continue;
                }
                Err(mpsc::error::TryRecvError::Empty) => {}
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    while let Some(q) = queries_rx.blocking_recv() {
                        self.answer(q);
                    }
                    return;
                }
            }
            // Both empty: park briefly rather than spin.
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    /// One event → one transaction (tables + cursor), then the broadcast.
    /// Publish after commit: subscribers read the db they can now see.
    pub fn apply(&mut self, seq: u64, event: &WireEvent) {
        let result = match event {
            WireEvent::Conv(e) => self.apply_conv(seq, e),
            WireEvent::Approval(e) => self.apply_approval(seq, e),
            WireEvent::Agent(e) => self.apply_agent(seq, e),
        };
        if let Err(e) = result {
            // A poisoned frame must not kill the fold; it is logged and the
            // cursor still advances past it (skipping forever beats halting).
            eprintln!("views: apply failed at seq {seq}: {e:#}");
            let _ = self
                .db
                .execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64]);
        }
    }

    /// The approval fold (approval-spec, The outstanding set): raised inserts
    /// the candidate, the pulse refreshes `last_pulse`, settled records the
    /// outcome. Idempotent under replay; a raised re-delivered after settled
    /// never erases the settlement (the settled columns are not in the
    /// upsert). A pulse or settlement for an id never raised (pre-retention)
    /// is skipped — an ask is unreviewable without its raise.
    fn apply_approval(&mut self, seq: u64, event: &ApprovalEvent) -> anyhow::Result<()> {
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
        tx.execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64])?;
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
    fn apply_agent(&mut self, seq: u64, event: &AgentEvent) -> anyhow::Result<()> {
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
                Some(AgentFact::Attached {
                    world: world.clone(),
                    instance: a.instance_id.clone(),
                    ts: ts_ms,
                    conv: a.conversation_id.clone(),
                    cwd: a.cwd.clone(),
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
        tx.execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64])?;
        tx.commit()?;

        if let Some(fact) = fact {
            let _ = self.events.send(ViewEvent::Agent(fact));
        }
        Ok(())
    }

    fn apply_conv(&mut self, seq: u64, event: &Event) -> anyhow::Result<()> {
        let conv = &event.conv;

        // Deltas are ephemeral: never stored, no row touch (the wire's own
        // rule — the committed message is the record), just fanned out.
        if let EventKind::Delta(d) = &event.kind {
            let tx = self.db.transaction()?;
            tx.execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64])?;
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
            tx.execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64])?;
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
                            serde_json::to_string(from)?,
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

        tx.execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64])?;
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
        Ok(())
    }

    fn answer(&mut self, query: ViewQuery) {
        match query {
            ViewQuery::List { reply } => {
                let _ = reply.send(self.list().unwrap_or_default());
            }
            ViewQuery::SetTag {
                conv,
                key,
                value,
                reply,
            } => {
                if let Err(e) = self.set_tag(&conv, &key, &value) {
                    eprintln!("views: set_tag failed for {conv}: {e:#}");
                }
                let _ = reply.send(());
            }
            ViewQuery::Conversation { conv, after, reply } => {
                let _ = reply.send(self.conversation(&conv, after).unwrap_or_default());
            }
            ViewQuery::Ref { id, reply } => {
                let _ = reply.send(self.get_ref(&id).ok().flatten());
            }
            ViewQuery::Approvals { reply } => {
                let _ = reply.send(self.approvals().unwrap_or_default());
            }
            ViewQuery::Agents { reply } => {
                let _ = reply.send(self.agents().unwrap_or_default());
            }
            ViewQuery::SetTitle { conv, title, reply } => {
                if let Err(e) = self.set_title(&conv, &title) {
                    eprintln!("views: set_title failed for {conv}: {e:#}");
                }
                let _ = reply.send(());
            }
            ViewQuery::SyncStream {
                created,
                last_seq,
                reply,
            } => {
                match self.sync_stream(&created, last_seq) {
                    Ok(cursor) => {
                        let _ = reply.send(cursor);
                    }
                    Err(e) => {
                        // No reply: ingest's await fails and it retries —
                        // never consume from a position we couldn't verify.
                        eprintln!("views: sync_stream failed: {e:#}");
                    }
                }
            }
        }
    }

    /// Reconcile the cursor against the stream incarnation ingest found.
    ///
    /// - Same `created` as stored → same stream; resume from the cursor.
    /// - Different → the stream was recreated: sequences restarted, so the
    ///   cursor is meaningless. Rematerialise — truncate the DERIVED tables
    ///   only (rows, messages, refs), cursor to 0 — and adopt the new
    ///   incarnation, all in one transaction. Annotations (titles) are not
    ///   derived and are not touched.
    /// - Nothing stored → first contact under this scheme (fresh db, or a db
    ///   from before migration 3): adopt the stream as-is, keep everything.
    ///   Adoption cannot destroy data by construction.
    ///
    /// Only a genuinely different stream reaches the destructive arm: blips,
    /// timeouts, and reconnects never change a stream's `created`, and a
    /// malformed message never reaches this code path at all.
    ///
    /// The `last_seq` guard: whatever arm answers, a cursor beyond the
    /// stream's last sequence is a position that can never be reached
    /// (sequences only grow) — consuming from it waits forever, silently.
    /// Answer 0 instead: replay, with no truncation — the fold is idempotent,
    /// so existing views keep what they hold and refill on top. This is the
    /// adopt arm's blind spot closed: adoption trusts that the stream it
    /// meets is the one that advanced the cursor, and the guard is the check
    /// that the trust is arithmetically possible.
    fn sync_stream(&mut self, created: &str, last_seq: u64) -> anyhow::Result<u64> {
        let stored: Option<String> = self
            .db
            .query_row("SELECT created FROM stream WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        let cursor = match stored {
            Some(s) if s == created => read_cursor(&self.db)?,
            Some(s) => {
                eprintln!(
                    "views: stream incarnation changed ({s} -> {created}); \
                     rematerialising the derived views (annotations untouched)"
                );
                let tx = self.db.transaction()?;
                tx.execute_batch(
                    "DELETE FROM rows; DELETE FROM messages; DELETE FROM refs;
                     DELETE FROM approvals;
                     DELETE FROM agent_instances; DELETE FROM agent_attachments;
                     UPDATE cursor SET seq = 0 WHERE id = 1;",
                )?;
                tx.execute("UPDATE stream SET created = ?1 WHERE id = 1", [created])?;
                tx.commit()?;
                0
            }
            None => {
                self.db
                    .execute("INSERT INTO stream (id, created) VALUES (1, ?1)", [created])?;
                read_cursor(&self.db)?
            }
        };
        if cursor > last_seq {
            eprintln!(
                "views: cursor {cursor} is beyond the stream's last sequence {last_seq} \
                 — an unreachable position; replaying from the start (no truncation)"
            );
            self.db
                .execute("UPDATE cursor SET seq = 0 WHERE id = 1", [])?;
            return Ok(0);
        }
        Ok(cursor)
    }

    /// The palette keys draw from at first use — readable on the dark UI.
    /// `set_key_colour` is a db edit in v1; this only seeds.
    const PALETTE: [&'static str; 10] = [
        "#8ec07c", "#83a598", "#d3869b", "#fabd2f", "#fe8019", "#b8bb26", "#7fc7ff", "#d65d0e",
        "#b16286", "#689d6a",
    ];

    fn set_tag(&mut self, conv: &ConversationId, key: &str, value: &str) -> anyhow::Result<()> {
        if value.is_empty() {
            self.db.execute(
                "DELETE FROM tags WHERE conv = ?1 AND key = ?2",
                rusqlite::params![conv.0, key],
            )?;
            return Ok(());
        }
        let tx = self.db.transaction()?;
        // First use of a key mints its colour — random pick, then stable.
        let n: i64 = tx.query_row("SELECT COUNT(*) FROM tag_keys", [], |r| r.get(0))?;
        let colour = Self::PALETTE[(n as usize) % Self::PALETTE.len()];
        tx.execute(
            "INSERT OR IGNORE INTO tag_keys (key, colour) VALUES (?1, ?2)",
            rusqlite::params![key, colour],
        )?;
        tx.execute(
            "INSERT INTO tags (conv, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(conv, key) DO UPDATE SET value = excluded.value",
            rusqlite::params![conv.0, key, value],
        )?;
        tx.commit()?;
        Ok(())
    }

    fn set_title(&self, conv: &ConversationId, title: &str) -> anyhow::Result<()> {
        if title.is_empty() {
            self.db
                .execute("DELETE FROM titles WHERE conv = ?1", [&conv.0])?;
        } else {
            self.db.execute(
                "INSERT INTO titles (conv, title) VALUES (?1, ?2)
                 ON CONFLICT(conv) DO UPDATE SET title = excluded.title",
                rusqlite::params![conv.0, title],
            )?;
        }
        Ok(())
    }

    fn list(&self) -> anyhow::Result<ListSnapshot> {
        let mut stmt = self.db.prepare_cached(
            "SELECT r.conv, r.last_event, r.last_kind, t.title
             FROM rows r LEFT JOIN titles t ON t.conv = r.conv",
        )?;
        let mut rows = stmt
            .query_map([], |r| {
                Ok(RowState {
                    conv: ConversationId(r.get(0)?),
                    last_event: r.get(1)?,
                    last_kind: r.get(2)?,
                    title: r.get(3)?,
                    tags: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut tag_stmt = self
            .db
            .prepare_cached("SELECT conv, key, value FROM tags")?;
        let mut by_conv: std::collections::HashMap<String, Vec<(String, String)>> =
            std::collections::HashMap::new();
        for row in tag_stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })? {
            let (conv, key, value) = row?;
            by_conv.entry(conv).or_default().push((key, value));
        }
        for r in &mut rows {
            if let Some(tags) = by_conv.remove(&r.conv.0) {
                r.tags = tags;
            }
        }

        let mut key_stmt = self.db.prepare_cached("SELECT key, colour FROM tag_keys")?;
        let keys = key_stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((rows, keys))
    }

    fn conversation(
        &self,
        conv: &ConversationId,
        after: Option<i64>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT message_id, query_id, turn_id, role, sender, content, ts
             FROM messages WHERE conv = ?1 AND ts >= ?2 ORDER BY ts",
        )?;
        // `after` None = from the start. The boundary is INCLUSIVE (`>=`): a
        // message sharing the client's high-water-mark ts is re-sent, and the
        // spec's answer is dedupe by id client-side, which absorbs that one
        // duplicate. `>` would instead silently lose a tied message on
        // reconnect (a sibling at the same ts the client never received).
        // i64::MIN stands in for "everything".
        let floor = after.unwrap_or(i64::MIN);
        let rows = stmt
            .query_map(rusqlite::params![conv.0, floor], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, query, turn, role, sender, content, ts)| {
                Ok(ConversationMessage {
                    id: MessageId(id),
                    query: QueryId(query),
                    turn: TurnId(turn),
                    role,
                    from: serde_json::from_str(&sender)?,
                    content: serde_json::from_str(&content)?,
                    ts,
                })
            })
            .collect()
    }

    /// The outstanding snapshot: unsettled only, oldest first.
    fn approvals(&self) -> anyhow::Result<Vec<ApprovalState>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT id, ask, correlation, raised_ts, last_pulse
             FROM approvals WHERE settled_approved IS NULL ORDER BY raised_ts",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(id, ask, correlation, raised_ts, last_pulse)| {
                Ok(ApprovalState {
                    id: ApprovalId(id),
                    ask: serde_json::from_str(&ask)?,
                    correlation: correlation
                        .as_deref()
                        .map(serde_json::from_str)
                        .transpose()?,
                    raised_ts,
                    last_pulse,
                    settled: None,
                })
            })
            .collect()
    }

    fn get_approval(&self, id: &ApprovalId) -> anyhow::Result<Option<ApprovalState>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT ask, correlation, raised_ts, last_pulse,
                    settled_approved, settled_by, settled_ts
             FROM approvals WHERE id = ?1",
        )?;
        let mut rows = stmt.query([&id.0])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let ask: String = row.get(0)?;
        let correlation: Option<String> = row.get(1)?;
        let settled_approved: Option<i64> = row.get(4)?;
        let settled = match settled_approved {
            Some(approved) => Some(SettledState {
                approved: approved != 0,
                by: serde_json::from_str(&row.get::<_, String>(5)?)?,
                ts: row.get(6)?,
            }),
            None => None,
        };
        Ok(Some(ApprovalState {
            id: id.clone(),
            ask: serde_json::from_str(&ask)?,
            correlation: correlation
                .as_deref()
                .map(serde_json::from_str)
                .transpose()?,
            raised_ts: row.get(2)?,
            last_pulse: row.get(3)?,
            settled,
        }))
    }

    fn agents(&self) -> anyhow::Result<AgentsSnapshot> {
        let mut stmt = self.db.prepare_cached(
            "SELECT world, instance_id, host, last_pulse, interval_s FROM agent_instances",
        )?;
        let instances = stmt
            .query_map([], |r| {
                Ok(AgentInstanceState {
                    world: WorldId(r.get(0)?),
                    instance: InstanceId(r.get(1)?),
                    host: r.get(2)?,
                    last_pulse: r.get(3)?,
                    interval_s: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = self.db.prepare_cached(
            "SELECT world, instance_id, conv, cwd, attached_ts FROM agent_attachments",
        )?;
        let attachments = stmt
            .query_map([], |r| {
                Ok(AgentAttachmentState {
                    world: WorldId(r.get(0)?),
                    instance: InstanceId(r.get(1)?),
                    conv: ConversationId(r.get(2)?),
                    cwd: r.get(3)?,
                    attached_ts: r.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((instances, attachments))
    }

    fn get_ref(&self, id: &str) -> anyhow::Result<Option<(String, Vec<u8>)>> {
        let mut stmt = self
            .db
            .prepare_cached("SELECT hint, bytes FROM refs WHERE id = ?1")?;
        let mut rows = stmt.query([id])?;
        match rows.next()? {
            Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
            None => Ok(None),
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use wire::parse_wire;

    fn fresh() -> (Views, broadcast::Receiver<ViewEvent>) {
        let db = Connection::open_in_memory().unwrap();
        apply_schema(&db).unwrap();
        let (tx, rx) = broadcast::channel(64);
        (Views::new(db, tx), rx)
    }

    fn event(subject: &str, payload: &str) -> WireEvent {
        parse_wire(subject, payload.as_bytes()).unwrap()
    }

    /// The rows half of list(); most tests don't care about tag keys.
    fn rows_of(views: &Views) -> Vec<RowState> {
        views.list().unwrap().0
    }

    const MSG_M1: &str = r#"{"ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}"#;

    #[test]
    fn message_lands_in_views_and_row() {
        let (mut views, mut rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));

        let rows = rows_of(&views);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].conv.0, "conv-abc");
        assert_eq!(rows[0].last_kind, "message");

        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id.0, "m1");
        assert_eq!(msgs[0].from["userId"], "stephen");

        assert!(matches!(rx.try_recv().unwrap(), ViewEvent::Row(_)));
        assert!(matches!(rx.try_recv().unwrap(), ViewEvent::Message { .. }));
        assert_eq!(read_cursor(&views.db).unwrap(), 1);
    }

    #[test]
    fn replay_is_idempotent() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1)); // at-least-once
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn revision_rewrites_content_in_place() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        views.apply(2, &event("conv.v2.conv-abc.changes.revision",
            r#"{"ts":"2026-07-07T21:01:00+10:00","messageId":"m1","content":[{"type":"text","text":"…trimmed…"}]}"#));
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content[0]["text"], "…trimmed…");
    }

    #[test]
    fn telemetry_touches_row_without_storing() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.telemetry.turn.started",
            r#"{"ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}"#));
        let rows = rows_of(&views);
        assert_eq!(rows[0].last_kind, "turn_started");
        assert!(
            views
                .conversation(&ConversationId("conv-abc".into()), None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn delta_streams_but_never_stores() {
        let (mut views, mut rx) = fresh();
        views.apply(
            1,
            &event(
                "conv.v2.conv-abc.deltas",
                r#"{"type":"delta","text":"File X"}"#,
            ),
        );
        assert!(rows_of(&views).is_empty());
        assert!(matches!(
            rx.try_recv().unwrap(),
            ViewEvent::Streaming { .. }
        ));
        assert_eq!(read_cursor(&views.db).unwrap(), 1);
    }

    #[test]
    fn after_filters_catch_up() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        views.apply(2, &event("conv.v2.conv-abc.changes.message",
            r#"{"ts":"2026-07-07T21:05:00+10:00","id":"m2","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"done"}]}"#));
        // The boundary is inclusive: a message tied with the client's
        // high-water mark is re-sent (client dedupes by id), so the catch-up
        // from m1's ts carries m1 again plus m2.
        let m1_ts = parse_ts("2026-07-07T21:00:00+10:00").unwrap();
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), Some(m1_ts))
            .unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id.0, "m1");
        assert_eq!(msgs[1].id.0, "m2");

        // Strictly past m1's ts, only m2 remains.
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), Some(m1_ts + 1))
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id.0, "m2");
    }

    #[test]
    fn heavy_tool_result_is_externalised_and_fetchable() {
        let (mut views, _rx) = fresh();
        let heavy = format!(
            r#"{{"ts":"2026-07-07T21:00:00+10:00","id":"m9","queryId":"q1","turnId":"t2","role":"user","from":{{"kind":"agent"}},"content":[{{"type":"tool_result","tool_use_id":"toolu_01","content":"{}"}}]}}"#,
            "y".repeat(1000)
        );
        views.apply(1, &event("conv.v2.conv-abc.changes.message", &heavy));
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap();
        let reference = &msgs[0].content[0]["content"];
        let id = reference["$ref"].as_str().unwrap();
        assert!(id.starts_with("sha256-"));
        let (hint, bytes) = views.get_ref(id).unwrap().unwrap();
        assert_eq!(hint, "tool_result");
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap(),
            Value::String("y".repeat(1000))
        );
    }

    #[test]
    fn unknown_event_with_ts_still_touches_staleness() {
        let (mut views, _rx) = fresh();
        views.apply(
            1,
            &event(
                "conv.v2.conv-abc.telemetry.vibe.shift",
                r#"{"ts":"2026-07-07T21:00:00+10:00"}"#,
            ),
        );
        let rows = rows_of(&views);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].last_kind, "vibe_shift");
    }

    #[test]
    fn titles_set_overwrite_clear_and_survive_rematerialisation() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        let conv = ConversationId("conv-abc".into());

        // Set, then overwrite (last write wins).
        views.set_title(&conv, "tower build").unwrap();
        views.set_title(&conv, "tower v1").unwrap();
        assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));

        // A title for a conversation the views have never seen is allowed;
        // the row is born titled when its first event arrives.
        views
            .set_title(&ConversationId("conv-new".into()), "early name")
            .unwrap();

        // Rematerialisation truncates the derived tables only — titles are
        // not a materialised view and must survive.
        views
            .db
            .execute_batch(
                "DELETE FROM rows; DELETE FROM messages; DELETE FROM refs;
             UPDATE cursor SET seq = 0 WHERE id = 1;",
            )
            .unwrap();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));

        // Empty title clears; the row falls back to untitled.
        views.set_title(&conv, "").unwrap();
        assert_eq!(rows_of(&views)[0].title, None);
    }

    #[test]
    fn sync_stream_adopts_resumes_and_rematerialises() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        views
            .set_title(&ConversationId("conv-abc".into()), "tower v1")
            .unwrap();

        // First contact (nothing stored): ADOPT — keep data, keep cursor.
        // This is also the upgrade path for a db from before migration 3.
        assert_eq!(views.sync_stream("incarnation-A", 100).unwrap(), 1);
        assert_eq!(rows_of(&views).len(), 1);

        // Same incarnation again (every consumer rebuild): resume, touch nothing.
        views.apply(2, &event("conv.v2.conv-abc.telemetry.turn.started",
            r#"{"ts":"2026-07-07T21:01:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}"#));
        assert_eq!(views.sync_stream("incarnation-A", 100).unwrap(), 2);
        assert_eq!(rows_of(&views).len(), 1);

        // A DIFFERENT incarnation: the stream was recreated — rematerialise.
        // Derived tables empty, cursor 0; the title (annotation) survives.
        assert_eq!(views.sync_stream("incarnation-B", 100).unwrap(), 0);
        assert!(rows_of(&views).is_empty());
        assert!(
            views
                .conversation(&ConversationId("conv-abc".into()), None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(read_cursor(&views.db).unwrap(), 0);

        // Replay refills the views; the row comes back already titled.
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));

        // And incarnation-B is now home: same again resumes normally.
        assert_eq!(views.sync_stream("incarnation-B", 100).unwrap(), 1);
    }

    #[test]
    fn sync_stream_guard_replays_when_cursor_is_beyond_last_seq() {
        // Tonight's live strand: adopt a stream whose sequences end BELOW
        // the cursor — an unreachable position. The guard answers 0 (replay)
        // and, unlike rematerialisation, truncates nothing: the views keep
        // what they hold and the idempotent fold refills on top.
        let (mut views, _rx) = fresh();
        views.apply(23386, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        views
            .set_title(&ConversationId("conv-abc".into()), "tower v1")
            .unwrap();

        // Adopt arm meets a 628-message stream holding cursor 23386.
        assert_eq!(views.sync_stream("incarnation-A", 628).unwrap(), 0);
        // Views intact — no truncation on the guard path; cursor reset.
        assert_eq!(rows_of(&views).len(), 1);
        assert_eq!(rows_of(&views)[0].title.as_deref(), Some("tower v1"));
        assert_eq!(read_cursor(&views.db).unwrap(), 0);

        // Same-incarnation arm gets the same protection.
        views.apply(23386, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        assert_eq!(views.sync_stream("incarnation-A", 628).unwrap(), 0);
    }

    #[test]
    fn approval_fold_raised_pulsed_settled() {
        let (mut views, mut rx) = fresh();

        // Scenario 6a: raised → pending in the snapshot, with its ask verbatim.
        views.apply(1, &event("approval.v1.apr-1.lifecycle",
            r#"{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./old.ts"]}}},"correlation":{"conversationId":"conv-abc","queryId":"q2","turnId":"t3","toolUseId":"toolu_02DEF"}}"#));
        let pending = views.approvals().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id.0, "apr-1");
        assert_eq!(pending[0].ask["name"], "DeleteFile");
        assert_eq!(
            pending[0].correlation.as_ref().unwrap()["conversationId"],
            "conv-abc"
        );
        assert!(matches!(rx.try_recv().unwrap(), ViewEvent::Approval(_)));

        // The pulse refreshes last_pulse, monotonically.
        views.apply(
            2,
            &event(
                "approval.v1.apr-1.telemetry",
                r#"{"type":"heartbeat","ts":"2026-07-07T21:00:15+10:00"}"#,
            ),
        );
        let pending = views.approvals().unwrap();
        assert!(pending[0].last_pulse > pending[0].raised_ts);

        // Settled: out of the pending snapshot; the broadcast carries whose
        // decision it was.
        views.apply(3, &event("approval.v1.apr-1.lifecycle",
            r#"{"type":"settled","ts":"2026-07-07T21:00:30+10:00","approved":true,"by":{"kind":"human","userId":"stephen"}}"#));
        assert!(views.approvals().unwrap().is_empty());
        let _ = rx.try_recv(); // the pulse's event
        let ViewEvent::Approval(state) = rx.try_recv().unwrap() else {
            panic!("expected an approval event");
        };
        let settled = state.settled.unwrap();
        assert!(settled.approved);
        assert_eq!(settled.by["userId"], "stephen");

        // Replay of the raised after settlement never erases the settlement.
        views.apply(1, &event("approval.v1.apr-1.lifecycle",
            r#"{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./old.ts"]}}},"correlation":{"conversationId":"conv-abc"}}"#));
        assert!(views.approvals().unwrap().is_empty());

        // A pulse for an id never raised is skipped, not invented.
        views.apply(
            4,
            &event(
                "approval.v1.apr-unknown.telemetry",
                r#"{"type":"heartbeat","ts":"2026-07-07T21:00:00+10:00"}"#,
            ),
        );
        assert!(views.approvals().unwrap().is_empty());
        assert_eq!(read_cursor(&views.db).unwrap(), 4);
    }

    #[test]
    fn tags_set_overwrite_clear_and_colour_keys() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        let conv = ConversationId("conv-abc".into());

        // Set two keys; first use mints each key's colour.
        views.set_tag(&conv, "mission", "tower-design").unwrap();
        views.set_tag(&conv, "role", "pm").unwrap();
        let (rows, keys) = views.list().unwrap();
        assert_eq!(rows[0].tags.len(), 2);
        assert!(
            rows[0]
                .tags
                .contains(&("mission".into(), "tower-design".into()))
        );
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|(_, c)| c.starts_with('#')));

        // Overwrite (last write wins) keeps one value per key; the key's
        // colour is stable across overwrites.
        let mission_colour = keys.iter().find(|(k, _)| k == "mission").unwrap().1.clone();
        views.set_tag(&conv, "mission", "tower-v2").unwrap();
        let (rows, keys) = views.list().unwrap();
        assert!(
            rows[0]
                .tags
                .contains(&("mission".into(), "tower-v2".into()))
        );
        assert_eq!(
            keys.iter().find(|(k, _)| k == "mission").unwrap().1,
            mission_colour
        );

        // Empty value clears the key from the conversation; the key's colour
        // survives (other conversations may still wear it).
        views.set_tag(&conv, "mission", "").unwrap();
        let (rows, keys) = views.list().unwrap();
        assert_eq!(rows[0].tags.len(), 1);
        assert_eq!(keys.len(), 2);

        // Tags survive rematerialisation — annotations, not derived views.
        views
            .db
            .execute_batch(
                "DELETE FROM rows; DELETE FROM messages; DELETE FROM refs;
                 UPDATE cursor SET seq = 0 WHERE id = 1;",
            )
            .unwrap();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1));
        assert_eq!(rows_of(&views)[0].tags.len(), 1);
    }

    #[test]
    fn agent_fold_ready_pulse_attach_detach() {
        let (mut views, mut rx) = fresh();

        // Scenario a1: ready seeds the instance, the pulse declares the
        // promise, attached makes the conversation exist for observers.
        views.apply(
            1,
            &event(
                "agent.v1.mac.telemetry.ready",
                r#"{"ts":"2026-07-07T21:00:00+10:00","instanceId":"inst-1a2f","host":"mac"}"#,
            ),
        );
        views.apply(
            2,
            &event(
                "agent.v1.mac.telemetry.pulse",
                r#"{"ts":"2026-07-07T21:00:30+10:00","instanceId":"inst-1a2f","intervalS":30}"#,
            ),
        );
        views.apply(3, &event("agent.v1.mac.telemetry.attached",
            r#"{"ts":"2026-07-07T21:00:30+10:00","instanceId":"inst-1a2f","conversationId":"conv-abc","cwd":"~/repos/tower"}"#));

        let (instances, attachments) = views.agents().unwrap();
        assert_eq!(instances.len(), 1);
        assert_eq!(instances[0].instance.0, "inst-1a2f");
        assert_eq!(instances[0].host.as_deref(), Some("mac"));
        assert_eq!(instances[0].interval_s, Some(30));
        assert!(instances[0].last_pulse > 0);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].conv.0, "conv-abc");
        assert_eq!(attachments[0].cwd.as_deref(), Some("~/repos/tower"));

        // Agent facts never touch rows: no conversation activity happened.
        assert!(rows_of(&views).is_empty());
        assert!(matches!(
            rx.try_recv().unwrap(),
            ViewEvent::Agent(AgentFact::Ready { .. })
        ));
        assert!(matches!(
            rx.try_recv().unwrap(),
            ViewEvent::Agent(AgentFact::Pulse { .. })
        ));
        assert!(matches!(
            rx.try_recv().unwrap(),
            ViewEvent::Agent(AgentFact::Attached { .. })
        ));

        // An out-of-order pulse never regresses the liveness fact.
        let fresh_pulse = instances[0].last_pulse;
        views.apply(
            4,
            &event(
                "agent.v1.mac.telemetry.pulse",
                r#"{"ts":"2026-07-07T20:59:00+10:00","instanceId":"inst-1a2f","intervalS":30}"#,
            ),
        );
        let (instances, _) = views.agents().unwrap();
        assert_eq!(instances[0].last_pulse, fresh_pulse);

        // Scenario a2: detached deletes — a released attachment is absence.
        views.apply(5, &event("agent.v1.mac.telemetry.detached",
            r#"{"ts":"2026-07-07T21:01:00+10:00","instanceId":"inst-1a2f","conversationId":"conv-abc"}"#));
        let (instances, attachments) = views.agents().unwrap();
        assert_eq!(instances.len(), 1); // the instance fact survives
        assert!(attachments.is_empty());
        assert_eq!(read_cursor(&views.db).unwrap(), 5);
    }

    #[test]
    fn agent_tables_are_derived_and_rematerialise() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("agent.v1.mac.telemetry.attached",
            r#"{"ts":"2026-07-07T21:00:00+10:00","instanceId":"inst-1a2f","conversationId":"conv-abc","cwd":"~/repos/tower"}"#));
        assert_eq!(views.sync_stream("incarnation-A", 100).unwrap(), 1);

        // A recreated stream truncates the agent tables with the other
        // derived views — fully rebuildable from replay.
        assert_eq!(views.sync_stream("incarnation-B", 100).unwrap(), 0);
        let (instances, attachments) = views.agents().unwrap();
        assert!(instances.is_empty());
        assert!(attachments.is_empty());
    }

    #[test]
    fn out_of_order_row_touch_never_regresses() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v2.conv-abc.changes.message", MSG_M1)); // 21:00
        views.apply(
            2,
            &event(
                "conv.v2.conv-abc.telemetry.turn.cancelled",
                r#"{"ts":"2026-07-07T20:00:00+10:00","queryId":"q0","turnId":"t0"}"#,
            ),
        );
        let rows = rows_of(&views);
        assert_eq!(rows[0].last_kind, "message"); // the earlier ts did not win
    }
}
