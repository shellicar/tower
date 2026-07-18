//! `Pipe`: the orchestrator. Composes a SOURCE (`Find`) with STAGEs (`Read`,
//! `Match`, `Head`, `Tail`, `Range`), validating and chaining each step's
//! `in`/`out` — last commit in the family, deliberately, because it needed
//! every other tool's contract to already exist. Each step's own `input`
//! carries only that step's fields; the stream flows between steps here,
//! not through the model.

use serde_json::{Value, json};

use crate::stream::Stream;

pub fn pipe_schema() -> Value {
    json!({
        "name": "Pipe",
        "description": "Run a sequence of composable steps. Step 0 must be a SOURCE \
            (\"Find\"); each following step is a STAGE (\"Read\", \"Match\", \"Head\", \
            \"Tail\", \"Range\") that transforms the stream the previous step produced. \
            Each step's `input` carries only that step's own fields (e.g. Find: path/ \
            pattern/type; Match: pattern; Head/Tail: count; Range: start/end) — the \
            stream itself flows between steps automatically, never through the model. \
            Read-only, so no approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool": {
                                "type": "string",
                                "enum": ["Find", "Read", "Match", "Head", "Tail", "Range"]
                            },
                            "input": {
                                "type": "object",
                                "description": "That step's own fields, per its standalone schema minus \"paths\"."
                            }
                        },
                        "required": ["tool"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["steps"],
            "additionalProperties": false
        }
    })
}

/// Run the whole pipeline: step 0 sources a stream, each following step
/// transforms it. Request-level: a malformed step or step-0-not-a-source
/// fails the whole call before returning a partial stream (composition-
/// model.md \u2014 there is no per-item result to hang this on; the pipeline
/// either has a valid shape or it doesn't).
pub async fn run_pipe(input: &Value) -> Result<(Stream, bool), String> {
    let steps = input["steps"].as_array().ok_or("missing \"steps\"")?;
    if steps.is_empty() {
        return Err("\"steps\" must have at least one item".to_string());
    }

    let first = &steps[0];
    let first_tool = first["tool"].as_str().ok_or("step 0: missing \"tool\"")?;
    if first_tool != "Find" {
        return Err(format!(
            "step 0 must be a source (Find), got {first_tool:?}"
        ));
    }
    let first_input = first.get("input").cloned().unwrap_or_else(|| json!({}));
    let mut current = crate::find::run_find(&first_input).await?;
    let mut any_error = false;

    for (i, step) in steps.iter().enumerate().skip(1) {
        let tool = step["tool"]
            .as_str()
            .ok_or_else(|| format!("step {i}: missing \"tool\""))?;
        let step_input = step.get("input").cloned().unwrap_or_else(|| json!({}));
        current = match tool {
            "Read" => {
                let (s, err) = crate::read::read_stream(&current).await?;
                any_error |= err;
                s
            }
            "Match" => {
                let pattern_str = step_input["pattern"]
                    .as_str()
                    .ok_or_else(|| format!("step {i}: Match missing \"pattern\""))?;
                let pattern = regex::Regex::new(pattern_str)
                    .map_err(|e| format!("step {i}: invalid pattern: {e}"))?;
                crate::matcher::match_stream(&current, &pattern)
            }
            "Head" => {
                let count = step_input["count"]
                    .as_u64()
                    .ok_or_else(|| format!("step {i}: Head missing \"count\""))?
                    as usize;
                crate::slice::head_stream(&current, count)
            }
            "Tail" => {
                let count = step_input["count"]
                    .as_u64()
                    .ok_or_else(|| format!("step {i}: Tail missing \"count\""))?
                    as usize;
                crate::slice::tail_stream(&current, count)
            }
            "Range" => {
                let start = step_input["start"]
                    .as_u64()
                    .ok_or_else(|| format!("step {i}: Range missing \"start\""))?
                    as usize;
                let end = step_input["end"]
                    .as_u64()
                    .ok_or_else(|| format!("step {i}: Range missing \"end\""))?
                    as usize;
                crate::slice::range_stream(&current, start, end)
            }
            "Find" => return Err(format!("step {i}: Find can only be step 0 (a source)")),
            other => return Err(format!("step {i}: unknown tool {other:?}")),
        };
    }
    Ok((current, any_error))
}

#[cfg(test)]
mod tests {
    use super::run_pipe;
    use crate::stream::Stream;
    use serde_json::json;

    struct Scratch {
        root: std::path::PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("bridge-pipe-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).expect("create scratch dir");
            Self { root }
        }

        fn path(&self) -> &str {
            self.root.to_str().expect("scratch path is utf8")
        }

        fn file(&self, rel: &str, content: &str) {
            std::fs::write(self.root.join(rel), content).expect("write scratch file");
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[tokio::test]
    async fn finds_reads_and_matches_across_the_chain() {
        let dir = Scratch::new();
        dir.file("a.rs", "fn keep() {}\nfn skip() {}\nfn keep_too() {}\n");
        dir.file("b.txt", "irrelevant\n");

        let (stream, any_error) = run_pipe(&json!({
            "steps": [
                { "tool": "Find", "input": { "path": dir.path(), "pattern": "\\.rs$" } },
                { "tool": "Read" },
                { "tool": "Match", "input": { "pattern": "^fn keep" } }
            ]
        }))
        .await
        .unwrap();
        assert!(!any_error);
        let Stream::Lines(lines) = stream else {
            panic!("chain ends on Lines")
        };
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.content.starts_with("fn keep")));
    }

    #[tokio::test]
    async fn head_after_find_slices_the_file_list_itself() {
        let dir = Scratch::new();
        dir.file("a.txt", "");
        dir.file("b.txt", "");
        dir.file("c.txt", "");

        let (stream, _) = run_pipe(&json!({
            "steps": [
                { "tool": "Find", "input": { "path": dir.path() } },
                { "tool": "Head", "input": { "count": 1 } }
            ]
        }))
        .await
        .unwrap();
        let Stream::Files(files) = stream else {
            panic!("Head after Find stays Files-grain")
        };
        assert_eq!(files.len(), 1);
    }

    #[tokio::test]
    async fn step_zero_must_be_a_source() {
        let err = run_pipe(&json!({ "steps": [{ "tool": "Read" }] })).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn find_mid_pipeline_is_rejected() {
        let dir = Scratch::new();
        let err = run_pipe(&json!({
            "steps": [
                { "tool": "Find", "input": { "path": dir.path() } },
                { "tool": "Find", "input": { "path": dir.path() } }
            ]
        }))
        .await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn an_empty_steps_array_is_a_request_level_error() {
        let err = run_pipe(&json!({ "steps": [] })).await;
        assert!(err.is_err());
    }
}
