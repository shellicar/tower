//! `EditFile`: content-anchored line and text edits, written to disk, a
//! line-numbered diff returned. Ported faithfully from claude-cli's own
//! `EditFile.ts` (packages/claude-sdk-tools/src/EditFile/) \u2014 same schema,
//! same bottom-to-top ordering, same negative-`after_line` resolution, same
//! diff numbering convention. The complex one of the mutation family, its
//! own commit.

use serde_json::{Value, json};

pub fn edit_file_schema() -> Value {
    json!({
        "name": "EditFile",
        "description": "Edit a file: apply line and text edits, write the result to disk, \
            and return a line-numbered diff.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to edit." },
                "lineEdits": {
                    "type": "array",
                    "description": "Structural edits by line number (insert / replace / \
                        delete). Applied bottom-to-top so all line numbers refer to the file \
                        as it exists before this call — no offset calculation needed. If two \
                        edits target the same lines, an error is thrown.",
                    "items": {
                        "oneOf": [
                            {
                                "properties": {
                                    "action": { "const": "replace" },
                                    "startLine": { "type": "integer", "minimum": 1 },
                                    "endLine": { "type": "integer", "minimum": 1 },
                                    "content": { "type": "string" }
                                },
                                "required": ["action", "startLine", "endLine", "content"]
                            },
                            {
                                "properties": {
                                    "action": { "const": "delete" },
                                    "startLine": { "type": "integer", "minimum": 1 },
                                    "endLine": { "type": "integer", "minimum": 1 }
                                },
                                "required": ["action", "startLine", "endLine"]
                            },
                            {
                                "properties": {
                                    "action": { "const": "insert" },
                                    "after_line": {
                                        "type": "integer",
                                        "description": "1-based line number to insert after. 0 \
                                            inserts at the top of the file. Negative counts back \
                                            from the end (-1 = after the last line, -2 = after \
                                            the second-last), so appending does not require \
                                            knowing the line count."
                                    },
                                    "content": { "type": "string" }
                                },
                                "required": ["action", "after_line", "content"]
                            }
                        ]
                    }
                },
                "textEdits": {
                    "type": "array",
                    "description": "Text-search edits (replace_text / regex_text). Applied in \
                        order after all lineEdits.",
                    "items": {
                        "oneOf": [
                            {
                                "properties": {
                                    "action": { "const": "replace_text" },
                                    "oldString": { "type": "string", "description": "String to search for" },
                                    "replacement": { "type": "string" },
                                    "replaceMultiple": {
                                        "type": "boolean",
                                        "default": false,
                                        "description": "If true, replace all matches. If false \
                                            (default), error if more than one match is found."
                                    }
                                },
                                "required": ["action", "oldString", "replacement"]
                            },
                            {
                                "properties": {
                                    "action": { "const": "regex_text" },
                                    "pattern": { "type": "string", "description": "Find text to replace" },
                                    "replacement": {
                                        "type": "string",
                                        "description": "Replacement string. Supports capture \
                                            groups ($1, $2), $& (matched text), $$ (literal $)."
                                    },
                                    "replaceMultiple": {
                                        "type": "boolean",
                                        "default": false,
                                        "description": "If true, replace all matches. If false \
                                            (default), error if more than one match is found."
                                    }
                                },
                                "required": ["action", "pattern", "replacement"]
                            }
                        ]
                    }
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

#[derive(Debug, Clone)]
enum LineEdit {
    Replace {
        start_line: i64,
        end_line: i64,
        content: String,
    },
    Delete {
        start_line: i64,
        end_line: i64,
    },
    Insert {
        after_line: i64,
        content: String,
    },
}

#[derive(Debug, Clone)]
enum TextEdit {
    ReplaceText {
        old_string: String,
        replacement: String,
        replace_multiple: bool,
    },
    RegexText {
        pattern: String,
        replacement: String,
        replace_multiple: bool,
    },
}

fn parse_line_edits(input: &Value) -> Result<Vec<LineEdit>, String> {
    let Some(arr) = input.get("lineEdits").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    arr.iter()
        .map(|e| match e["action"].as_str() {
            Some("replace") => Ok(LineEdit::Replace {
                start_line: e["startLine"]
                    .as_i64()
                    .ok_or("replace missing \"startLine\"")?,
                end_line: e["endLine"].as_i64().ok_or("replace missing \"endLine\"")?,
                content: e["content"]
                    .as_str()
                    .ok_or("replace missing \"content\"")?
                    .to_string(),
            }),
            Some("delete") => Ok(LineEdit::Delete {
                start_line: e["startLine"]
                    .as_i64()
                    .ok_or("delete missing \"startLine\"")?,
                end_line: e["endLine"].as_i64().ok_or("delete missing \"endLine\"")?,
            }),
            Some("insert") => Ok(LineEdit::Insert {
                after_line: e["after_line"]
                    .as_i64()
                    .ok_or("insert missing \"after_line\"")?,
                content: e["content"]
                    .as_str()
                    .ok_or("insert missing \"content\"")?
                    .to_string(),
            }),
            other => Err(format!("unknown lineEdits action {other:?}")),
        })
        .collect()
}

fn parse_text_edits(input: &Value) -> Result<Vec<TextEdit>, String> {
    let Some(arr) = input.get("textEdits").and_then(Value::as_array) else {
        return Ok(Vec::new());
    };
    arr.iter()
        .map(|e| match e["action"].as_str() {
            Some("replace_text") => Ok(TextEdit::ReplaceText {
                old_string: e["oldString"]
                    .as_str()
                    .ok_or("replace_text missing \"oldString\"")?
                    .to_string(),
                replacement: e["replacement"]
                    .as_str()
                    .ok_or("replace_text missing \"replacement\"")?
                    .to_string(),
                replace_multiple: e["replaceMultiple"].as_bool().unwrap_or(false),
            }),
            Some("regex_text") => Ok(TextEdit::RegexText {
                pattern: e["pattern"]
                    .as_str()
                    .ok_or("regex_text missing \"pattern\"")?
                    .to_string(),
                replacement: e["replacement"]
                    .as_str()
                    .ok_or("regex_text missing \"replacement\"")?
                    .to_string(),
                replace_multiple: e["replaceMultiple"].as_bool().unwrap_or(false),
            }),
            other => Err(format!("unknown textEdits action {other:?}")),
        })
        .collect()
}

/// Resolves a possibly-negative after_line against the file's line count,
/// Python-index style: -1 is after the last line, -2 after the second-last.
/// Matches Read's own line count, including a trailing blank line from a
/// trailing newline \u2014 Read numbers that blank as a real line, so -1 lands
/// after it here too.
fn resolve_after_line(after_line: i64, total: usize) -> Result<usize, String> {
    let resolved = if after_line < 0 {
        total as i64 + after_line + 1
    } else {
        after_line
    };
    if resolved < 0 || resolved as usize > total {
        return Err(format!(
            "insert after_line {after_line} out of bounds (file has {total} lines)"
        ));
    }
    Ok(resolved as usize)
}

fn line_key(total: usize, edit: &LineEdit) -> Result<usize, String> {
    match edit {
        LineEdit::Insert { after_line, .. } => resolve_after_line(*after_line, total),
        LineEdit::Replace { start_line, .. } | LineEdit::Delete { start_line, .. } => {
            Ok((*start_line).max(0) as usize)
        }
    }
}

/// Bottom-to-top: highest position first, so applying edits in this order
/// never invalidates a lower edit's line numbers \u2014 no offset math needed.
fn sort_bottom_to_top(total: usize, edits: Vec<LineEdit>) -> Result<Vec<LineEdit>, String> {
    let mut keyed: Vec<(usize, LineEdit)> = edits
        .into_iter()
        .map(|e| line_key(total, &e).map(|k| (k, e)))
        .collect::<Result<_, _>>()?;
    keyed.sort_by_key(|(k, _)| std::cmp::Reverse(*k));
    Ok(keyed.into_iter().map(|(_, e)| e).collect())
}

/// All line numbers refer to the same original file, so overlapping ranges
/// (post-resolution) indicate conflicting edits with no well-defined result.
fn validate_line_edits(total: usize, edits: &[LineEdit]) -> Result<(), String> {
    for edit in edits {
        match edit {
            LineEdit::Insert { after_line, .. } => {
                resolve_after_line(*after_line, total)?;
            }
            LineEdit::Replace {
                start_line,
                end_line,
                ..
            }
            | LineEdit::Delete {
                start_line,
                end_line,
            } => {
                let (start_line, end_line) = (*start_line, *end_line);
                let action = if matches!(edit, LineEdit::Replace { .. }) {
                    "replace"
                } else {
                    "delete"
                };
                if start_line as usize > total {
                    return Err(format!(
                        "{action} startLine {start_line} out of bounds (file has {total} lines)"
                    ));
                }
                if end_line as usize > total {
                    return Err(format!(
                        "{action} endLine {end_line} out of bounds (file has {total} lines)"
                    ));
                }
                if start_line > end_line {
                    return Err(format!(
                        "{action} startLine {start_line} is greater than endLine {end_line}"
                    ));
                }
            }
        }
    }
    let ranges: Vec<(usize, usize)> = edits
        .iter()
        .map(|e| match e {
            LineEdit::Insert { after_line, .. } => {
                let p = resolve_after_line(*after_line, total).expect("validated above");
                (p, p)
            }
            LineEdit::Replace {
                start_line,
                end_line,
                ..
            }
            | LineEdit::Delete {
                start_line,
                end_line,
            } => (*start_line as usize, *end_line as usize),
        })
        .collect();
    for i in 0..ranges.len() {
        for j in (i + 1)..ranges.len() {
            let (a_start, a_end) = ranges[i];
            let (b_start, b_end) = ranges[j];
            if a_start <= b_end && b_start <= a_end {
                return Err(format!(
                    "line edits overlap: edit at {a_start}–{a_end} and edit at {b_start}–{b_end} target the same lines"
                ));
            }
        }
    }
    Ok(())
}

fn apply_line_edits(lines: Vec<String>, edits: &[LineEdit]) -> Vec<String> {
    let mut result = lines;
    let total = result.len();
    for edit in edits {
        match edit {
            LineEdit::Replace {
                start_line,
                end_line,
                content,
            } => {
                let start = (*start_line as usize) - 1;
                let end = *end_line as usize;
                result.splice(start..end, content.split('\n').map(str::to_string));
            }
            LineEdit::Delete {
                start_line,
                end_line,
            } => {
                let start = (*start_line as usize) - 1;
                let end = *end_line as usize;
                result.splice(start..end, std::iter::empty());
            }
            LineEdit::Insert {
                after_line,
                content,
            } => {
                let pos = resolve_after_line(*after_line, total).expect("validated already");
                result.splice(pos..pos, content.split('\n').map(str::to_string));
            }
        }
    }
    result
}

fn count_occurrences(content: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    content.matches(needle).count()
}

fn apply_text_edits(content: String, edits: &[TextEdit], offset: usize) -> Result<String, String> {
    let mut current = content;
    for (i, edit) in edits.iter().enumerate() {
        current = match edit {
            TextEdit::ReplaceText {
                old_string,
                replacement,
                replace_multiple,
            } => {
                let count = count_occurrences(&current, old_string);
                if count == 0 {
                    return Err(format!(
                        "textEdits[{}] replace_text: {old_string:?} not found in file",
                        i + offset
                    ));
                }
                if count > 1 && !replace_multiple {
                    return Err(format!(
                        "textEdits[{}] replace_text: {old_string:?} matched {count} times — set replaceMultiple: true to replace all",
                        i + offset
                    ));
                }
                if *replace_multiple {
                    current.replace(old_string.as_str(), replacement)
                } else {
                    current.replacen(old_string.as_str(), replacement, 1)
                }
            }
            TextEdit::RegexText {
                pattern,
                replacement,
                replace_multiple,
            } => {
                let re = regex::Regex::new(pattern).map_err(|e| {
                    format!("textEdits[{}] regex_text: invalid pattern: {e}", i + offset)
                })?;
                let count = re.find_iter(&current).count();
                if count == 0 {
                    return Err(format!(
                        "textEdits[{}] regex_text: pattern {pattern:?} not found in file",
                        i + offset
                    ));
                }
                if count > 1 && !replace_multiple {
                    return Err(format!(
                        "textEdits[{}] regex_text: pattern {pattern:?} matched {count} times — set replaceMultiple: true to replace all",
                        i + offset
                    ));
                }
                // Rust's regex replacement syntax matches JS's ($1, $$) except
                // JS also accepts $& for the whole match; Rust spells that $0.
                let replacement = replacement.replace("$&", "$0");
                if *replace_multiple {
                    re.replace_all(&current, replacement.as_str()).into_owned()
                } else {
                    re.replace(&current, replacement.as_str()).into_owned()
                }
            }
        };
    }
    Ok(current)
}

const DIFF_CONTEXT: usize = 3;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Ctx,
    Add,
    Del,
}

struct Entry {
    kind: Kind,
    num: usize,
    text: String,
}

/// Renders a diff as plain text, one line per source line, numbered against
/// the resulting (new) file's line numbers for changed/context lines and the
/// original file's for removed lines \u2014 so a caller can read a changed
/// line's number straight off the output and use it in a follow-up edit,
/// the same way Read/Match number lines.
fn generate_diff(original: &str, new: &str) -> String {
    let diff = similar::TextDiff::from_lines(original, new);
    let mut entries = Vec::new();
    for change in diff.iter_all_changes() {
        let text = change.value().trim_end_matches('\n').to_string();
        match change.tag() {
            similar::ChangeTag::Delete => entries.push(Entry {
                kind: Kind::Del,
                num: change.old_index().expect("delete has an old index") + 1,
                text,
            }),
            similar::ChangeTag::Insert => entries.push(Entry {
                kind: Kind::Add,
                num: change.new_index().expect("insert has a new index") + 1,
                text,
            }),
            similar::ChangeTag::Equal => entries.push(Entry {
                kind: Kind::Ctx,
                num: change.new_index().expect("equal has a new index") + 1,
                text,
            }),
        }
    }
    trim_context(&entries)
}

/// Collapses runs of unchanged context beyond `DIFF_CONTEXT` lines from the
/// nearest change into a single "\u2026" marker, unified-diff style, so an edit
/// deep in a large file doesn't dump the whole file back.
fn trim_context(entries: &[Entry]) -> String {
    let n = entries.len();
    let mut keep = vec![false; n];
    for (i, entry) in entries.iter().enumerate() {
        if entry.kind != Kind::Ctx {
            let start = i.saturating_sub(DIFF_CONTEXT);
            let end = (i + DIFF_CONTEXT).min(n.saturating_sub(1));
            for slot in keep.iter_mut().take(end + 1).skip(start) {
                *slot = true;
            }
        }
    }
    let mut out = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        if keep[i] {
            let prefix = match entry.kind {
                Kind::Add => "+",
                Kind::Del => "-",
                Kind::Ctx => " ",
            };
            out.push(format!("{prefix}{}:{}", entry.num, entry.text));
        } else if i > 0 && keep[i - 1] {
            out.push("\u{2026}".to_string());
        }
    }
    out.join("\n")
}

/// Run `EditFile`: read, apply lineEdits then textEdits, diff, write \u2014 gated
/// behind human approval by the caller, same as every other mutation.
pub async fn run_edit_file(input: &Value) -> (String, bool) {
    let Some(path) = input["path"].as_str() else {
        return ("missing \"path\"".to_string(), true);
    };
    let line_edits = match parse_line_edits(input) {
        Ok(e) => e,
        Err(e) => return (e, true),
    };
    let text_edits = match parse_text_edits(input) {
        Ok(e) => e,
        Err(e) => return (e, true),
    };
    if line_edits.is_empty() && text_edits.is_empty() {
        return (
            "at least one edit must be provided (lineEdits or textEdits)".to_string(),
            true,
        );
    }

    let base_content = match tokio::fs::read_to_string(path).await {
        Ok(c) => c,
        Err(e) => return (format!("failed to read {path}: {e}"), true),
    };
    // ''.split('\n') yields [''] — one phantom line, not zero — which would
    // make an empty file resolve after_line against a 1-line file instead
    // of a 0-line one.
    let base_lines: Vec<String> = if base_content.is_empty() {
        Vec::new()
    } else {
        base_content.split('\n').map(str::to_string).collect()
    };

    let sorted = match sort_bottom_to_top(base_lines.len(), line_edits.clone()) {
        Ok(s) => s,
        Err(e) => return (e, true),
    };
    if let Err(e) = validate_line_edits(base_lines.len(), &sorted) {
        return (e, true);
    }
    let after_line_edits = apply_line_edits(base_lines, &sorted);
    let new_content = match apply_text_edits(after_line_edits.join("\n"), &text_edits, 0) {
        Ok(c) => c,
        Err(e) => return (e, true),
    };

    let diff = generate_diff(&base_content, &new_content);
    if let Err(e) = tokio::fs::write(path, &new_content).await {
        return (
            format!("edits computed but failed to write {path}: {e}"),
            true,
        );
    }
    (diff, false)
}

#[cfg(test)]
mod tests {
    use super::run_edit_file;
    use serde_json::json;

    fn scratch(content: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bridge-editfile-test-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).unwrap();
        path
    }

    async fn read(path: &std::path::Path) -> String {
        tokio::fs::read_to_string(path).await.unwrap()
    }

    #[tokio::test]
    async fn writes_the_edited_content_to_disk() {
        let path = scratch("one\ntwo\nthree");
        let (_, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "replace", "startLine": 2, "endLine": 2, "content": "TWO" }]
        }))
        .await;
        assert!(!is_error);
        assert_eq!(read(&path).await, "one\nTWO\nthree");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn numbers_a_changed_and_removed_line_correctly() {
        let path = scratch("one\ntwo\nthree");
        let (diff, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "replace", "startLine": 2, "endLine": 2, "content": "TWO" }]
        }))
        .await;
        assert!(!is_error);
        assert!(diff.contains("+2:TWO"), "{diff}");
        assert!(diff.contains("-2:two"), "{diff}");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn insert_after_a_line() {
        let path = scratch("one\ntwo");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": 1, "content": "inserted" }]
        }))
        .await;
        assert_eq!(read(&path).await, "one\ninserted\ntwo");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn insert_at_top_when_after_line_is_zero() {
        let path = scratch("one\ntwo");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": 0, "content": "top" }]
        }))
        .await;
        assert_eq!(read(&path).await, "top\none\ntwo");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn insert_after_last_line_when_after_line_is_negative_one() {
        let path = scratch("one\ntwo");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": -1, "content": "appended" }]
        }))
        .await;
        assert_eq!(read(&path).await, "one\ntwo\nappended");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn insert_before_last_line_when_after_line_is_negative_two() {
        let path = scratch("one\ntwo\nthree");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": -2, "content": "middle" }]
        }))
        .await;
        assert_eq!(read(&path).await, "one\ntwo\nmiddle\nthree");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn negative_after_line_out_of_bounds_errors() {
        let path = scratch("one\ntwo");
        let (content, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": -5, "content": "x" }]
        }))
        .await;
        assert!(is_error);
        assert!(content.contains("out of bounds"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn appends_to_an_empty_file_without_a_spurious_blank_line() {
        let path = scratch("");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": -1, "content": "new content" }]
        }))
        .await;
        assert_eq!(read(&path).await, "new content");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn appends_after_a_trailing_blank_line_like_read_numbers_it() {
        let path = scratch("one\ntwo\n");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": -1, "content": "three" }]
        }))
        .await;
        assert_eq!(read(&path).await, "one\ntwo\n\nthree");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn delete_removes_the_line_range() {
        let path = scratch("one\ntwo\nthree");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "delete", "startLine": 2, "endLine": 2 }]
        }))
        .await;
        assert_eq!(read(&path).await, "one\nthree");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn out_of_bounds_start_line_errors() {
        let path = scratch("one\ntwo");
        let (content, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "delete", "startLine": 5, "endLine": 5 }]
        }))
        .await;
        assert!(is_error);
        assert!(content.contains("out of bounds"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn start_line_greater_than_end_line_errors() {
        let path = scratch("one\ntwo\nthree");
        let (content, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "delete", "startLine": 3, "endLine": 1 }]
        }))
        .await;
        assert!(is_error);
        assert!(content.contains("greater than endLine"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn overlapping_edits_error() {
        let path = scratch("one\ntwo\nthree");
        let (content, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [
                { "action": "delete", "startLine": 1, "endLine": 2 },
                { "action": "replace", "startLine": 2, "endLine": 3, "content": "x" }
            ]
        }))
        .await;
        assert!(is_error);
        assert!(content.contains("overlap"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn multiple_non_overlapping_edits_apply_bottom_to_top() {
        let path = scratch("one\ntwo\nthree\nfour");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [
                { "action": "delete", "startLine": 1, "endLine": 1 },
                { "action": "replace", "startLine": 3, "endLine": 3, "content": "THREE" }
            ]
        }))
        .await;
        assert_eq!(read(&path).await, "two\nTHREE\nfour");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn replace_text_replaces_a_literal_string() {
        let path = scratch("const x = 1;");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "textEdits": [{ "action": "replace_text", "oldString": "const x", "replacement": "let x" }]
        }))
        .await;
        assert_eq!(read(&path).await, "let x = 1;");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn replace_text_treats_replacement_as_literal_not_a_dollar_pattern() {
        let path = scratch("foo");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "textEdits": [{ "action": "replace_text", "oldString": "foo", "replacement": "$&$1" }]
        }))
        .await;
        assert_eq!(read(&path).await, "$&$1");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn replace_text_treats_search_string_as_literal_not_regex() {
        let path = scratch("a.b.c");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "textEdits": [{ "action": "replace_text", "oldString": "a.b", "replacement": "X" }]
        }))
        .await;
        assert_eq!(read(&path).await, "X.c");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn replace_text_not_found_errors() {
        let path = scratch("foo");
        let (content, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "textEdits": [{ "action": "replace_text", "oldString": "missing", "replacement": "x" }]
        }))
        .await;
        assert!(is_error);
        assert!(content.contains("not found"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn replace_text_multiple_matches_without_flag_errors() {
        let path = scratch("foo foo");
        let (content, is_error) = run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "textEdits": [{ "action": "replace_text", "oldString": "foo", "replacement": "x" }]
        }))
        .await;
        assert!(is_error);
        assert!(content.contains("matched 2 times"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn replace_multiple_replaces_every_match() {
        let path = scratch("foo foo");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "textEdits": [{ "action": "replace_text", "oldString": "foo", "replacement": "x", "replaceMultiple": true }]
        }))
        .await;
        assert_eq!(read(&path).await, "x x");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn regex_text_replaces_using_a_pattern() {
        let path = scratch("import type { Foo }");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "textEdits": [{ "action": "regex_text", "pattern": "import type \\{ (\\w+) \\}", "replacement": "import { $1 }" }]
        }))
        .await;
        assert_eq!(read(&path).await, "import { Foo }");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn line_edits_apply_before_text_edits() {
        let path = scratch("oldCall()\nkeep");
        run_edit_file(&json!({
            "path": path.to_str().unwrap(),
            "lineEdits": [{ "action": "insert", "after_line": -1, "content": "function helper() {}" }],
            "textEdits": [{ "action": "replace_text", "oldString": "oldCall()", "replacement": "helper()" }]
        }))
        .await;
        assert_eq!(read(&path).await, "helper()\nkeep\nfunction helper() {}");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn neither_line_edits_nor_text_edits_is_an_error() {
        let path = scratch("foo");
        let (content, is_error) = run_edit_file(&json!({ "path": path.to_str().unwrap() })).await;
        assert!(is_error);
        assert!(content.contains("at least one edit"));
        std::fs::remove_file(&path).ok();
    }
}
