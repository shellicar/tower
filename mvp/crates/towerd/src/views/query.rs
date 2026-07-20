//! Read-only queries — the answers `answer()` (in `mod.rs`) sends back over
//! the reply oneshots. No fold, no mutation; `pub(super)` since every method
//! here is called from `mod.rs`'s dispatch, not from outside `views`.

use serde_json::{Value, json};

use wire::{ApprovalId, ConversationId, InstanceId, MessageId, QueryId, TurnId, WorldId};

use super::Views;
use super::schema::{LAYOUT_ID, read_usage_row};
use super::types::{
    AgentAttachmentState, AgentInstanceState, AgentsSnapshot, ApprovalState, ConversationMessage,
    ListSnapshot, RowState, SettledState, UsageState,
};

impl Views {
    pub(super) fn list(&self) -> anyhow::Result<ListSnapshot> {
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

    pub(super) fn conversation(
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
                    r.get::<_, Option<String>>(4)?,
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
                    from: sender.map(|s| serde_json::from_str(&s)).transpose()?,
                    content: serde_json::from_str(&content)?,
                    ts,
                })
            })
            .collect()
    }

    /// The conversation's usage snapshot; `None` when it has no usage yet.
    pub(super) fn usage(&self, conv: &ConversationId) -> anyhow::Result<Option<UsageState>> {
        Ok(rusqlite::OptionalExtension::optional(read_usage_row(
            &self.db, conv,
        ))?)
    }

    pub(super) fn layout(&self) -> anyhow::Result<Option<String>> {
        Ok(rusqlite::OptionalExtension::optional(self.db.query_row(
            "SELECT tabs FROM layout WHERE layout_id = ?1",
            [LAYOUT_ID],
            |r| r.get(0),
        ))?)
    }

    /// The outstanding snapshot: unsettled and not dismissed, oldest first.
    pub(super) fn approvals(&self) -> anyhow::Result<Vec<ApprovalState>> {
        let mut stmt = self.db.prepare_cached(
            "SELECT a.id, a.ask, a.correlation, a.raised_ts, a.last_pulse
             FROM approvals a
             LEFT JOIN dismissed_approvals d ON d.id = a.id
             WHERE a.settled_approved IS NULL AND d.id IS NULL
             ORDER BY a.raised_ts",
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
                    dismissed: false,
                })
            })
            .collect()
    }

    pub(super) fn get_approval(&self, id: &ApprovalId) -> anyhow::Result<Option<ApprovalState>> {
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
        let dismissed: bool = self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM dismissed_approvals WHERE id = ?1)",
            [&id.0],
            |r| r.get(0),
        )?;
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
            dismissed,
        }))
    }

    pub(super) fn agents(&self) -> anyhow::Result<AgentsSnapshot> {
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
        // A dismissal only hides an attachment while it's the SAME attach it
        // was raised against (attached_ts <= dismissed_ts): a fresh re-attach
        // after dismissal is new evidence and un-hides it, the same way a
        // stranded instance pulsing again resurrects it.
        let mut stmt = self.db.prepare_cached(
            "SELECT a.world, a.instance_id, a.conv, a.cwd, a.attached_ts
             FROM agent_attachments a
             LEFT JOIN dismissed_attachments d
                 ON d.world = a.world AND d.instance_id = a.instance_id AND d.conv = a.conv
             WHERE d.dismissed_ts IS NULL OR a.attached_ts > d.dismissed_ts",
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

    pub(super) fn get_ref(&self, id: &str) -> anyhow::Result<Option<(String, Vec<u8>)>> {
        let mut stmt = self
            .db
            .prepare_cached("SELECT hint, bytes FROM refs WHERE id = ?1")?;
        let mut rows = stmt.query([id])?;
        match rows.next()? {
            Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
            None => Ok(None),
        }
    }

    /// Everything a human would otherwise reach for a raw sqlite3 session to
    /// see: how many rows in each table, where each stream's cursor sits,
    /// the schema version, and the db file's size on disk (via page_count *
    /// page_size — portable, no need to know the file's own path).
    pub(super) fn stats(&self) -> anyhow::Result<Value> {
        let table_count = |t: &str| -> anyhow::Result<i64> {
            Ok(self
                .db
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?)
        };
        let tables = [
            "rows",
            "messages",
            "refs",
            "titles",
            "approvals",
            "tags",
            "tag_keys",
            "agent_instances",
            "agent_attachments",
            "usage",
            "layout",
            "dismissed_approvals",
            "dismissed_attachments",
        ];
        let mut counts = serde_json::Map::new();
        for t in tables {
            counts.insert(t.to_string(), json!(table_count(t)?));
        }

        let mut streams_stmt = self.db.prepare(
            "SELECT c.stream_name, c.seq, s.created
             FROM cursor c LEFT JOIN stream s ON s.stream_name = c.stream_name",
        )?;
        let streams: Vec<Value> = streams_stmt
            .query_map([], |r| {
                Ok(json!({
                    "stream": r.get::<_, String>(0)?,
                    "cursor": r.get::<_, i64>(1)?,
                    "created": r.get::<_, Option<String>>(2)?,
                }))
            })?
            .collect::<Result<_, _>>()?;

        let user_version: i64 = self.db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let page_count: i64 = self.db.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let page_size: i64 = self.db.query_row("PRAGMA page_size", [], |r| r.get(0))?;

        Ok(json!({
            "tables": counts,
            "streams": streams,
            "schemaVersion": user_version,
            "dbBytes": page_count * page_size,
        }))
    }
}
