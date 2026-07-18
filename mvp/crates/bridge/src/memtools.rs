//! `WriteMemory`/`ReadMemory`/`SearchMemory`/`DeleteMemory`/`MemoryTypes`:
//! the model-facing surface over the shared engine (memory.rs). Write ops
//! (`WriteMemory`/`DeleteMemory`) gate behind the same human approval as any
//! mutation; read ops don't. `intent` is accepted on every schema and
//! discarded \u2014 shown to a human watcher in the reference tool, never stored,
//! never searched; the bridge has no such watcher surface yet, so it's
//! simply ignored rather than persisted.

use serde_json::{Value, json};

use crate::memory::{self, MemoryDraft, MemoryStore};

pub fn write_memory_schema() -> Value {
    json!({
        "name": "WriteMemory",
        "description": "Write a memory for any later Claude to find. Records what you \
            learned — a trap, a decision and its reasoning, a correction — so it survives \
            this session. Title is the handle that ranks; body is the memory; type \
            classifies it.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "The one-line handle that ranks highest and is what a \
                        later search recalls. Make it a claim, not a topic."
                },
                "body": {
                    "type": "string",
                    "description": "The memory itself — what the next Claude needs to know."
                },
                "type": {
                    "type": "string",
                    "description": "The kind of memory (e.g. trap, decision, pattern). Reuse \
                        an existing word from MemoryTypes rather than coining a near-duplicate."
                },
                "keywords": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Extra search terms that need not appear in the prose."
                },
                "intent": {
                    "type": "string",
                    "description": "Why you are making this call, in plain words. Never \
                        stored, never searched."
                }
            },
            "required": ["title", "body", "type", "intent"],
            "additionalProperties": false
        }
    })
}

pub fn read_memory_schema() -> Value {
    json!({
        "name": "ReadMemory",
        "description": "Fetch one memory by its id. Returns not-found if the id is unknown \
            or has been retired.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "The id returned by WriteMemory or SearchMemory." },
                "intent": {
                    "type": "string",
                    "description": "Why you are making this call, in plain words. Never \
                        stored, never searched."
                }
            },
            "required": ["id", "intent"],
            "additionalProperties": false
        }
    })
}

pub fn search_memory_schema() -> Value {
    json!({
        "name": "SearchMemory",
        "description": "Search every memory by relevance. Describe what you need in plain \
            words; the most relevant memories come back ranked, best first. Optionally \
            narrow to one type.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Describe what you need in plain words. Treated only as \
                        search terms — never query syntax."
                },
                "type": { "type": "string", "description": "Narrow to one type. Omit to search every type." },
                "limit": {
                    "type": "integer",
                    "description": "Maximum hits to return, best first. Default 10."
                },
                "intent": {
                    "type": "string",
                    "description": "Why you are making this call, in plain words. Never \
                        stored, never searched."
                }
            },
            "required": ["query", "intent"],
            "additionalProperties": false
        }
    })
}

pub fn delete_memory_schema() -> Value {
    json!({
        "name": "DeleteMemory",
        "description": "Retire a memory by id so it stops surfacing in search — use when \
            rewriting a memory that is wrong. Idempotent: deleting an unknown or already-\
            retired id still succeeds.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": { "type": "string", "description": "The id to retire." },
                "intent": {
                    "type": "string",
                    "description": "Why you are making this call, in plain words. Never \
                        stored, never searched."
                }
            },
            "required": ["id", "intent"],
            "additionalProperties": false
        }
    })
}

pub fn memory_types_schema() -> Value {
    json!({
        "name": "MemoryTypes",
        "description": "List the distinct memory types in use with their counts, so you \
            reuse an established word rather than coin a near-duplicate.",
        "input_schema": {
            "type": "object",
            "properties": {
                "intent": {
                    "type": "string",
                    "description": "Why you are making this call, in plain words. Never \
                        stored, never searched."
                }
            },
            "required": [],
            "additionalProperties": false
        }
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
}

fn format_entry(entry: &memory::MemoryEntry) -> String {
    format!(
        "id: {}\ntitle: {}\ntype: {}\ncreated: {}\nkeywords: {}\nenvironment: {}\n\n{}",
        entry.id,
        entry.title,
        entry.kind,
        entry.created_at,
        entry.keywords.join(", "),
        entry.environment,
        entry.body
    )
}

pub async fn run_write_memory(store: &MemoryStore, input: &Value) -> (String, bool) {
    let (Some(title), Some(body), Some(kind)) = (
        input["title"].as_str(),
        input["body"].as_str(),
        input["type"].as_str(),
    ) else {
        return ("missing \"title\", \"body\" or \"type\"".to_string(), true);
    };
    let keywords: Vec<String> = input["keywords"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let draft = MemoryDraft {
        title: title.to_string(),
        body: body.to_string(),
        kind: kind.to_string(),
        keywords,
    };
    let environment = memory::read_git_environment(None).await;
    match memory::write(store, &draft, &environment) {
        Ok(entry) => (format!("wrote memory {}", entry.id), false),
        Err(e) => (e, true),
    }
}

pub fn run_read_memory(store: &MemoryStore, input: &Value) -> (String, bool) {
    let Some(id) = input["id"].as_str() else {
        return ("missing \"id\"".to_string(), true);
    };
    match memory::read(store, id) {
        Ok(Some(entry)) => (format_entry(&entry), false),
        Ok(None) => (format!("no memory found for id {id:?}"), true),
        Err(e) => (e, true),
    }
}

pub fn run_search_memory(store: &MemoryStore, input: &Value) -> (String, bool) {
    let Some(query) = input["query"].as_str() else {
        return ("missing \"query\"".to_string(), true);
    };
    let type_filter = input["type"].as_str();
    let limit = input["limit"].as_i64().unwrap_or(10);
    match memory::search(store, query, type_filter, limit) {
        Ok(hits) if hits.is_empty() => ("no memories matched".to_string(), false),
        Ok(hits) => {
            let text = hits
                .iter()
                .enumerate()
                .map(|(i, (entry, score))| {
                    format!(
                        "[{}] score {score:.2} — {} ({})\n  id: {}\n  {}",
                        i + 1,
                        entry.title,
                        entry.kind,
                        entry.id,
                        truncate(&entry.body, 200)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            (text, false)
        }
        Err(e) => (e, true),
    }
}

pub fn run_delete_memory(store: &MemoryStore, input: &Value) -> (String, bool) {
    let Some(id) = input["id"].as_str() else {
        return ("missing \"id\"".to_string(), true);
    };
    match memory::delete(store, id) {
        Ok(()) => (format!("retired memory {id}"), false),
        Err(e) => (e, true),
    }
}

pub fn run_memory_types(store: &MemoryStore) -> (String, bool) {
    match memory::types(store) {
        Ok(counts) if counts.is_empty() => ("no memories yet".to_string(), false),
        Ok(counts) => (
            counts
                .iter()
                .map(|(t, c)| format!("{t}: {c}"))
                .collect::<Vec<_>>()
                .join("\n"),
            false,
        ),
        Err(e) => (e, true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn memory_store() -> MemoryStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
            .unwrap();
        crate::memory::migrate(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    #[tokio::test]
    async fn write_then_read_round_trips() {
        let store = memory_store();
        let (write_out, is_error) = run_write_memory(
            &store,
            &json!({ "title": "A trap", "body": "body text", "type": "trap", "intent": "test" }),
        )
        .await;
        assert!(!is_error);
        let id = write_out.strip_prefix("wrote memory ").unwrap();
        let (read_out, is_error) = run_read_memory(&store, &json!({ "id": id, "intent": "test" }));
        assert!(!is_error);
        assert!(read_out.contains("A trap"));
        assert!(read_out.contains("body text"));
    }

    #[test]
    fn read_unknown_id_is_an_error() {
        let store = memory_store();
        let (content, is_error) =
            run_read_memory(&store, &json!({ "id": "nope", "intent": "test" }));
        assert!(is_error);
        assert!(content.contains("no memory found"));
    }

    #[tokio::test]
    async fn search_finds_a_written_memory() {
        let store = memory_store();
        run_write_memory(
            &store,
            &json!({ "title": "Missing dir", "body": "sqlite fails without mkdir", "type": "trap", "intent": "t" }),
        )
        .await;
        let (content, is_error) =
            run_search_memory(&store, &json!({ "query": "mkdir", "intent": "t" }));
        assert!(!is_error);
        assert!(content.contains("Missing dir"));
    }

    #[test]
    fn search_with_no_matches_is_not_an_error() {
        let store = memory_store();
        let (content, is_error) =
            run_search_memory(&store, &json!({ "query": "nothing here", "intent": "t" }));
        assert!(!is_error);
        assert_eq!(content, "no memories matched");
    }

    #[tokio::test]
    async fn delete_then_read_reports_not_found() {
        let store = memory_store();
        let (write_out, _) = run_write_memory(
            &store,
            &json!({ "title": "Gone", "body": "x", "type": "trap", "intent": "t" }),
        )
        .await;
        let id = write_out.strip_prefix("wrote memory ").unwrap().to_string();
        let (_, is_error) = run_delete_memory(&store, &json!({ "id": id, "intent": "t" }));
        assert!(!is_error);
        let (_, is_error) = run_read_memory(&store, &json!({ "id": id, "intent": "t" }));
        assert!(is_error);
    }

    #[test]
    fn delete_is_idempotent() {
        let store = memory_store();
        let (_, is_error) =
            run_delete_memory(&store, &json!({ "id": "never-existed", "intent": "t" }));
        assert!(!is_error);
    }

    #[tokio::test]
    async fn types_lists_distinct_kinds_with_counts() {
        let store = memory_store();
        run_write_memory(
            &store,
            &json!({ "title": "A", "body": "x", "type": "trap", "intent": "t" }),
        )
        .await;
        run_write_memory(
            &store,
            &json!({ "title": "B", "body": "y", "type": "trap", "intent": "t" }),
        )
        .await;
        let (content, is_error) = run_memory_types(&store);
        assert!(!is_error);
        assert_eq!(content, "trap: 2");
    }

    #[test]
    fn missing_required_fields_are_request_level_errors() {
        let store = memory_store();
        let (_, is_error) = run_read_memory(&store, &json!({ "intent": "t" }));
        assert!(is_error);
        let (_, is_error) = run_search_memory(&store, &json!({ "intent": "t" }));
        assert!(is_error);
        let (_, is_error) = run_delete_memory(&store, &json!({ "intent": "t" }));
        assert!(is_error);
    }
}
