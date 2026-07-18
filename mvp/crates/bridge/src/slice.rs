//! `Head`/`Tail`/`Range`: three thin position-slicing STAGEs sharing one
//! grain-aware helper each — the same two-grain dispatch shape as `Match`,
//! applied to position instead of pattern. Standalone (until `Pipe`) each
//! reads the named paths into `Line[]` first, mirroring `Match`'s standalone
//! mode; `Pipe` later calls the three `_stream` functions unchanged
//! regardless of which stage produced the stream upstream.

use serde_json::Value;

use crate::stream::Stream;

pub fn head_schema() -> Value {
    serde_json::json!({
        "name": "Head",
        "description": "The first N lines of one or more files. Read-only, so no \
            approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Paths to the files to read."
                },
                "count": { "type": "integer", "description": "How many lines to take." }
            },
            "required": ["paths", "count"],
            "additionalProperties": false
        }
    })
}

pub fn tail_schema() -> Value {
    serde_json::json!({
        "name": "Tail",
        "description": "The last N lines of one or more files. Read-only, so no \
            approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Paths to the files to read."
                },
                "count": { "type": "integer", "description": "How many lines to take." }
            },
            "required": ["paths", "count"],
            "additionalProperties": false
        }
    })
}

pub fn range_schema() -> Value {
    serde_json::json!({
        "name": "Range",
        "description": "Lines `start` through `end` (1-based, inclusive) of one or more \
            files. Read-only, so no approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Paths to the files to read."
                },
                "start": { "type": "integer", "description": "First line, 1-based." },
                "end": { "type": "integer", "description": "Last line, 1-based, inclusive." }
            },
            "required": ["paths", "start", "end"],
            "additionalProperties": false
        }
    })
}

/// Slice a stream to its first `count` items, grain-agnostic \u2014 the shared
/// helper `Pipe` calls later regardless of upstream grain.
pub fn head_stream(stream: &Stream, count: usize) -> Stream {
    match stream {
        Stream::Files(v) => Stream::Files(v.iter().take(count).cloned().collect()),
        Stream::Lines(v) => Stream::Lines(v.iter().take(count).cloned().collect()),
    }
}

/// Slice a stream to its last `count` items, grain-agnostic.
pub fn tail_stream(stream: &Stream, count: usize) -> Stream {
    match stream {
        Stream::Files(v) => Stream::Files(tail_of(v, count)),
        Stream::Lines(v) => Stream::Lines(tail_of(v, count)),
    }
}

fn tail_of<T: Clone>(v: &[T], count: usize) -> Vec<T> {
    let start = v.len().saturating_sub(count);
    v[start..].to_vec()
}

/// Slice a stream to the 1-based inclusive position range `[start, end]`,
/// grain-agnostic. Out of range (start 0, start past the end, or an empty
/// span) is an empty result, never an error \u2014 a position range is never
/// invalid input, just sometimes vacuous.
pub fn range_stream(stream: &Stream, start: usize, end: usize) -> Stream {
    match stream {
        Stream::Files(v) => Stream::Files(range_of(v, start, end)),
        Stream::Lines(v) => Stream::Lines(range_of(v, start, end)),
    }
}

fn range_of<T: Clone>(v: &[T], start: usize, end: usize) -> Vec<T> {
    if start == 0 || start > v.len() {
        return Vec::new();
    }
    let s = start - 1;
    let e = end.min(v.len());
    if s >= e { Vec::new() } else { v[s..e].to_vec() }
}

fn parse_paths(input: &Value) -> Result<Vec<String>, String> {
    input["paths"]
        .as_array()
        .ok_or("missing \"paths\"")?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| "\"paths\" must be an array of strings".to_string())
        })
        .collect()
}

/// Standalone mode's source: read the named paths into a `Lines` stream, the
/// same convention `Match` uses.
async fn source(paths: &[String]) -> (Stream, bool) {
    let (lines, any_error) = crate::read::read_paths(paths).await;
    (Stream::Lines(lines), any_error)
}

pub async fn run_head(input: &Value) -> Result<(Stream, bool), String> {
    let paths = parse_paths(input)?;
    let count = input["count"].as_u64().ok_or("missing \"count\"")? as usize;
    let (stream, any_error) = source(&paths).await;
    Ok((head_stream(&stream, count), any_error))
}

pub async fn run_tail(input: &Value) -> Result<(Stream, bool), String> {
    let paths = parse_paths(input)?;
    let count = input["count"].as_u64().ok_or("missing \"count\"")? as usize;
    let (stream, any_error) = source(&paths).await;
    Ok((tail_stream(&stream, count), any_error))
}

pub async fn run_range(input: &Value) -> Result<(Stream, bool), String> {
    let paths = parse_paths(input)?;
    let start = input["start"].as_u64().ok_or("missing \"start\"")? as usize;
    let end = input["end"].as_u64().ok_or("missing \"end\"")? as usize;
    let (stream, any_error) = source(&paths).await;
    Ok((range_stream(&stream, start, end), any_error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::{FileEntry, LineEntry};
    use serde_json::json;

    fn scratch_file(name: &str, content: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bridge-slice-test-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).expect("write scratch file");
        path
    }

    fn files(n: usize) -> Stream {
        Stream::Files(
            (1..=n)
                .map(|i| FileEntry {
                    path: format!("f{i}"),
                })
                .collect(),
        )
    }

    fn lines(n: usize) -> Stream {
        Stream::Lines(
            (1..=n)
                .map(|i| LineEntry {
                    path: "a".into(),
                    line: i,
                    content: format!("l{i}"),
                })
                .collect(),
        )
    }

    #[test]
    fn head_takes_the_first_n_regardless_of_grain() {
        let Stream::Files(out) = head_stream(&files(5), 2) else {
            panic!()
        };
        assert_eq!(
            out.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["f1", "f2"]
        );
        let Stream::Lines(out) = head_stream(&lines(5), 2) else {
            panic!()
        };
        assert_eq!(out.iter().map(|l| l.line).collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn tail_takes_the_last_n_regardless_of_grain() {
        let Stream::Files(out) = tail_stream(&files(5), 2) else {
            panic!()
        };
        assert_eq!(
            out.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["f4", "f5"]
        );
    }

    #[test]
    fn tail_count_larger_than_the_stream_returns_everything() {
        let Stream::Lines(out) = tail_stream(&lines(3), 100) else {
            panic!()
        };
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn range_is_one_based_inclusive() {
        let Stream::Lines(out) = range_stream(&lines(5), 2, 4) else {
            panic!()
        };
        assert_eq!(out.iter().map(|l| l.line).collect::<Vec<_>>(), [2, 3, 4]);
    }

    #[test]
    fn range_out_of_bounds_is_empty_not_an_error() {
        let Stream::Lines(out) = range_stream(&lines(3), 10, 20) else {
            panic!()
        };
        assert!(out.is_empty());
        let Stream::Lines(out) = range_stream(&lines(3), 0, 2) else {
            panic!()
        };
        assert!(out.is_empty());
    }

    #[tokio::test]
    async fn run_head_reads_named_files_and_takes_the_first_lines() {
        let path = scratch_file("a.txt", "one\ntwo\nthree");
        let (stream, any_error) =
            run_head(&json!({ "paths": [path.to_str().unwrap()], "count": 2 }))
                .await
                .unwrap();
        assert!(!any_error);
        let Stream::Lines(out) = stream else { panic!() };
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].content, "one");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn run_range_reads_named_files_and_slices() {
        let path = scratch_file("a.txt", "one\ntwo\nthree\nfour");
        let (stream, any_error) =
            run_range(&json!({ "paths": [path.to_str().unwrap()], "start": 2, "end": 3 }))
                .await
                .unwrap();
        assert!(!any_error);
        let Stream::Lines(out) = stream else { panic!() };
        assert_eq!(
            out.iter().map(|l| l.content.as_str()).collect::<Vec<_>>(),
            ["two", "three"]
        );
        std::fs::remove_file(&path).ok();
    }
}
