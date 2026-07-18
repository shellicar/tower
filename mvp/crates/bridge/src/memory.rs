//! The shared memory engine: `~/.claude/memory.db`, the same file
//! claude-sdk-cli's own `SqliteMemoryEngine` writes and reads (WAL,
//! `busy_timeout`, already multi-process safe). Ported faithfully from
//! packages/mcp-memory/src/SqliteMemoryEngine.ts and claude-core/src/memory/
//! {search,environment}.ts \u2014 same FTS5 table, same `bm25` weights, same
//! schema-version pragma, so a Node CLI and this bridge read one file side
//! by side. No tool wraps this yet (commit 15); this is the engine alone —
//! unused by production code until then, hence the module-wide allow.

#![allow(dead_code)]

use rusqlite::Connection;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub type MemoryStore = Arc<Mutex<Connection>>;

/// `schemaVersion(1, 0)` from migrate.ts: `major * 1000 + minor`.
const SCHEMA_VERSION: i64 = 1000;

/// Column order fixes the bm25() weight positions: title, body, keywords
/// are columns 0, 1, 2 \u2014 must not reorder without moving the weights too.
const BM25_WEIGHTS: &str = "10.0, 1.0, 4.0";

#[derive(Debug, Clone)]
pub struct MemoryDraft {
    pub title: String,
    pub body: String,
    pub kind: String,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEntry {
    pub id: String,
    pub title: String,
    pub body: String,
    pub kind: String,
    pub keywords: Vec<String>,
    pub environment: Value,
    pub created_at: String,
}

pub fn open(path: &std::path::Path) -> Result<MemoryStore, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {parent:?}: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open memory store {path:?}: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    )
    .map_err(|e| format!("pragma: {e}"))?;
    migrate(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// A store at a newer MAJOR than this build is refused \u2014 a newer build
/// wrote it, never down-migrate. A newer MINOR within this build's major is
/// tolerated and operated against, not migrated \u2014 mirrors migrate.ts.
pub(crate) fn migrate(conn: &Connection) -> Result<(), String> {
    let db_version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("read user_version: {e}"))?;
    let target_major = SCHEMA_VERSION / 1000;
    let db_major = db_version / 1000;
    if db_major > target_major {
        return Err(format!(
            "memory store schema {db_version} is newer than this build supports ({SCHEMA_VERSION}); update the bridge"
        ));
    }
    if db_version >= SCHEMA_VERSION {
        return Ok(());
    }
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin: {e}"))?;
    let result = (|| -> Result<(), String> {
        // Re-check under the write lock: another process sharing this store
        // could have applied the same migration in the gap since the read above.
        let current: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if current < SCHEMA_VERSION {
            conn.execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS memories USING fts5(
                    title, body, keywords,
                    id UNINDEXED, type UNINDEXED, keywords_json UNINDEXED,
                    environment UNINDEXED, created_at UNINDEXED,
                    tokenize = 'porter unicode61'
                );
                CREATE TABLE IF NOT EXISTS memory_index (id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS memories_archive (
                    id TEXT PRIMARY KEY, title TEXT, body TEXT, keywords_json TEXT,
                    type TEXT, environment TEXT, created_at TEXT, deleted_at TEXT
                );
                INSERT OR IGNORE INTO memory_index (id, fts_rowid) SELECT id, rowid FROM memories;",
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

fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<MemoryEntry> {
    let keywords_json: String = row.get(3)?;
    let environment_json: String = row.get(5)?;
    Ok(MemoryEntry {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        keywords: serde_json::from_str(&keywords_json).unwrap_or_default(),
        kind: row.get(4)?,
        environment: serde_json::from_str(&environment_json).unwrap_or(json!({})),
        created_at: row.get(6)?,
    })
}

/// Persist a new memory. Stamps `id` and `createdAt`; the caller supplies
/// the environment already resolved (`read_git_environment`).
pub fn write(
    store: &MemoryStore,
    draft: &MemoryDraft,
    environment: &Value,
) -> Result<MemoryEntry, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let created_at = wire::now_iso();
    let keywords_json = serde_json::to_string(&draft.keywords).map_err(|e| e.to_string())?;
    let env_json = serde_json::to_string(environment).map_err(|e| e.to_string())?;
    let mut conn = store.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO memories (title, body, keywords, id, type, keywords_json, environment, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            draft.title,
            draft.body,
            draft.keywords.join(" "),
            id,
            draft.kind,
            keywords_json,
            env_json,
            created_at
        ],
    )
    .map_err(|e| e.to_string())?;
    let rowid = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO memory_index (id, fts_rowid) VALUES (?1, ?2)",
        rusqlite::params![id, rowid],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(MemoryEntry {
        id,
        title: draft.title.clone(),
        body: draft.body.clone(),
        kind: draft.kind.clone(),
        keywords: draft.keywords.clone(),
        environment: environment.clone(),
        created_at,
    })
}

/// Fetch one memory by id. `None` for an unknown or soft-deleted id \u2014 the
/// two are indistinguishable to the caller by design.
pub fn read(store: &MemoryStore, id: &str) -> Result<Option<MemoryEntry>, String> {
    let conn = store.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.title, m.body, m.keywords_json, m.type, m.environment, m.created_at
             FROM memories m JOIN memory_index x ON x.fts_rowid = m.rowid
             WHERE x.id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    match rows.next().map_err(|e| e.to_string())? {
        Some(row) => Ok(Some(row_to_entry(row).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// Convert plain search words into a safe FTS5 MATCH expression. Only
/// Unicode letter/number runs survive as double-quoted, OR-joined literals
/// \u2014 no FTS5 operator syntax (-, *, OR, AND, NEAR, quotes) can reach the
/// query from user text. `None` when nothing usable remains.
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

/// Relevance search: plain words in, ranked hits out, best first (score is
/// `-bm25`, so higher is better). Soft-deleted memories are invisible \u2014
/// they were deleted from `memories`, not merely flagged.
pub fn search(
    store: &MemoryStore,
    query: &str,
    type_filter: Option<&str>,
    limit: i64,
) -> Result<Vec<(MemoryEntry, f64)>, String> {
    let Some(match_expr) = to_fts_match(query) else {
        return Ok(Vec::new());
    };
    let conn = store.lock().unwrap();
    let sql = format!(
        "SELECT id, title, body, keywords_json, type, environment, created_at, bm25(memories, {BM25_WEIGHTS}) AS rank
         FROM memories
         WHERE memories MATCH ?1 {}
         ORDER BY rank ASC
         LIMIT {}",
        if type_filter.is_some() { "AND type = ?2" } else { "" },
        if type_filter.is_some() { "?3" } else { "?2" },
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<(MemoryEntry, f64)> {
        let entry = row_to_entry(row)?;
        let rank: f64 = row.get(7)?;
        Ok((entry, -rank))
    };
    let rows = if let Some(t) = type_filter {
        stmt.query_map(rusqlite::params![match_expr, t, limit], map_row)
    } else {
        stmt.query_map(rusqlite::params![match_expr, limit], map_row)
    }
    .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Retire a memory: soft delete via an archive row, then remove it from the
/// live index. Idempotent \u2014 an unknown or already-deleted id resolves
/// without error, so a caller retiring a memory it already retired is fine.
pub fn delete(store: &MemoryStore, id: &str) -> Result<(), String> {
    let mut conn = store.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let deleted_at = wire::now_iso();
    let archived = tx
        .execute(
            "INSERT INTO memories_archive (id, title, body, keywords_json, type, environment, created_at, deleted_at)
             SELECT m.id, m.title, m.body, m.keywords_json, m.type, m.environment, m.created_at, ?1
             FROM memories m JOIN memory_index x ON x.fts_rowid = m.rowid
             WHERE x.id = ?2",
            rusqlite::params![deleted_at, id],
        )
        .map_err(|e| e.to_string())?;
    if archived > 0 {
        tx.execute(
            "DELETE FROM memories WHERE rowid = (SELECT fts_rowid FROM memory_index WHERE id = ?1)",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM memory_index WHERE id = ?1",
            rusqlite::params![id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Distinct live types with counts, so a writer reuses an established word
/// rather than drift into a near-duplicate.
pub fn types(store: &MemoryStore) -> Result<Vec<(String, i64)>, String> {
    let conn = store.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT type, COUNT(*) AS count FROM memories GROUP BY type ORDER BY count DESC, type ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// Reads the git remote of `cwd` (the process's own if `None`) and labels
/// it host/org/repo, or `{}` outside a git repo \u2014 the environment a written
/// memory is stamped with.
pub async fn read_git_environment(cwd: Option<&str>) -> Value {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(["config", "--get", "remote.origin.url"]);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    match cmd.output().await {
        Ok(out) if out.status.success() => parse_git_remote(&String::from_utf8_lossy(&out.stdout)),
        _ => json!({}),
    }
}

/// Recognises GitHub and Azure DevOps, HTTPS and SSH. An unrecognised URL
/// yields `{}` \u2014 it labels what it can, never guesses.
fn parse_git_remote(url: &str) -> Value {
    let trimmed = url.trim().trim_end_matches(".git");
    if trimmed.is_empty() {
        return json!({});
    }
    if let Some(caps) = regex::Regex::new(r"github\.com[/:]([^/]+)/([^/]+)$")
        .expect("static")
        .captures(trimmed)
    {
        return json!({ "host": "github", "org": &caps[1], "repo": &caps[2] });
    }
    if let Some(caps) = regex::Regex::new(r"dev\.azure\.com:v3/([^/]+)/([^/]+)/([^/]+)$")
        .expect("static")
        .captures(trimmed)
    {
        return json!({ "host": "azure", "org": &caps[1], "project": &caps[2], "repo": &caps[3] });
    }
    if let Some(caps) = regex::Regex::new(r"dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/]+)$")
        .expect("static")
        .captures(trimmed)
    {
        return json!({ "host": "azure", "org": &caps[1], "project": &caps[2], "repo": &caps[3] });
    }
    json!({})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_store() -> MemoryStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
            .unwrap();
        migrate(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn draft(title: &str, body: &str, kind: &str, keywords: &[&str]) -> MemoryDraft {
        MemoryDraft {
            title: title.into(),
            body: body.into(),
            kind: kind.into(),
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let store = memory_store();
        let entry = write(
            &store,
            &draft("A trap", "body text", "trap", &["sqlite"]),
            &json!({ "repo": "x" }),
        )
        .unwrap();
        let read_back = read(&store, &entry.id).unwrap().unwrap();
        assert_eq!(read_back, entry);
    }

    #[test]
    fn read_unknown_id_is_none() {
        let store = memory_store();
        assert!(read(&store, "does-not-exist").unwrap().is_none());
    }

    #[test]
    fn search_finds_a_written_memory_by_a_body_word() {
        let store = memory_store();
        write(
            &store,
            &draft(
                "Missing directory",
                "sqlite fails without mkdir first",
                "trap",
                &[],
            ),
            &json!({}),
        )
        .unwrap();
        let hits = search(&store, "mkdir", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.title, "Missing directory");
    }

    #[test]
    fn search_respects_the_type_filter() {
        let store = memory_store();
        write(
            &store,
            &draft("A", "shared word content", "trap", &[]),
            &json!({}),
        )
        .unwrap();
        write(
            &store,
            &draft("B", "shared word content", "decision", &[]),
            &json!({}),
        )
        .unwrap();
        let hits = search(&store, "shared", Some("trap"), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.title, "A");
    }

    #[test]
    fn search_with_no_usable_tokens_returns_empty_not_an_error() {
        let store = memory_store();
        write(&store, &draft("A", "body", "trap", &[]), &json!({})).unwrap();
        let hits = search(&store, "*** --- ", None, 10).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn delete_makes_a_memory_unreadable_and_invisible_to_search() {
        let store = memory_store();
        let entry = write(
            &store,
            &draft("Gone", "unique_search_word_xyz", "trap", &[]),
            &json!({}),
        )
        .unwrap();
        delete(&store, &entry.id).unwrap();
        assert!(read(&store, &entry.id).unwrap().is_none());
        assert!(
            search(&store, "unique_search_word_xyz", None, 10)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn delete_is_idempotent_for_an_unknown_id() {
        let store = memory_store();
        assert!(delete(&store, "never-existed").is_ok());
    }

    #[test]
    fn types_counts_distinct_kinds() {
        let store = memory_store();
        write(&store, &draft("A", "x", "trap", &[]), &json!({})).unwrap();
        write(&store, &draft("B", "y", "trap", &[]), &json!({})).unwrap();
        write(&store, &draft("C", "z", "decision", &[]), &json!({})).unwrap();
        let counts = types(&store).unwrap();
        assert_eq!(
            counts,
            vec![("trap".to_string(), 2), ("decision".to_string(), 1)]
        );
    }

    #[test]
    fn parses_github_https_and_ssh_remotes() {
        assert_eq!(
            parse_git_remote("https://github.com/shellicar/tower.git\n"),
            json!({ "host": "github", "org": "shellicar", "repo": "tower" })
        );
        assert_eq!(
            parse_git_remote("git@github.com:shellicar/tower.git\n"),
            json!({ "host": "github", "org": "shellicar", "repo": "tower" })
        );
    }

    #[test]
    fn parses_azure_https_and_ssh_remotes() {
        assert_eq!(
            parse_git_remote("https://org@dev.azure.com/org/project/_git/repo\n"),
            json!({ "host": "azure", "org": "org", "project": "project", "repo": "repo" })
        );
        assert_eq!(
            parse_git_remote("git@ssh.dev.azure.com:v3/org/project/repo\n"),
            json!({ "host": "azure", "org": "org", "project": "project", "repo": "repo" })
        );
    }

    #[test]
    fn an_unrecognised_remote_labels_nothing() {
        assert_eq!(parse_git_remote("https://example.com/x/y\n"), json!({}));
        assert_eq!(parse_git_remote(""), json!({}));
    }

    #[test]
    fn migrate_refuses_a_newer_major_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 2000;").unwrap();
        let err = migrate(&conn).unwrap_err();
        assert!(err.contains("newer than this build supports"));
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
    }
}
