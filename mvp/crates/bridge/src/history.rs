//! The shared history index: `~/.claude/history.db`, the same file
//! claude-sdk-cli's own `SqliteHistoryEngine` writes and reads. Ported
//! faithfully from packages/claude-core/src/history/SqliteHistoryEngine.ts
//! \u2014 same schema (messages/blocks/blocks_fts, external-content FTS5), same
//! per-type `bm25` weighting, same schema-version pragma.
//!
//! NOT ported: the LSH dedup sweep (`SqliteHistorySweeper`/`dedup.ts`) that
//! collapses near-duplicate messages found by `signature_bands`/
//! `message_duplicates`. Those tables are created (schema compatibility \u2014
//! the CLI's own migration 1.1 expects them to exist in a shared file) but
//! nothing here populates or reads them; a shared file just accumulates
//! without collapsing until that's built. Flagged, not silently dropped.

use rusqlite::Connection;
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub type HistoryStore = Arc<Mutex<Connection>>;

const SCHEMA_VERSION: i64 = 1001; // schemaVersion(1, 1)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone)]
pub struct HistoryBlock {
    pub seq: i64,
    pub kind: String,
    pub text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HistoryMessage {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub query_id: String,
    pub timestamp: String,
    pub role: Role,
    pub blocks: Vec<HistoryBlock>,
}

#[derive(Debug, Clone)]
pub struct HistorySearchHit {
    pub conversation_id: String,
    pub turn_id: String,
    pub timestamp: String,
    pub role: String,
    pub kind: String,
    pub snippet: String,
    pub score: f64,
}

#[derive(Debug, Clone)]
pub struct HistoryEvent {
    pub turn_id: String,
    pub timestamp: String,
    pub role: String,
    pub kind: String,
    pub text: String,
}

const EVENT_TEXT_CAP: usize = 2000;
const SNIPPET_TOKENS: i64 = 40;

pub fn open(path: &std::path::Path) -> Result<HistoryStore, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open history store {path:?}: {e}"))?;
    conn.execute_batch(
        "PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA journal_mode = WAL;",
    )
    .map_err(|e| format!("pragma: {e}"))?;
    migrate(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    let db_version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("read user_version: {e}"))?;
    let target_major = SCHEMA_VERSION / 1000;
    let db_major = db_version / 1000;
    if db_major > target_major {
        return Err(format!(
            "history store schema {db_version} is newer than this build supports ({SCHEMA_VERSION}); update the bridge"
        ));
    }
    if db_version >= SCHEMA_VERSION {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin: {e}"))?;
    let result = (|| -> Result<(), String> {
        let mut current: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if current < 1000 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS messages (
                    id              TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    turn_id         TEXT NOT NULL,
                    query_id        TEXT NOT NULL,
                    timestamp       TEXT NOT NULL,
                    role            TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS blocks (
                    message_id TEXT NOT NULL REFERENCES messages(id),
                    seq        INTEGER NOT NULL,
                    type       TEXT NOT NULL,
                    text       TEXT
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
                    text,
                    content = 'blocks',
                    content_rowid = 'rowid',
                    tokenize = 'porter unicode61'
                );
                CREATE INDEX IF NOT EXISTS blocks_message ON blocks(message_id);
                CREATE INDEX IF NOT EXISTS messages_turn ON messages(turn_id);
                CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, timestamp);
                CREATE INDEX IF NOT EXISTS messages_ts ON messages(timestamp);",
            )
            .map_err(|e| e.to_string())?;
            conn.execute_batch("PRAGMA user_version = 1000")
                .map_err(|e| e.to_string())?;
            current = 1000;
        }
        if current < SCHEMA_VERSION {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS sweep_state (
                    id            INTEGER PRIMARY KEY CHECK (id = 1),
                    lease_owner   TEXT,
                    lease_expires TEXT,
                    watermark     INTEGER NOT NULL DEFAULT 0
                );
                INSERT OR IGNORE INTO sweep_state (id, watermark) VALUES (1, 0);
                CREATE TABLE IF NOT EXISTS signature_bands (
                    message_id TEXT NOT NULL REFERENCES messages(id),
                    bucket     TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS signature_bands_bucket ON signature_bands(bucket);
                CREATE INDEX IF NOT EXISTS signature_bands_message ON signature_bands(message_id);
                CREATE TABLE IF NOT EXISTS message_duplicates (
                    duplicate_id TEXT PRIMARY KEY REFERENCES messages(id),
                    canonical_id TEXT NOT NULL REFERENCES messages(id)
                );",
            )
            .map_err(|e| e.to_string())?;
            conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn
            .execute_batch("COMMIT")
            .map_err(|e| format!("commit: {e}")),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Persist one message, idempotent on `id`: a repeat is dropped, never
/// updated \u2014 a message's content cannot change. Message + blocks land
/// atomically; a duplicate id inserts nothing, so the FTS mirror never
/// doubles up either.
pub fn insert(store: &HistoryStore, message: &HistoryMessage) -> Result<(), String> {
    let mut conn = store.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let changes = tx
        .execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, turn_id, query_id, timestamp, role)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                message.id,
                message.conversation_id,
                message.turn_id,
                message.query_id,
                message.timestamp,
                message.role.as_str()
            ],
        )
        .map_err(|e| e.to_string())?;
    if changes == 0 {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(());
    }
    for block in &message.blocks {
        tx.execute(
            "INSERT INTO blocks (message_id, seq, type, text) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![message.id, block.seq, block.kind, block.text],
        )
        .map_err(|e| e.to_string())?;
        let block_rowid = tx.last_insert_rowid();
        if let Some(text) = &block.text
            && !text.is_empty()
        {
            tx.execute(
                "INSERT INTO blocks_fts (rowid, text) VALUES (?1, ?2)",
                rusqlite::params![block_rowid, text],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

fn to_fts_match(query: &str) -> Option<String> {
    let re = regex::Regex::new(r"[\p{L}\p{N}]+").expect("static pattern");
    let tokens: Vec<String> = re
        .find_iter(query)
        .map(|m| format!("\"{}\"", m.as_str()))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" OR "))
    }
}

#[derive(Default)]
pub struct SearchFilters<'a> {
    pub role: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub since: Option<&'a str>,
    pub until: Option<&'a str>,
    pub exclude_conversation_id: Option<&'a str>,
}

/// Relevance search: plain words in, ranked hits out, best first (score is
/// `-weightedRank`). Per-type weight is applied at query time via a SQL
/// `CASE`, not baked into the index, so ranking can be retuned without a
/// re-index \u2014 mirrors `#weightCase()`.
pub fn search(
    store: &HistoryStore,
    query: &str,
    filters: &SearchFilters,
    limit: i64,
) -> Result<Vec<HistorySearchHit>, String> {
    let Some(match_expr) = to_fts_match(query) else {
        return Ok(Vec::new());
    };
    let conn = store.lock().unwrap();
    let mut sql = format!(
        "SELECT m.conversation_id AS conversationId, m.turn_id AS turnId, m.timestamp AS timestamp, m.role AS role, b.type AS type,
                snippet(blocks_fts, 0, '', '', '…', {SNIPPET_TOKENS}) AS snippet,
                bm25(blocks_fts) * (CASE b.type WHEN 'text' THEN 1.0 WHEN 'thinking' THEN 1.0 WHEN 'tool_use' THEN 0.3 WHEN 'tool_result' THEN 0.3 ELSE 1.0 END) AS weightedRank
         FROM blocks_fts
         JOIN blocks b ON b.rowid = blocks_fts.rowid
         JOIN messages m ON m.id = b.message_id
         WHERE blocks_fts MATCH ?1"
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(match_expr)];
    let mut n = 1; // ?1 is match_expr, already placed in the WHERE clause above
    if let Some(role) = filters.role {
        n += 1;
        sql.push_str(&format!(" AND m.role = ?{n}"));
        params.push(Box::new(role.to_string()));
    }
    if let Some(kind) = filters.kind {
        n += 1;
        sql.push_str(&format!(" AND b.type = ?{n}"));
        params.push(Box::new(kind.to_string()));
    }
    if let Some(since) = filters.since {
        n += 1;
        sql.push_str(&format!(" AND m.timestamp >= ?{n}"));
        params.push(Box::new(since.to_string()));
    }
    if let Some(until) = filters.until {
        n += 1;
        sql.push_str(&format!(" AND m.timestamp <= ?{n}"));
        params.push(Box::new(until.to_string()));
    }
    if let Some(exclude) = filters.exclude_conversation_id {
        n += 1;
        sql.push_str(&format!(" AND m.conversation_id <> ?{n}"));
        params.push(Box::new(exclude.to_string()));
    }
    n += 1;
    sql.push_str(&format!(" ORDER BY weightedRank ASC LIMIT ?{n}"));
    params.push(Box::new(limit));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let rank: f64 = row.get(6)?;
            Ok(HistorySearchHit {
                conversation_id: row.get(0)?,
                turn_id: row.get(1)?,
                timestamp: row.get(2)?,
                role: row.get(3)?,
                kind: row.get(4)?,
                snippet: row.get(5)?,
                score: -rank,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// The turns of one conversation within `window` positions of the cited
/// `turn_id`, that conversation's turns ordered by timestamp. Scoped to the
/// one conversation \u2014 a citation never reaches across into another
/// session's turns. An unknown conversation or turn_id matches nothing.
pub fn read(
    store: &HistoryStore,
    conversation_id: &str,
    turn_id: &str,
    window: i64,
) -> Result<Vec<HistoryEvent>, String> {
    let conn = store.lock().unwrap();
    let mut turns_stmt = conn
        .prepare(
            "WITH ordered AS (
                SELECT turn_id, ROW_NUMBER() OVER (ORDER BY MIN(timestamp) ASC, turn_id ASC) AS pos
                FROM messages WHERE conversation_id = ?1 GROUP BY turn_id
             ),
             centre AS (SELECT pos FROM ordered WHERE turn_id = ?2)
             SELECT o.turn_id FROM ordered o, centre c
             WHERE o.pos BETWEEN c.pos - ?3 AND c.pos + ?3
             ORDER BY o.pos",
        )
        .map_err(|e| e.to_string())?;
    let turn_ids: Vec<String> = turns_stmt
        .query_map(rusqlite::params![conversation_id, turn_id, window], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut events_stmt = conn
        .prepare(
            "SELECT m.timestamp AS timestamp, m.role AS role, b.type AS type, b.text AS text
             FROM messages m JOIN blocks b ON b.message_id = m.id
             WHERE m.turn_id = ?1
             ORDER BY CASE m.role WHEN 'user' THEN 0 ELSE 1 END, b.seq",
        )
        .map_err(|e| e.to_string())?;
    let mut events = Vec::new();
    for tid in &turn_ids {
        let rows = events_stmt
            .query_map(rusqlite::params![tid], |row| {
                let timestamp: String = row.get(0)?;
                let role: String = row.get(1)?;
                let kind: String = row.get(2)?;
                let text: Option<String> = row.get(3)?;
                Ok((timestamp, role, kind, text))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (timestamp, role, kind, text) = row.map_err(|e| e.to_string())?;
            events.push(HistoryEvent {
                turn_id: tid.clone(),
                timestamp,
                role,
                kind,
                text: cap(text),
            });
        }
    }
    Ok(events)
}

fn cap(text: Option<String>) -> String {
    let Some(text) = text else {
        return String::new();
    };
    if text.chars().count() <= EVENT_TEXT_CAP {
        text
    } else {
        let head: String = text.chars().take(EVENT_TEXT_CAP).collect();
        format!("{head}…")
    }
}

/// Turn a message's content into the store's blocks \u2014 ported from
/// `historyBlocks.ts`. `content` is a raw Anthropic content-block array (or,
/// for a bare user send, handled by the caller passing a single text block).
pub fn to_history_blocks(content: &[Value]) -> Vec<HistoryBlock> {
    content
        .iter()
        .enumerate()
        .map(|(seq, block)| HistoryBlock {
            seq: seq as i64,
            kind: block_kind(block),
            text: block_text(block),
        })
        .collect()
}

fn block_kind(block: &Value) -> String {
    block["type"].as_str().unwrap_or("unknown").to_string()
}

fn block_text(block: &Value) -> Option<String> {
    match block["type"].as_str() {
        Some("text") => block["text"].as_str().map(str::to_owned),
        Some("thinking") => block["thinking"].as_str().map(str::to_owned),
        Some("tool_use") => {
            let name = block["name"].as_str().unwrap_or("");
            Some(format!("{name} {}", block["input"]))
        }
        Some("tool_result") => tool_result_text(&block["content"]),
        _ => None,
    }
}

fn tool_result_text(content: &Value) -> Option<String> {
    if content.is_null() {
        return None;
    }
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let texts: Vec<&str> = content
        .as_array()?
        .iter()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn history_store() -> HistoryStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
            .unwrap();
        migrate(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn msg(
        id: &str,
        conv: &str,
        turn: &str,
        query: &str,
        ts: &str,
        role: Role,
        text: &str,
    ) -> HistoryMessage {
        HistoryMessage {
            id: id.into(),
            conversation_id: conv.into(),
            turn_id: turn.into(),
            query_id: query.into(),
            timestamp: ts.into(),
            role,
            blocks: vec![HistoryBlock {
                seq: 0,
                kind: "text".into(),
                text: Some(text.into()),
            }],
        }
    }

    #[test]
    fn insert_then_search_finds_the_message() {
        let store = history_store();
        insert(
            &store,
            &msg(
                "m1",
                "c1",
                "t1",
                "q1",
                "2026-01-01T00:00:00.000Z",
                Role::User,
                "the sqlite migration failed",
            ),
        )
        .unwrap();
        let hits = search(&store, "migration", &SearchFilters::default(), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].conversation_id, "c1");
        assert_eq!(hits[0].turn_id, "t1");
    }

    #[test]
    fn insert_is_idempotent_on_id() {
        let store = history_store();
        let m = msg(
            "m1",
            "c1",
            "t1",
            "q1",
            "2026-01-01T00:00:00.000Z",
            Role::User,
            "hello world",
        );
        insert(&store, &m).unwrap();
        insert(&store, &m).unwrap();
        let hits = search(&store, "hello", &SearchFilters::default(), 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn search_respects_role_and_type_filters() {
        let store = history_store();
        insert(
            &store,
            &msg(
                "m1",
                "c1",
                "t1",
                "q1",
                "2026-01-01T00:00:00.000Z",
                Role::User,
                "shared word",
            ),
        )
        .unwrap();
        insert(
            &store,
            &msg(
                "m2",
                "c1",
                "t2",
                "q1",
                "2026-01-01T00:01:00.000Z",
                Role::Assistant,
                "shared word",
            ),
        )
        .unwrap();
        let filters = SearchFilters {
            role: Some("assistant"),
            ..Default::default()
        };
        let hits = search(&store, "shared", &filters, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].role, "assistant");
    }

    #[test]
    fn search_excludes_a_conversation_when_asked() {
        let store = history_store();
        insert(
            &store,
            &msg(
                "m1",
                "c1",
                "t1",
                "q1",
                "2026-01-01T00:00:00.000Z",
                Role::User,
                "unique_word_here",
            ),
        )
        .unwrap();
        let filters = SearchFilters {
            exclude_conversation_id: Some("c1"),
            ..Default::default()
        };
        let hits = search(&store, "unique_word_here", &filters, 10).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn read_opens_the_window_around_a_turn() {
        let store = history_store();
        insert(
            &store,
            &msg(
                "m1",
                "c1",
                "t1",
                "q1",
                "2026-01-01T00:00:00.000Z",
                Role::User,
                "first",
            ),
        )
        .unwrap();
        insert(
            &store,
            &msg(
                "m2",
                "c1",
                "t2",
                "q1",
                "2026-01-01T00:01:00.000Z",
                Role::Assistant,
                "second",
            ),
        )
        .unwrap();
        insert(
            &store,
            &msg(
                "m3",
                "c1",
                "t3",
                "q1",
                "2026-01-01T00:02:00.000Z",
                Role::User,
                "third",
            ),
        )
        .unwrap();
        let events = read(&store, "c1", "t2", 1).unwrap();
        let texts: Vec<&str> = events.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, vec!["first", "second", "third"]);
    }

    #[test]
    fn read_never_reaches_into_another_conversation() {
        let store = history_store();
        insert(
            &store,
            &msg(
                "m1",
                "c1",
                "t1",
                "q1",
                "2026-01-01T00:00:00.000Z",
                Role::User,
                "in c1",
            ),
        )
        .unwrap();
        insert(
            &store,
            &msg(
                "m2",
                "c2",
                "t2",
                "q1",
                "2026-01-01T00:01:00.000Z",
                Role::User,
                "in c2",
            ),
        )
        .unwrap();
        let events = read(&store, "c1", "t1", 5).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].text, "in c1");
    }

    #[test]
    fn to_history_blocks_extracts_text_from_each_block_type() {
        let content = vec![
            json!({ "type": "text", "text": "hello" }),
            json!({ "type": "thinking", "thinking": "pondering" }),
            json!({ "type": "tool_use", "name": "Find", "input": { "path": "." } }),
            json!({ "type": "tool_result", "content": "output text" }),
            json!({ "type": "image", "source": {} }),
        ];
        let blocks = to_history_blocks(&content);
        assert_eq!(blocks[0].text.as_deref(), Some("hello"));
        assert_eq!(blocks[1].text.as_deref(), Some("pondering"));
        assert!(blocks[2].text.as_deref().unwrap().starts_with("Find "));
        assert_eq!(blocks[3].text.as_deref(), Some("output text"));
        assert_eq!(blocks[4].text, None);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
    }

    #[test]
    fn migrate_refuses_a_newer_major_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 2000;").unwrap();
        let err = migrate(&conn).unwrap_err();
        assert!(err.contains("newer than this build supports"));
    }
}
