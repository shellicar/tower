//! `Delete`: the merged file/directory delete \u2014 design settled earlier this
//! session (bridge-exec-permissions.md). Per-item auto-detect file vs
//! directory (a visible discriminator, not a caller flag); non-recursive \u2014
//! a directory only deletes if empty, so a tree-delete means every path
//! enumerated leaf-first by the caller, no hidden fan-out; ordered, per-item
//! results (composition-model.md's item-level error bag, same shape as
//! `Exec`'s); no wildcards \u2014 every path is named explicitly.

use serde_json::{Value, json};

pub fn delete_schema() -> Value {
    json!({
        "name": "Delete",
        "description": "Delete files by path, or empty directories by path (auto-detected \
            per item). Non-recursive: a directory only deletes if it's empty — a tree \
            delete means naming every path, leaf-first. No wildcards. Gated behind human \
            approval, same as Exec.",
        "input_schema": {
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "type": "string" },
                    "description": "Paths to delete, in order. Each is auto-detected as a file \
                        or an empty directory."
                }
            },
            "required": ["paths"],
            "additionalProperties": false
        }
    })
}

async fn delete_one(path: &str) -> (String, bool) {
    let meta = match tokio::fs::symlink_metadata(path).await {
        Ok(m) => m,
        Err(e) => return (format!("{path}: {e}"), true),
    };
    if meta.is_dir() {
        match tokio::fs::remove_dir(path).await {
            Ok(()) => (format!("{path}: deleted (directory)"), false),
            Err(e) => (format!("{path}: {e}"), true),
        }
    } else {
        // A regular file or a symlink (remove_file removes the link itself,
        // never what it points to).
        match tokio::fs::remove_file(path).await {
            Ok(()) => (format!("{path}: deleted (file)"), false),
            Err(e) => (format!("{path}: {e}"), true),
        }
    }
}

/// Run `Delete`. Every path gets its own result, in order, whether or not
/// earlier ones failed \u2014 one path's failure never hides another's outcome.
pub async fn run_delete(input: &Value) -> (String, bool) {
    let Some(paths) = input["paths"].as_array() else {
        return ("missing \"paths\"".to_string(), true);
    };
    if paths.is_empty() {
        return ("\"paths\" must have at least one item".to_string(), true);
    }
    let mut lines = Vec::with_capacity(paths.len());
    let mut any_error = false;
    for (i, p) in paths.iter().enumerate() {
        let Some(path) = p.as_str() else {
            lines.push(format!("[{}] paths[{i}] is not a string", i + 1));
            any_error = true;
            continue;
        };
        let (line, is_error) = delete_one(path).await;
        any_error |= is_error;
        lines.push(format!("[{}] {line}", i + 1));
    }
    (lines.join("\n"), any_error)
}

#[cfg(test)]
mod tests {
    use super::run_delete;
    use serde_json::json;

    fn scratch_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bridge-delete-test-{}-{name}",
            uuid::Uuid::new_v4()
        ))
    }

    #[tokio::test]
    async fn deletes_a_file() {
        let path = scratch_path("a.txt");
        std::fs::write(&path, "x").unwrap();
        let (content, is_error) = run_delete(&json!({ "paths": [path.to_str().unwrap()] })).await;
        assert!(!is_error);
        assert!(content.contains("deleted (file)"), "{content}");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn deletes_an_empty_directory() {
        let path = scratch_path("dir");
        std::fs::create_dir(&path).unwrap();
        let (content, is_error) = run_delete(&json!({ "paths": [path.to_str().unwrap()] })).await;
        assert!(!is_error);
        assert!(content.contains("deleted (directory)"), "{content}");
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn a_non_empty_directory_errors_and_is_not_deleted() {
        let path = scratch_path("full");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("child.txt"), "x").unwrap();
        let (content, is_error) = run_delete(&json!({ "paths": [path.to_str().unwrap()] })).await;
        assert!(is_error);
        assert!(path.exists(), "non-recursive: the directory must survive");
        std::fs::remove_dir_all(&path).ok();
        let _ = content;
    }

    #[tokio::test]
    async fn a_missing_path_errors() {
        let path = scratch_path("nope");
        let (content, is_error) = run_delete(&json!({ "paths": [path.to_str().unwrap()] })).await;
        assert!(is_error);
        assert!(!content.is_empty());
    }

    #[tokio::test]
    async fn every_path_gets_its_own_ordered_result_even_after_a_failure() {
        let missing = scratch_path("missing");
        let file = scratch_path("real.txt");
        std::fs::write(&file, "x").unwrap();
        let (content, is_error) = run_delete(&json!({
            "paths": [missing.to_str().unwrap(), file.to_str().unwrap()]
        }))
        .await;
        assert!(is_error, "one failure marks the whole call errored");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 2, "both paths get a result: {content}");
        assert!(lines[0].starts_with("[1]"));
        assert!(lines[1].starts_with("[2]"));
        assert!(
            lines[1].contains("deleted (file)"),
            "the second path still ran: {content}"
        );
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn empty_paths_array_is_a_request_level_error() {
        let (_, is_error) = run_delete(&json!({ "paths": [] })).await;
        assert!(is_error);
    }
}
