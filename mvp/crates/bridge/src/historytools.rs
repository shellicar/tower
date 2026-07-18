//! `SearchHistory`/`ReadHistory`: the model-facing read seam over the shared
//! history index (history.rs). Ported from packages/claude-sdk-tools/src/
//! History/History.ts \u2014 same field names (`session`, not `conversationId`,
//! on output), same citation shape. Both read-only: no approval gate.
//!
//! Simplified from the reference: `since`/`until` take plain ISO-8601
//! instants here, not the CLI's relative-span grammar (`7d`, `2w`, `3m`,
//! `1y`) resolved through a timezone-aware clock (js-joda) \u2014 that date-
//! arithmetic machinery isn't ported. `includeCurrentSession`/
//! `currentSessionId` is likewise simplified to a direct
//! `excludeConversationId` field the caller sets itself.

use serde_json::{Value, json};

use crate::history::{HistoryStore, SearchFilters};

pub fn search_history_schema() -> Value {
    json!({
        "name": "SearchHistory",
        "description": "Search your past conversations by relevance and get back ranked, \
            cited snippets. A citation is a session id plus a turn id; pass one (or several) \
            to ReadHistory to open the full exchange around it. Thinking is indexed and ranks \
            on par with prose. Read-only, so no approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Terms to search across your past conversations." },
                "role": {
                    "type": "string",
                    "enum": ["user", "assistant"],
                    "description": "Narrow to one side: your messages or the assistant's."
                },
                "type": {
                    "type": "string",
                    "enum": ["text", "thinking", "tool_use", "tool_result"],
                    "description": "Narrow to one kind of event."
                },
                "since": {
                    "type": "string",
                    "description": "Lower bound, inclusive. ISO-8601 instant, e.g. 2026-06-01T00:00:00.000Z."
                },
                "until": {
                    "type": "string",
                    "description": "Upper bound, inclusive. ISO-8601 instant."
                },
                "limit": { "type": "integer", "description": "Maximum hits to return. Default 10." },
                "excludeConversationId": {
                    "type": "string",
                    "description": "Drop one conversation from the results, e.g. the live one."
                }
            },
            "required": ["query"],
            "additionalProperties": false
        }
    })
}

pub fn read_history_schema() -> Value {
    json!({
        "name": "ReadHistory",
        "description": "Open the full exchange around one or more search citations. Each \
            citation is a { session, turnId } from a SearchHistory hit; `window` sets how many \
            turns either side of each centre to include. Read-only, so no approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "citations": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "session": { "type": "string", "description": "Session id from a search hit." },
                            "turnId": { "type": "string", "description": "Turn id from a search hit; the centre of the window." }
                        },
                        "required": ["session", "turnId"],
                        "additionalProperties": false
                    },
                    "description": "One or more moments to open."
                },
                "window": {
                    "type": "integer",
                    "description": "Turns to include either side of each centre. Default 3."
                }
            },
            "required": ["citations"],
            "additionalProperties": false
        }
    })
}

pub fn run_search_history(store: &HistoryStore, input: &Value) -> (String, bool) {
    let Some(query) = input["query"].as_str() else {
        return ("missing \"query\"".to_string(), true);
    };
    let filters = SearchFilters {
        role: input["role"].as_str(),
        kind: input["type"].as_str(),
        since: input["since"].as_str(),
        until: input["until"].as_str(),
        exclude_conversation_id: input["excludeConversationId"].as_str(),
    };
    let limit = input["limit"].as_i64().unwrap_or(10);
    match crate::history::search(store, query, &filters, limit) {
        Ok(hits) if hits.is_empty() => ("no history matched".to_string(), false),
        Ok(hits) => {
            let text = hits
                .iter()
                .enumerate()
                .map(|(i, hit)| {
                    format!(
                        "[{}] score {:.2} — session {} turn {} at {} ({}, {})\n  {}",
                        i + 1,
                        hit.score,
                        hit.conversation_id,
                        hit.turn_id,
                        hit.timestamp,
                        hit.role,
                        hit.kind,
                        hit.snippet
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            (text, false)
        }
        Err(e) => (e, true),
    }
}

pub fn run_read_history(store: &HistoryStore, input: &Value) -> (String, bool) {
    let Some(citations) = input["citations"].as_array() else {
        return ("missing \"citations\"".to_string(), true);
    };
    if citations.is_empty() {
        return (
            "\"citations\" must have at least one item".to_string(),
            true,
        );
    }
    let window = input["window"].as_i64().unwrap_or(3);
    let mut out = Vec::new();
    for citation in citations {
        let (Some(session), Some(turn_id)) =
            (citation["session"].as_str(), citation["turnId"].as_str())
        else {
            return (
                "each citation needs \"session\" and \"turnId\"".to_string(),
                true,
            );
        };
        match crate::history::read(store, session, turn_id, window) {
            Ok(events) if events.is_empty() => {
                out.push(format!("session {session} turn {turn_id}: no events found"));
            }
            Ok(events) => {
                let body = events
                    .iter()
                    .map(|e| {
                        format!(
                            "  [{}] {} ({}, {}): {}",
                            e.turn_id, e.timestamp, e.role, e.kind, e.text
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                out.push(format!("session {session} turn {turn_id}:\n{body}"));
            }
            Err(e) => return (e, true),
        }
    }
    (out.join("\n\n"), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{self, HistoryBlock, HistoryMessage, Role};
    use rusqlite::Connection;
    use std::sync::{Arc, Mutex};

    fn history_store() -> HistoryStore {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
            .unwrap();
        history::migrate(&conn).unwrap();
        Arc::new(Mutex::new(conn))
    }

    fn seed(store: &HistoryStore, id: &str, conv: &str, turn: &str, role: Role, text: &str) {
        history::insert(
            store,
            &HistoryMessage {
                id: id.into(),
                conversation_id: conv.into(),
                turn_id: turn.into(),
                query_id: "q1".into(),
                timestamp: "2026-01-01T00:00:00.000Z".into(),
                role,
                blocks: vec![HistoryBlock {
                    seq: 0,
                    kind: "text".into(),
                    text: Some(text.into()),
                }],
            },
        )
        .unwrap();
    }

    #[test]
    fn search_finds_a_seeded_message() {
        let store = history_store();
        seed(
            &store,
            "m1",
            "c1",
            "t1",
            Role::User,
            "the sqlite migration failed without warning",
        );
        let (content, is_error) = run_search_history(&store, &json!({ "query": "migration" }));
        assert!(!is_error);
        assert!(content.contains("c1"));
        assert!(content.contains("t1"));
    }

    #[test]
    fn search_with_no_matches_is_not_an_error() {
        let store = history_store();
        let (content, is_error) =
            run_search_history(&store, &json!({ "query": "nothing at all here" }));
        assert!(!is_error);
        assert_eq!(content, "no history matched");
    }

    #[test]
    fn search_missing_query_is_a_request_level_error() {
        let store = history_store();
        let (_, is_error) = run_search_history(&store, &json!({}));
        assert!(is_error);
    }

    #[test]
    fn read_opens_the_window_around_a_citation() {
        let store = history_store();
        seed(&store, "m1", "c1", "t1", Role::User, "hello");
        let (content, is_error) = run_read_history(
            &store,
            &json!({ "citations": [{ "session": "c1", "turnId": "t1" }] }),
        );
        assert!(!is_error);
        assert!(content.contains("hello"));
    }

    #[test]
    fn read_with_no_citations_is_a_request_level_error() {
        let store = history_store();
        let (_, is_error) = run_read_history(&store, &json!({ "citations": [] }));
        assert!(is_error);
    }

    #[test]
    fn read_an_unknown_citation_reports_no_events_not_an_error() {
        let store = history_store();
        let (content, is_error) = run_read_history(
            &store,
            &json!({ "citations": [{ "session": "nope", "turnId": "nope" }] }),
        );
        assert!(!is_error);
        assert!(content.contains("no events found"));
    }
}
