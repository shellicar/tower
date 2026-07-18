//! `Find`: the engine's SOURCE — args to a `Stream::Files`, no stream input
//! to accept. The simplest tool, and it defines the engine's shape (source
//! vs stage vs terminal) while being useful entirely on its own; `Pipe`
//! (later) wires it in as a pipeline's first step, unchanged.

use serde_json::Value;

use crate::stream::{FileEntry, Stream};

const DEFAULT_EXCLUDE: &[&str] = &["node_modules", "dist", ".git"];

pub fn find_schema() -> Value {
    serde_json::json!({
        "name": "Find",
        "description": "Find files or directories under a directory. Excludes \
            node_modules, dist and .git by default.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory to search." },
                "pattern": {
                    "type": "string",
                    "description": "Regex to match against file paths (Rust regex syntax)."
                },
                "type": {
                    "type": "string",
                    "enum": ["file", "directory", "both"],
                    "description": "Whether to find files, directories, or both. Defaults to file."
                },
                "maxDepth": {
                    "type": "integer",
                    "description": "Maximum directory depth to search."
                },
                "exclude": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Directory names to exclude from search. Defaults to node_modules, dist, .git."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryType {
    File,
    Directory,
    Both,
}

/// Run `Find` from its raw tool input. Read-only — no approval gate, same as
/// `Read`: discovery, per composition-model.md, needs no bounding by a human
/// because nothing it finds is acted on.
pub async fn run_find(input: &Value) -> Result<Stream, String> {
    let root = input["path"].as_str().ok_or("missing \"path\"")?.to_owned();
    let pattern = match input["pattern"].as_str() {
        Some(p) => Some(regex::Regex::new(p).map_err(|e| format!("invalid pattern: {e}"))?),
        None => None,
    };
    let entry_type = match input["type"].as_str() {
        Some("directory") => EntryType::Directory,
        Some("both") => EntryType::Both,
        Some("file") | None => EntryType::File,
        Some(other) => return Err(format!("unknown type {other:?}")),
    };
    let max_depth = input["maxDepth"].as_u64().map(|d| d as usize);
    let exclude: Vec<String> = input["exclude"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_else(|| DEFAULT_EXCLUDE.iter().map(|s| s.to_string()).collect());

    let root_path = std::path::PathBuf::from(&root);
    let files = tokio::task::spawn_blocking(move || {
        walk(
            &root_path,
            max_depth,
            &exclude,
            entry_type,
            pattern.as_ref(),
        )
    })
    .await
    .map_err(|e| format!("find task failed: {e}"))??;
    Ok(Stream::Files(files))
}

fn walk(
    root: &std::path::Path,
    max_depth: Option<usize>,
    exclude: &[String],
    entry_type: EntryType,
    pattern: Option<&regex::Regex>,
) -> Result<Vec<FileEntry>, String> {
    let mut out = Vec::new();
    walk_dir(root, 0, max_depth, exclude, entry_type, pattern, &mut out)
        .map_err(|e| format!("{}: {e}", root.display()))?;
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
fn walk_dir(
    dir: &std::path::Path,
    depth: usize,
    max_depth: Option<usize>,
    exclude: &[String],
    entry_type: EntryType,
    pattern: Option<&regex::Regex>,
    out: &mut Vec<FileEntry>,
) -> std::io::Result<()> {
    if let Some(max) = max_depth
        && depth > max
    {
        return Ok(());
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_dir = entry.file_type()?.is_dir();
        if is_dir && exclude.iter().any(|x| x == name.as_ref()) {
            continue;
        }
        let matches_type = match entry_type {
            EntryType::File => !is_dir,
            EntryType::Directory => is_dir,
            EntryType::Both => true,
        };
        let path_str = path.to_string_lossy().into_owned();
        let matches_pattern = pattern.map(|re| re.is_match(&path_str)).unwrap_or(true);
        if matches_type && matches_pattern {
            out.push(FileEntry { path: path_str });
        }
        if is_dir {
            walk_dir(
                &path,
                depth + 1,
                max_depth,
                exclude,
                entry_type,
                pattern,
                out,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::run_find;
    use crate::stream::Stream;
    use serde_json::json;

    /// A throwaway directory under the OS temp dir, torn down on drop — the
    /// whole point of these tests being a real filesystem, not a fake crate.
    struct Scratch {
        root: std::path::PathBuf,
    }

    impl Scratch {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("bridge-find-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&root).expect("create scratch dir");
            Self { root }
        }

        fn path(&self) -> &str {
            self.root.to_str().expect("scratch path is utf8")
        }

        fn file(&self, rel: &str, content: &str) {
            let path = self.root.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("create parent dir");
            }
            std::fs::write(path, content).expect("write scratch file");
        }

        fn dir(&self, rel: &str) {
            std::fs::create_dir_all(self.root.join(rel)).expect("create scratch dir");
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn scratch() -> Scratch {
        Scratch::new()
    }

    fn paths(stream: &Stream) -> Vec<String> {
        match stream {
            Stream::Files(files) => files.iter().map(|f| f.path.clone()).collect(),
            _ => panic!("Find must produce a Files stream"),
        }
    }

    #[tokio::test]
    async fn finds_files_recursively_and_excludes_node_modules_by_default() {
        let dir = scratch();
        dir.file("a.rs", "");
        dir.dir("sub");
        dir.file("sub/b.rs", "");
        dir.dir("node_modules");
        dir.file("node_modules/c.rs", "");

        let stream = run_find(&json!({ "path": dir.path() })).await.unwrap();
        let found = paths(&stream);
        assert!(found.iter().any(|p| p.ends_with("a.rs")));
        assert!(found.iter().any(|p| p.ends_with("sub/b.rs")));
        assert!(!found.iter().any(|p| p.contains("node_modules")));
    }

    #[tokio::test]
    async fn pattern_filters_by_regex_against_the_full_path() {
        let dir = scratch();
        dir.file("keep.rs", "");
        dir.file("skip.txt", "");

        let stream = run_find(&json!({ "path": dir.path(), "pattern": "\\.rs$" }))
            .await
            .unwrap();
        let found = paths(&stream);
        assert_eq!(found.len(), 1);
        assert!(found[0].ends_with("keep.rs"));
    }

    #[tokio::test]
    async fn type_directory_returns_only_directories() {
        let dir = scratch();
        dir.file("a.rs", "");
        dir.dir("sub");

        let stream = run_find(&json!({ "path": dir.path(), "type": "directory" }))
            .await
            .unwrap();
        let found = paths(&stream);
        assert!(found.iter().any(|p| p.ends_with("sub")));
        assert!(!found.iter().any(|p| p.ends_with("a.rs")));
    }

    #[tokio::test]
    async fn a_missing_directory_finds_nothing_rather_than_erroring() {
        let stream = run_find(&json!({ "path": "/definitely/not/a/real/path/xyz" }))
            .await
            .unwrap();
        assert!(stream.is_empty());
    }

    #[tokio::test]
    async fn an_invalid_pattern_is_a_request_level_error() {
        let dir = scratch();
        let err = run_find(&json!({ "path": dir.path(), "pattern": "(" })).await;
        assert!(err.is_err());
    }
}
