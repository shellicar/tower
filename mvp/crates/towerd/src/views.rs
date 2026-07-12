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

use wire::{ConvChange, ConversationId, Event, EventKind, MessageId, QueryId, TurnId, parse_ts};

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

pub enum ViewQuery {
    List {
        reply: oneshot::Sender<Vec<RowState>>,
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
    /// Ingest's reconcile, on every consumer build: "the stream I found was
    /// created at `created` — where do I resume?" The reply is the cursor to
    /// resume after (0 = replay from the start).
    SyncStream {
        created: String,
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
        mut events_rx: mpsc::Receiver<(u64, Event)>,
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

    /// One event → one transaction (rows + messages + refs + cursor), then
    /// the broadcast. Publish after commit: subscribers read the db they can
    /// now see.
    pub fn apply(&mut self, seq: u64, event: &Event) {
        if let Err(e) = self.apply_inner(seq, event) {
            // A poisoned frame must not kill the fold; it is logged and the
            // cursor still advances past it (skipping forever beats halting).
            eprintln!("views: apply failed at seq {seq}: {e:#}");
            let _ = self
                .db
                .execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64]);
        }
    }

    fn apply_inner(&mut self, seq: u64, event: &Event) -> anyhow::Result<()> {
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

        let (kind_label, ts) = match &event.kind {
            EventKind::Telemetry(t) => (t.type_name().to_string(), parse_ts(t.ts())),
            EventKind::Change(c) => (c.type_name().to_string(), parse_ts(c.ts())),
            EventKind::Unknown { label, ts } => (label.clone(), ts.as_deref().and_then(parse_ts)),
            EventKind::Delta(_) => unreachable!("handled above"),
        };

        let mut stored_message: Option<ConversationMessage> = None;
        let tx = self.db.transaction()?;

        // Staleness: every event with a readable ts touches the row.
        if let Some(ts) = ts {
            tx.execute(
                "INSERT INTO rows (conv, last_event, last_kind) VALUES (?1, ?2, ?3)
                 ON CONFLICT(conv) DO UPDATE SET
                     last_event = excluded.last_event,
                     last_kind  = excluded.last_kind
                 WHERE excluded.last_event >= rows.last_event",
                rusqlite::params![conv.0, ts, kind_label],
            )?;
        }

        if let EventKind::Change(change) = &event.kind {
            match change {
                ConvChange::Message {
                    ts,
                    id,
                    query_id,
                    turn_id,
                    role,
                    from,
                    content,
                } => {
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
                ConvChange::Revision {
                    message_id,
                    content,
                    ..
                } => {
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
                ConvChange::TipMoved { .. } => {}
            }
        }

        tx.execute("UPDATE cursor SET seq = ?1 WHERE id = 1", [seq as i64])?;
        tx.commit()?;

        if let Some(ts) = ts {
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
        Ok(())
    }

    fn answer(&mut self, query: ViewQuery) {
        match query {
            ViewQuery::List { reply } => {
                let _ = reply.send(self.list().unwrap_or_default());
            }
            ViewQuery::Conversation { conv, after, reply } => {
                let _ = reply.send(self.conversation(&conv, after).unwrap_or_default());
            }
            ViewQuery::Ref { id, reply } => {
                let _ = reply.send(self.get_ref(&id).ok().flatten());
            }
            ViewQuery::SetTitle { conv, title, reply } => {
                if let Err(e) = self.set_title(&conv, &title) {
                    eprintln!("views: set_title failed for {conv}: {e:#}");
                }
                let _ = reply.send(());
            }
            ViewQuery::SyncStream { created, reply } => {
                match self.sync_stream(&created) {
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
    fn sync_stream(&mut self, created: &str) -> anyhow::Result<u64> {
        let stored: Option<String> = self
            .db
            .query_row("SELECT created FROM stream WHERE id = 1", [], |r| r.get(0))
            .optional()?;
        match stored {
            Some(s) if s == created => read_cursor(&self.db),
            Some(s) => {
                eprintln!(
                    "views: stream incarnation changed ({s} -> {created}); \
                     rematerialising the derived views (annotations untouched)"
                );
                let tx = self.db.transaction()?;
                tx.execute_batch(
                    "DELETE FROM rows; DELETE FROM messages; DELETE FROM refs;
                     UPDATE cursor SET seq = 0 WHERE id = 1;",
                )?;
                tx.execute("UPDATE stream SET created = ?1 WHERE id = 1", [created])?;
                tx.commit()?;
                Ok(0)
            }
            None => {
                self.db
                    .execute("INSERT INTO stream (id, created) VALUES (1, ?1)", [created])?;
                read_cursor(&self.db)
            }
        }
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

    fn list(&self) -> anyhow::Result<Vec<RowState>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT r.conv, r.last_event, r.last_kind, t.title
             FROM rows r LEFT JOIN titles t ON t.conv = r.conv",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RowState {
                    conv: ConversationId(r.get(0)?),
                    last_event: r.get(1)?,
                    last_kind: r.get(2)?,
                    title: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn conversation(
        &self,
        conv: &ConversationId,
        after: Option<i64>,
    ) -> anyhow::Result<Vec<ConversationMessage>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT message_id, query_id, turn_id, role, sender, content, ts
             FROM messages WHERE conv = ?1 AND ts > ?2 ORDER BY ts",
        )?;
        // `after` None = from the start; the boundary is exclusive of the
        // client's high-water mark, so a shared timestamp may overlap — the
        // spec's answer is dedupe by id client-side, and > here keeps the
        // overlap to exact ties only. i64::MIN stands in for "everything".
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

    fn event(subject: &str, payload: &str) -> Event {
        parse_wire(subject, payload.as_bytes()).unwrap()
    }

    const MSG_M1: &str = r#"{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}"#;

    #[test]
    fn message_lands_in_views_and_row() {
        let (mut views, mut rx) = fresh();
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));

        let rows = views.list().unwrap();
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
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1)); // at-least-once
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap();
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn revision_rewrites_content_in_place() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));
        views.apply(2, &event("conv.v1.conv-abc.changes",
            r#"{"type":"revision","ts":"2026-07-07T21:01:00+10:00","messageId":"m1","content":[{"type":"text","text":"…trimmed…"}]}"#));
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), None)
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content[0]["text"], "…trimmed…");
    }

    #[test]
    fn telemetry_touches_row_without_storing() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v1.conv-abc.telemetry",
            r#"{"type":"turn_started","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}"#));
        let rows = views.list().unwrap();
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
                "conv.v1.conv-abc.deltas",
                r#"{"type":"delta","text":"File X"}"#,
            ),
        );
        assert!(views.list().unwrap().is_empty());
        assert!(matches!(
            rx.try_recv().unwrap(),
            ViewEvent::Streaming { .. }
        ));
        assert_eq!(read_cursor(&views.db).unwrap(), 1);
    }

    #[test]
    fn after_filters_catch_up() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));
        views.apply(2, &event("conv.v1.conv-abc.changes",
            r#"{"type":"message","ts":"2026-07-07T21:05:00+10:00","id":"m2","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"done"}]}"#));
        let m1_ts = parse_ts("2026-07-07T21:00:00+10:00").unwrap();
        let msgs = views
            .conversation(&ConversationId("conv-abc".into()), Some(m1_ts))
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id.0, "m2");
    }

    #[test]
    fn heavy_tool_result_is_externalised_and_fetchable() {
        let (mut views, _rx) = fresh();
        let heavy = format!(
            r#"{{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m9","queryId":"q1","turnId":"t2","role":"user","from":{{"kind":"agent"}},"content":[{{"type":"tool_result","tool_use_id":"toolu_01","content":"{}"}}]}}"#,
            "y".repeat(1000)
        );
        views.apply(1, &event("conv.v1.conv-abc.changes", &heavy));
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
                "conv.v1.conv-abc.telemetry",
                r#"{"type":"vibe_shift","ts":"2026-07-07T21:00:00+10:00"}"#,
            ),
        );
        let rows = views.list().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].last_kind, "vibe_shift");
    }

    #[test]
    fn titles_set_overwrite_clear_and_survive_rematerialisation() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));
        let conv = ConversationId("conv-abc".into());

        // Set, then overwrite (last write wins).
        views.set_title(&conv, "tower build").unwrap();
        views.set_title(&conv, "tower v1").unwrap();
        assert_eq!(views.list().unwrap()[0].title.as_deref(), Some("tower v1"));

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
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));
        assert_eq!(views.list().unwrap()[0].title.as_deref(), Some("tower v1"));

        // Empty title clears; the row falls back to untitled.
        views.set_title(&conv, "").unwrap();
        assert_eq!(views.list().unwrap()[0].title, None);
    }

    #[test]
    fn sync_stream_adopts_resumes_and_rematerialises() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));
        views
            .set_title(&ConversationId("conv-abc".into()), "tower v1")
            .unwrap();

        // First contact (nothing stored): ADOPT — keep data, keep cursor.
        // This is also the upgrade path for a db from before migration 3.
        assert_eq!(views.sync_stream("incarnation-A").unwrap(), 1);
        assert_eq!(views.list().unwrap().len(), 1);

        // Same incarnation again (every consumer rebuild): resume, touch nothing.
        views.apply(2, &event("conv.v1.conv-abc.telemetry",
            r#"{"type":"turn_started","ts":"2026-07-07T21:01:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}"#));
        assert_eq!(views.sync_stream("incarnation-A").unwrap(), 2);
        assert_eq!(views.list().unwrap().len(), 1);

        // A DIFFERENT incarnation: the stream was recreated — rematerialise.
        // Derived tables empty, cursor 0; the title (annotation) survives.
        assert_eq!(views.sync_stream("incarnation-B").unwrap(), 0);
        assert!(views.list().unwrap().is_empty());
        assert!(
            views
                .conversation(&ConversationId("conv-abc".into()), None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(read_cursor(&views.db).unwrap(), 0);

        // Replay refills the views; the row comes back already titled.
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1));
        assert_eq!(views.list().unwrap()[0].title.as_deref(), Some("tower v1"));

        // And incarnation-B is now home: same again resumes normally.
        assert_eq!(views.sync_stream("incarnation-B").unwrap(), 1);
    }

    #[test]
    fn out_of_order_row_touch_never_regresses() {
        let (mut views, _rx) = fresh();
        views.apply(1, &event("conv.v1.conv-abc.changes", MSG_M1)); // 21:00
        views.apply(2, &event("conv.v1.conv-abc.telemetry",
            r#"{"type":"turn_cancelled","ts":"2026-07-07T20:00:00+10:00","queryId":"q0","turnId":"t0"}"#));
        let rows = views.list().unwrap();
        assert_eq!(rows[0].last_kind, "message"); // the earlier ts did not win
    }
}
