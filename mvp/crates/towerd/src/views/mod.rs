//! `Views` — the only struct in towerd. Owns the rusqlite `Connection` on a
//! dedicated OS thread (sync sqlite on the tokio worker pool would delay
//! unrelated tasks); everything else reaches it through messages:
//!
//! - `(seq, Event)` in over an mpsc — the apply path. Event rows and the
//!   JetStream cursor commit in one transaction, so restart resumes exactly.
//! - `ViewEvent` out over a broadcast — sessions subscribe before they
//!   snapshot (duplicate-apply is harmless; a missed event is not).
//! - `ViewQuery` in over an mpsc, answered over oneshots — the read path.
//!
//! Split by concern across submodules, same struct throughout (Rust lets an
//! `impl` span files in one module): `schema` (migrations + cursor/usage
//! reads), `fold` (the wire → sqlite → broadcast apply path), `query`
//! (read-only answers), `mutate` (annotation/layout writes). `types` holds
//! the seam shapes (`ViewEvent`/`ViewQuery`/the read-model state structs).

use serde_json::json;
use tokio::sync::mpsc;

use wire::WireEvent;

mod fold;
mod mutate;
mod query;
mod schema;
#[cfg(test)]
mod tests;
mod types;
mod unread;

pub use schema::{apply_schema, read_cursor};
pub use types::*;

// ---------------------------------------------------------------------------
// Views

pub struct Views {
    db: rusqlite::Connection,
    events: tokio::sync::broadcast::Sender<ViewEvent>,
    /// A sender back into `Views`' own query queue — the unread-episode
    /// timer (`unread.rs`) fires into it, so the transition is serialised
    /// through the same thread that touches sqlite, same as everything else.
    self_queries: mpsc::Sender<ViewQuery>,
    /// A handle to the tokio runtime, so `Views` (on its own blocking OS
    /// thread) can schedule the unread-episode timer as a real task — not a
    /// polling sweep — without itself being async.
    runtime: tokio::runtime::Handle,
}

impl Views {
    pub fn new(
        db: rusqlite::Connection,
        events: tokio::sync::broadcast::Sender<ViewEvent>,
        self_queries: mpsc::Sender<ViewQuery>,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        Views {
            db,
            events,
            self_queries,
            runtime,
        }
    }

    /// The loop, on its own OS thread. Queries are checked first on purpose:
    /// reads are a trickle and latency-sensitive (a `list` at connect),
    /// applies are a flood and latency-tolerant — apply-first would starve
    /// the UI for the whole of a startup replay. Both channels closing ends
    /// the loop (shutdown = crash: transactions make them the same path).
    pub fn run_blocking(
        mut self,
        mut events_rx: mpsc::Receiver<(String, u64, WireEvent)>,
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
                    while let Some((stream_name, seq, event)) = events_rx.blocking_recv() {
                        self.apply(&stream_name, seq, &event);
                    }
                    return;
                }
            }
            match events_rx.try_recv() {
                Ok((stream_name, seq, event)) => {
                    self.apply(&stream_name, seq, &event);
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
            ViewQuery::Usage { conv, reply } => {
                let _ = reply.send(self.usage(&conv).unwrap_or_default());
            }
            ViewQuery::Ref { id, reply } => {
                let _ = reply.send(self.get_ref(&id).ok().flatten());
            }
            ViewQuery::Stats { reply } => {
                let _ = reply.send(
                    self.stats()
                        .unwrap_or_else(|e| json!({ "error": e.to_string() })),
                );
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
                stream,
                created,
                last_seq,
                reply,
            } => {
                match self.sync_stream(&stream, &created, last_seq) {
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
            ViewQuery::Layout { reply } => {
                let _ = reply.send(self.layout().ok().flatten());
            }
            ViewQuery::SetLayout { tabs, reply } => {
                if let Err(e) = self.set_layout(&tabs) {
                    eprintln!("views: set_layout failed: {e:#}");
                } else {
                    let _ = self.events.send(ViewEvent::Layout(tabs));
                }
                let _ = reply.send(());
            }
            ViewQuery::DismissApproval { id, now, reply } => {
                if let Err(e) = self.dismiss_approval(&id, now) {
                    eprintln!("views: dismiss_approval failed for {id}: {e:#}");
                }
                let _ = reply.send(());
            }
            ViewQuery::DismissAttachment {
                world,
                instance,
                conv,
                now,
                reply,
            } => {
                if let Err(e) = self.dismiss_attachment(&world, &instance, &conv, now) {
                    eprintln!(
                        "views: dismiss_attachment failed for {world}/{instance}/{conv}: {e:#}"
                    );
                } else {
                    let _ = self.events.send(ViewEvent::AttachmentDismissed {
                        world,
                        instance,
                        conv,
                    });
                }
                let _ = reply.send(());
            }
            ViewQuery::StaleConversations { reply } => {
                let _ = reply.send(self.stale_conversations().unwrap_or_default());
            }
            ViewQuery::AckUnread { conv } => {
                self.ack_unread(&conv);
            }
            ViewQuery::StaleTimerFired { conv, read_id } => {
                self.on_stale_timer(&conv, &read_id);
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
    fn sync_stream(
        &mut self,
        stream_name: &str,
        created: &str,
        last_seq: u64,
    ) -> anyhow::Result<u64> {
        use rusqlite::OptionalExtension;
        let stored: Option<String> = self
            .db
            .query_row(
                "SELECT created FROM stream WHERE stream_name = ?1",
                [stream_name],
                |r| r.get(0),
            )
            .optional()?;
        let cursor = match stored {
            Some(s) if s == created => read_cursor(&self.db, stream_name)?,
            Some(s) => {
                eprintln!(
                    "views: stream {stream_name} incarnation changed ({s} -> {created}); \
                     rematerialising the derived views (annotations untouched)"
                );
                let tx = self.db.transaction()?;
                tx.execute_batch(
                    "DELETE FROM rows; DELETE FROM messages; DELETE FROM refs;
                     DELETE FROM approvals; DELETE FROM usage;
                     DELETE FROM agent_instances; DELETE FROM agent_attachments;",
                )?;
                // Every stream's cursor resets, not just this one: the
                // derived tables just wiped are the union of all three
                // streams' events, so all three must replay from scratch to
                // refill them — only THIS stream's own incarnation record
                // actually changed.
                tx.execute("UPDATE cursor SET seq = 0", [])?;
                tx.execute(
                    "INSERT INTO stream (stream_name, created) VALUES (?1, ?2)
                     ON CONFLICT (stream_name) DO UPDATE SET created = excluded.created",
                    rusqlite::params![stream_name, created],
                )?;
                tx.commit()?;
                0
            }
            None => {
                self.db.execute(
                    "INSERT INTO stream (stream_name, created) VALUES (?1, ?2)",
                    rusqlite::params![stream_name, created],
                )?;
                read_cursor(&self.db, stream_name)?
            }
        };
        if cursor > last_seq {
            eprintln!(
                "views: stream {stream_name} cursor {cursor} is beyond its last sequence {last_seq} \
                 — an unreachable position; replaying from the start (no truncation)"
            );
            self.db.execute(
                "INSERT INTO cursor (stream_name, seq) VALUES (?1, 0)
                 ON CONFLICT (stream_name) DO UPDATE SET seq = 0",
                [stream_name],
            )?;
            return Ok(0);
        }
        Ok(cursor)
    }
}
