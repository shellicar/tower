//! Mutations — annotations and layout writes. `pub(super)` since every
//! method here is called from `mod.rs`'s dispatch, not from outside `views`.

use wire::{ApprovalId, ConversationId, InstanceId, WorldId};

use super::Views;
use super::schema::LAYOUT_ID;
use super::types::ViewEvent;

impl Views {
    /// The palette keys draw from at first use — readable on the dark UI.
    /// `set_key_colour` is a db edit in v1; this only seeds.
    const PALETTE: [&'static str; 10] = [
        "#8ec07c", "#83a598", "#d3869b", "#fabd2f", "#fe8019", "#b8bb26", "#7fc7ff", "#d65d0e",
        "#b16286", "#689d6a",
    ];

    pub(super) fn set_tag(
        &mut self,
        conv: &ConversationId,
        key: &str,
        value: &str,
    ) -> anyhow::Result<()> {
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

    pub(super) fn set_title(&self, conv: &ConversationId, title: &str) -> anyhow::Result<()> {
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

    pub(super) fn set_layout(&self, tabs: &str) -> anyhow::Result<()> {
        self.db.execute(
            "INSERT INTO layout (layout_id, tabs) VALUES (?1, ?2)
             ON CONFLICT(layout_id) DO UPDATE SET tabs = excluded.tabs",
            rusqlite::params![LAYOUT_ID, tabs],
        )?;
        Ok(())
    }

    /// A human's own decision ("connection is authority") — not a claim the
    /// ask was answered. Idempotent: dismissing twice is a no-op the second
    /// time. Broadcasting the updated state (with `dismissed: true`) reuses
    /// the existing `Approval` fact rather than inventing a new frame —
    /// every session, including the dismisser's own, folds it the same way
    /// `settled` already is.
    pub(super) fn dismiss_approval(&self, id: &ApprovalId, now: i64) -> anyhow::Result<()> {
        self.db.execute(
            "INSERT OR IGNORE INTO dismissed_approvals (id, dismissed_ts) VALUES (?1, ?2)",
            rusqlite::params![id.0, now],
        )?;
        if let Some(mut state) = self.get_approval(id)? {
            state.dismissed = true;
            let _ = self.events.send(ViewEvent::Approval(state));
        }
        Ok(())
    }

    /// A human's own decision, same footing as `dismiss_approval`. Keyed by
    /// (world, instance, conv) with the CURRENT `attached_ts` — last write
    /// wins if dismissed more than once, and a later re-attach naturally
    /// un-hides it because `agents()`'s join compares against this stamp.
    pub(super) fn dismiss_attachment(
        &self,
        world: &WorldId,
        instance: &InstanceId,
        conv: &ConversationId,
        now: i64,
    ) -> anyhow::Result<()> {
        self.db.execute(
            "INSERT INTO dismissed_attachments (world, instance_id, conv, dismissed_ts)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(world, instance_id, conv) DO UPDATE SET dismissed_ts = excluded.dismissed_ts",
            rusqlite::params![world.0, instance.0, conv.0, now],
        )?;
        Ok(())
    }
}
