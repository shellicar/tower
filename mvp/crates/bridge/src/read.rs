//! `Read`: the engine's first composable STAGE — `File[] -> Line[]`. Retires
//! the naive whole-file Read from commit 1; this one produces the grain the
//! rest of the composable family (`Match`, `Head`/`Tail`/`Range`, `Pipe`)
//! works over. Standalone until `Pipe` lands: takes its own `paths` input
//! directly — the same "useful the moment it lands" rule `Find` follows.

use serde_json::Value;

use crate::stream::{LineEntry, Stream};

pub fn read_schema() -> Value {
    serde_json::json!({
        "name": "Read",
        "description": "Read one or more UTF-8 text files, line by line. Read-only, so no \
            approval is required. A path that fails to read reports its error inline \
            rather than being dropped.",
        "input_schema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Paths to the files to read."
                }
            },
            "required": ["paths"],
            "additionalProperties": false
        }
    })
}

/// Run `Read` from its raw tool input. Returns the produced `Stream::Lines`
/// plus whether any path failed (item-level, per composition-model.md — a
/// bad path is reported inline, never silently dropped; the whole call is
/// still `Ok` unless the request itself was malformed).
pub async fn run_read(input: &Value) -> Result<(Stream, bool), String> {
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
    let (lines, any_error) = read_paths(&paths).await;
    Ok((Stream::Lines(lines), any_error))
}

/// Read each path into `LineEntry`s, in order, plus whether any failed.
/// `pub(crate)`: `Match` reuses this to build the content it filters.
pub(crate) async fn read_paths(paths: &[String]) -> (Vec<LineEntry>, bool) {
    let mut out = Vec::new();
    let mut any_error = false;
    for path in paths {
        match tokio::fs::read(path).await {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for (i, line) in text.lines().enumerate() {
                    out.push(LineEntry {
                        path: path.clone(),
                        line: i + 1,
                        content: line.to_string(),
                    });
                }
            }
            Err(e) => {
                any_error = true;
                out.push(LineEntry {
                    path: path.clone(),
                    line: 0,
                    content: format!("error: {e}"),
                });
            }
        }
    }
    (out, any_error)
}

#[cfg(test)]
mod tests {
    use super::run_read;
    use crate::stream::Stream;
    use serde_json::json;

    fn scratch_file(name: &str, content: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bridge-read-test-{}-{name}", uuid::Uuid::new_v4()));
        std::fs::write(&path, content).expect("write scratch file");
        path
    }

    #[tokio::test]
    async fn reads_a_file_into_numbered_lines() {
        let path = scratch_file("a.txt", "one\ntwo\nthree");
        let (stream, any_error) = run_read(&json!({ "paths": [path.to_str().unwrap()] }))
            .await
            .unwrap();
        assert!(!any_error);
        let Stream::Lines(lines) = stream else {
            panic!("Read must produce a Lines stream")
        };
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].line, 1);
        assert_eq!(lines[0].content, "one");
        assert_eq!(lines[2].content, "three");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn reads_multiple_paths_in_order() {
        let a = scratch_file("a.txt", "a1");
        let b = scratch_file("b.txt", "b1");
        let (stream, any_error) =
            run_read(&json!({ "paths": [a.to_str().unwrap(), b.to_str().unwrap()] }))
                .await
                .unwrap();
        assert!(!any_error);
        let Stream::Lines(lines) = stream else {
            panic!("Read must produce a Lines stream")
        };
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].content, "a1");
        assert_eq!(lines[1].content, "b1");
        std::fs::remove_file(&a).ok();
        std::fs::remove_file(&b).ok();
    }

    #[tokio::test]
    async fn an_unreadable_path_reports_inline_instead_of_dropping() {
        let (stream, any_error) =
            run_read(&json!({ "paths": ["/definitely/not/a/real/path/xyz"] }))
                .await
                .unwrap();
        assert!(any_error);
        let Stream::Lines(lines) = stream else {
            panic!("Read must produce a Lines stream")
        };
        assert_eq!(lines.len(), 1);
        assert!(lines[0].content.starts_with("error:"));
    }

    #[tokio::test]
    async fn missing_paths_field_is_a_request_level_error() {
        let err = run_read(&json!({})).await;
        assert!(err.is_err());
    }
}
