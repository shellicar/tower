//! Unread/stale-conversation tracking: a ticket-system signal ("has anyone
//! on the fleet looked at this since it last got new content"), not a
//! personal per-browser read marker. towerd owns the row and the per-episode
//! timer; the lifecycle:
//!
//! 1. A qualifying event (an assistant turn landing) while the conversation
//!    is resolved (acked, or never seen) mints a fresh `read_id` and starts
//!    an episode, silently — nothing broadcasts yet.
//! 2. A real timer (this module schedules it via the tokio runtime handle
//!    `Views` holds, not a polling sweep) runs for `STALE_AFTER` against
//!    that specific `read_id`.
//! 3. More qualifying events landing while the episode is already open do
//!    nothing — no new `read_id`, no timer reset. Resetting on every event
//!    would starve a busy conversation into never going stale.
//! 4. An ack (a session reporting it currently has the conversation open)
//!    resolves the CURRENT episode, whatever it is. If it lands before the
//!    timer fires, the episode never goes stale — silent the whole way.
//! 5. If the timer fires first, `unread.rs` re-checks the row is still this
//!    exact episode before declaring it stale (an ack that raced it in
//!    concurrently already changed the row, so the check is a plain
//!    `read_id` match, not a lock) and broadcasts the durable transition.
//! 6. A later ack against an already-stale episode broadcasts the resolution
//!    to every connected session, clearing the badge everywhere.

use wire::ConversationId;

use super::Views;
use super::types::{UnreadState, ViewEvent, ViewQuery};

/// How long a conversation may sit unseen before it's announced stale.
/// Applies once per unread episode; never reset by further activity.
pub(super) const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// A qualifying event while the conversation is resolved starts a fresh
/// episode. Already-open (unacked) is a no-op — the starvation guard.
/// Returns the freshly minted `read_id` when a timer needs starting; the
/// caller (fold.rs) schedules it once the transaction commits. A free
/// function, not a `Views` method: it only ever touches the open transaction
/// fold.rs already holds, and a method here would borrow `self` while
/// `tx` already holds `self.db` mutably.
pub(super) fn note_turn_finished(
    tx: &rusqlite::Transaction<'_>,
    conv: &ConversationId,
) -> anyhow::Result<Option<String>> {
    let open_episode: Option<bool> = rusqlite::OptionalExtension::optional(tx.query_row(
        "SELECT unread FROM unread WHERE conv = ?1",
        [&conv.0],
        |r| Ok(r.get::<_, i64>(0)? != 0),
    ))?;
    if open_episode == Some(true) {
        return Ok(None); // already an open episode — starvation guard
    }
    let read_id = uuid::Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO unread (conv, read_id, unread, stale) VALUES (?1, ?2, 1, 0)
         ON CONFLICT(conv) DO UPDATE SET read_id = excluded.read_id, unread = 1, stale = 0",
        rusqlite::params![conv.0, read_id],
    )?;
    Ok(Some(read_id))
}

impl Views {
    /// Schedules the per-episode timer on the tokio runtime `Views` was
    /// given at construction — a real timer, not a periodic table scan.
    /// Fires back into the same query queue `Views` reads from, so the
    /// transition is serialised through the one thread that touches sqlite,
    /// same as every other write here.
    pub(super) fn spawn_stale_timer(&self, conv: ConversationId, read_id: String) {
        let queries = self.self_queries.clone();
        self.runtime.spawn(async move {
            tokio::time::sleep(STALE_AFTER).await;
            let _ = queries
                .send(ViewQuery::StaleTimerFired { conv, read_id })
                .await;
        });
    }

    /// The timer fired: re-check the row is still this exact episode
    /// (unread, same `read_id`) before declaring it stale — an ack that beat
    /// it, or a superseded episode, makes this a silent no-op.
    pub(super) fn on_stale_timer(&mut self, conv: &ConversationId, read_id: &str) {
        let changed = self.db.execute(
            "UPDATE unread SET stale = 1 WHERE conv = ?1 AND read_id = ?2 AND unread = 1",
            rusqlite::params![conv.0, read_id],
        );
        match changed {
            Ok(0) => {} // superseded or already acked — no-op
            Ok(_) => {
                let _ = self.events.send(ViewEvent::Unread(UnreadState {
                    conv: conv.clone(),
                    read_id: read_id.to_owned(),
                    stale: true,
                }));
            }
            Err(e) => eprintln!("views: on_stale_timer failed for {conv}: {e:#}"),
        }
    }

    /// A session reporting it currently has the conversation open: "I have
    /// this open, therefore I saw it." Resolves whatever episode is CURRENT
    /// for the conv — an open conversation acks its newest content too, not
    /// just the one that triggered the report. Idempotent; a no-op when
    /// there's nothing outstanding. Broadcasts a resolution only if the
    /// episode had actually gone stale (a silent episode acked before the
    /// timer fires stays silent the whole way through).
    pub(super) fn ack_unread(&mut self, conv: &ConversationId) {
        let (read_id, was_stale) = match rusqlite::OptionalExtension::optional(self.db.query_row(
            "SELECT read_id, stale FROM unread WHERE conv = ?1 AND unread = 1",
            [&conv.0],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
        )) {
            Ok(Some(row)) => row,
            Ok(None) => return, // nothing outstanding — no-op
            Err(e) => {
                eprintln!("views: ack_unread failed for {conv}: {e:#}");
                return;
            }
        };
        if let Err(e) = self.db.execute(
            "UPDATE unread SET unread = 0, stale = 0 WHERE conv = ?1 AND read_id = ?2",
            rusqlite::params![conv.0, read_id],
        ) {
            eprintln!("views: ack_unread failed for {conv}: {e:#}");
            return;
        }
        if was_stale {
            let _ = self.events.send(ViewEvent::Unread(UnreadState {
                conv: conv.clone(),
                read_id,
                stale: false,
            }));
        }
    }

    /// The snapshot for a client connecting after the fact: every episode
    /// currently announced stale.
    pub(super) fn stale_conversations(&self) -> anyhow::Result<Vec<UnreadState>> {
        let mut stmt = self
            .db
            .prepare_cached("SELECT conv, read_id FROM unread WHERE unread = 1 AND stale = 1")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(UnreadState {
                    conv: ConversationId(r.get(0)?),
                    read_id: r.get(1)?,
                    stale: true,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
