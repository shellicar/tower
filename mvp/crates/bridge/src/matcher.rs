//! `Match`: the engine's first STAGE dispatching on stream type — a
//! `Stream::Files` filters by path, a `Stream::Lines` filters by content.
//! Standalone (until `Pipe` exists) it reads the named paths into `Line[]`
//! first (reusing `read::read_paths`) and filters by content — a structured
//! grep across named files. The dispatch itself (`match_stream`) is generic
//! over whichever stream arrives, which is what `Pipe` later calls
//! unchanged for a path-grain match too.

use serde_json::Value;

use crate::stream::Stream;

pub fn match_schema() -> Value {
    serde_json::json!({
        "name": "Match",
        "description": "Search the content of one or more files by regex, line by line \
            (a structured grep). Read-only, so no approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Paths to the files to search."
                },
                "pattern": {
                    "type": "string",
                    "description": "Regex to match against each line's content (Rust regex syntax)."
                }
            },
            "required": ["paths", "pattern"],
            "additionalProperties": false
        }
    })
}

/// Filter a stream by pattern, dispatching on its grain: `Files` matches
/// each path, `Lines` matches each line's content. The one function `Pipe`
/// calls later regardless of which stage produced the stream upstream.
pub fn match_stream(stream: &Stream, pattern: &regex::Regex) -> Stream {
    match stream {
        Stream::Files(files) => Stream::Files(
            files
                .iter()
                .filter(|f| pattern.is_match(&f.path))
                .cloned()
                .collect(),
        ),
        Stream::Lines(lines) => Stream::Lines(
            lines
                .iter()
                .filter(|l| pattern.is_match(&l.content))
                .cloned()
                .collect(),
        ),
    }
}

/// Run `Match` from its raw tool input: read the named paths into lines,
/// then filter by content. Returns the filtered stream plus whether any
/// path failed to read (item-level, same convention as `Read`).
pub async fn run_match(input: &Value) -> Result<(Stream, bool), String> {
    let paths: Vec<String> = input["paths"]
        .as_array()
        .ok_or("missing \"paths\"")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "\"paths\" must be an array of strings".to_string())
        })
        .collect::<Result<_, _>>()?;
    let pattern_str = input["pattern"].as_str().ok_or("missing \"pattern\"")?;
    let pattern = regex::Regex::new(pattern_str).map_err(|e| format!("invalid pattern: {e}"))?;
    let (lines, any_error) = crate::read::read_paths(&paths).await;
    let filtered = match_stream(&Stream::Lines(lines), &pattern);
    Ok((filtered, any_error))
}

#[cfg(test)]
mod tests {
    use super::{match_stream, run_match};
    use crate::stream::{FileEntry, LineEntry, Stream};
    use serde_json::json;

    fn scratch_file(name: &str, content: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bridge-match-test-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).expect("write scratch file");
        path
    }

    #[test]
    fn files_dispatch_matches_against_the_path() {
        let stream = Stream::Files(vec![
            FileEntry {
                path: "src/main.rs".into(),
            },
            FileEntry {
                path: "README.md".into(),
            },
        ]);
        let re = regex::Regex::new("\\.rs$").unwrap();
        let Stream::Files(out) = match_stream(&stream, &re) else {
            panic!("Files in, Files out")
        };
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "src/main.rs");
    }

    #[test]
    fn lines_dispatch_matches_against_the_content() {
        let stream = Stream::Lines(vec![
            LineEntry {
                path: "a.rs".into(),
                line: 1,
                content: "fn main() {}".into(),
            },
            LineEntry {
                path: "a.rs".into(),
                line: 2,
                content: "// a comment".into(),
            },
        ]);
        let re = regex::Regex::new("^fn ").unwrap();
        let Stream::Lines(out) = match_stream(&stream, &re) else {
            panic!("Lines in, Lines out")
        };
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].content, "fn main() {}");
    }

    #[tokio::test]
    async fn run_match_greps_named_files_by_content() {
        let path = scratch_file("a.txt", "keep this\nskip this\nkeep too");
        let (stream, any_error) =
            run_match(&json!({ "paths": [path.to_str().unwrap()], "pattern": "^keep" }))
                .await
                .unwrap();
        assert!(!any_error);
        let Stream::Lines(lines) = stream else {
            panic!("Match must produce a Lines stream in standalone mode")
        };
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.content.starts_with("keep")));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn an_invalid_pattern_is_a_request_level_error() {
        let err = run_match(&json!({ "paths": [], "pattern": "(" })).await;
        assert!(err.is_err());
    }
}
