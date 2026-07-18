//! `Ref`: fetch-by-id, paged access to oversized tool output stashed in a
//! content-addressed store. Distinct from towerd's own `refs.rs` (wire/
//! browser-facing, externalises WS payloads at apply time) — this store is
//! model-context-facing: a tool whose own result is too big for a model
//! request stashes it here and returns a small `{ref, size, hint}` token
//! instead. This commit builds the mechanism (`store`) and the model-facing
//! fetch tool; the auto-invoke wiring that actually walks other tools'
//! output and calls `store` for anything oversized is the next commit —
//! until then `store` has no caller but tests, which is why it's allowed.

use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// `rusqlite::Connection` is `!Sync`; a mutex round the one connection is
/// enough for this store's traffic (occasional stash/fetch, not a hot
/// path) — no dedicated OS thread the way towerd's `Views` earns one.
pub type RefStore = Arc<Mutex<Connection>>;

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS refs (
            id TEXT PRIMARY KEY,
            hint TEXT NOT NULL,
            content BLOB NOT NULL,
            size INTEGER NOT NULL,
            created_ts TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("migrate refs store: {e}"))
}

/// Open (creating if needed) the content-addressed store at `path`. The
/// parent directory must already exist — the caller's concern, same as any
/// other config-provided path.
pub fn open(path: &std::path::Path) -> Result<RefStore, String> {
    let conn = Connection::open(path).map_err(|e| format!("open refs store {path:?}: {e}"))?;
    migrate(&conn)?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// A stashed value's id and size — what a tool's own oversized-output
/// handling returns to the caller as the `{ref, size, hint}` token.
pub struct Stored {
    pub id: String,
    pub size: usize,
}

/// Stash content, content-addressed: the id is the content's own sha256, so
/// storing the same bytes twice (a repeated large result) is a no-op, not a
/// duplicate row — the same dedupe towerd's `refs.rs` already established.
pub fn store(refs: &RefStore, content: &str, hint: &str) -> Result<Stored, String> {
    let id = format!("{:x}", Sha256::digest(content.as_bytes()));
    let size = content.len();
    let conn = refs.lock().unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO refs (id, hint, content, size, created_ts) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, hint, content.as_bytes(), size as i64, wire::now_iso()],
    )
    .map_err(|e| format!("store ref: {e}"))?;
    Ok(Stored { id, size })
}

const DEFAULT_LIMIT: usize = 10_000;
const MAX_LIMIT: usize = 100_000;

/// Anything a tool result carries past this is oversized for a model
/// request — mirrors the `~16 KB+` threshold CLAUDE.md documents for
/// towerd's own (wire-side) ref externalisation; reused here for the
/// model-context side rather than inventing a second number.
const OVERSIZED_THRESHOLD: usize = 16 * 1024;

/// The "walk and replace what's too big" choke point every composable/Exec
/// tool's string result passes through before it becomes a `tool_result`.
/// Under the threshold, `content` rides verbatim; over it, the FULL content
/// is stashed (nothing is discarded, unlike the old hard-truncate) and a
/// small `{ref, size, hint}` pointer takes its place — the model pages the
/// rest in with the `Ref` tool. A stash failure falls back to the raw
/// (still internally capped) content rather than losing the result outright.
pub fn finalize(refs: &RefStore, content: String, hint: &str) -> Value {
    if content.len() <= OVERSIZED_THRESHOLD {
        return Value::String(content);
    }
    match store(refs, &content, hint) {
        Ok(stored) => json!({ "ref": stored.id, "size": stored.size, "hint": hint }),
        Err(_) => Value::String(content),
    }
}

pub fn ref_schema() -> Value {
    json!({
        "name": "Ref",
        "description": "Fetch the content of a stored ref. When a tool result contains \
            { ref, size, hint } instead of the full value, use this tool to retrieve it. \
            Returns at most `limit` characters starting at `start` (both default to \
            0/10000), so a bare { id } call gives the first 10000 chars — safe for \
            arbitrarily large refs. Page further with start+limit. Read-only, so no \
            approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "The ref id." },
                "start": {
                    "type": "integer",
                    "description": "Start character offset (inclusive). Default 0."
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum characters to return. Max 100000, default 10000."
                }
            },
            "required": ["id"],
            "additionalProperties": false
        }
    })
}

/// Run `Ref` from its raw tool input.
pub fn run_ref(refs: &RefStore, input: &Value) -> (String, bool) {
    let Some(id) = input["id"].as_str() else {
        return ("missing \"id\"".to_string(), true);
    };
    let start = input["start"].as_u64().unwrap_or(0) as usize;
    let limit = (input["limit"].as_u64().unwrap_or(DEFAULT_LIMIT as u64) as usize).min(MAX_LIMIT);

    let conn = refs.lock().unwrap();
    let row: Result<(Vec<u8>, String), rusqlite::Error> =
        conn.query_row("SELECT content, hint FROM refs WHERE id = ?1", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        });
    let (content, hint) = match row {
        Ok(r) => r,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            return (format!("ref {id:?} not found"), true);
        }
        Err(e) => return (format!("ref lookup failed: {e}"), true),
    };
    let text = String::from_utf8_lossy(&content);
    let total = text.chars().count();
    let slice: String = text.chars().skip(start).take(limit).collect();
    let end = (start + slice.chars().count()).min(total);
    (
        format!("[ref {id}: {hint}, {total} chars total, showing {start}-{end}]\n{slice}"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::{finalize, run_ref, store};
    use rusqlite::Connection;
    use serde_json::json;

    fn memory_store() -> super::RefStore {
        let conn = Connection::open_in_memory().unwrap();
        super::migrate(&conn).unwrap();
        std::sync::Arc::new(std::sync::Mutex::new(conn))
    }

    #[test]
    fn stores_and_fetches_the_full_content_by_default() {
        let refs = memory_store();
        let stored = store(&refs, "hello world", "test output").unwrap();
        let (content, is_error) = run_ref(&refs, &json!({ "id": stored.id }));
        assert!(!is_error);
        assert!(content.contains("hello world"));
        assert!(content.contains("test output"));
    }

    #[test]
    fn pages_with_start_and_limit() {
        let refs = memory_store();
        let stored = store(&refs, "0123456789", "digits").unwrap();
        let (content, is_error) =
            run_ref(&refs, &json!({ "id": stored.id, "start": 3, "limit": 4 }));
        assert!(!is_error);
        assert!(content.ends_with("3456"), "unexpected slice: {content:?}");
    }

    #[test]
    fn storing_identical_content_twice_dedupes_to_one_id() {
        let refs = memory_store();
        let a = store(&refs, "same bytes", "first").unwrap();
        let b = store(&refs, "same bytes", "second").unwrap();
        assert_eq!(a.id, b.id);
    }

    #[test]
    fn an_unknown_id_is_reported_not_found() {
        let refs = memory_store();
        let (content, is_error) = run_ref(&refs, &json!({ "id": "does-not-exist" }));
        assert!(is_error);
        assert!(content.contains("not found"));
    }

    #[test]
    fn missing_id_field_is_an_error() {
        let refs = memory_store();
        let (_, is_error) = run_ref(&refs, &json!({}));
        assert!(is_error);
    }

    #[test]
    fn content_under_the_threshold_rides_verbatim() {
        let refs = memory_store();
        let out = finalize(&refs, "short".to_string(), "Exec");
        assert_eq!(out, json!("short"));
    }

    #[test]
    fn content_over_the_threshold_is_stashed_and_pointed_to() {
        let refs = memory_store();
        let big = "x".repeat(17 * 1024);
        let out = finalize(&refs, big.clone(), "Exec");
        let id = out["ref"].as_str().expect("ref id present").to_string();
        assert_eq!(out["hint"], "Exec");
        assert_eq!(out["size"].as_u64().unwrap() as usize, big.len());
        // Nothing was discarded: the full content is fetchable back out.
        let (fetched, is_error) = run_ref(&refs, &json!({ "id": id, "limit": 100_000 }));
        assert!(!is_error);
        assert!(fetched.contains(&big[..100]));
    }
}
