//! `CreateFile` and `AppendFile`: the simplest mutation pair — whole-file
//! writes, no diffing, no content-anchored editing (that's `EditFile`, its
//! own commit). Both gate behind the same human approval as `Bash`/`Exec`.

use serde_json::{Value, json};

pub fn create_file_schema() -> Value {
    json!({
        "name": "CreateFile",
        "description": "Create a new file with optional content. Creates parent directories \
            automatically. By default errors if the file already exists. Set overwrite: true \
            to replace an existing file (errors if the file does NOT exist).",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to create." },
                "content": {
                    "type": "string",
                    "description": "Initial file content. Defaults to empty."
                },
                "overwrite": {
                    "type": "boolean",
                    "description": "If false (default), error if the file already exists. \
                        If true, error if the file does not exist."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

pub fn append_file_schema() -> Value {
    json!({
        "name": "AppendFile",
        "description": "Append text to the end of a file, creating the file (and any \
            missing parent directories) if it does not exist. Content is written verbatim; \
            no separator is inserted at the seam.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file to append to." },
                "content": {
                    "type": "string",
                    "description": "Text to append to the end of the file, written verbatim."
                }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }
    })
}

pub async fn run_create_file(input: &Value) -> (String, bool) {
    let Some(path) = input["path"].as_str() else {
        return ("missing \"path\"".to_string(), true);
    };
    let content = input["content"].as_str().unwrap_or("");
    let overwrite = input["overwrite"].as_bool().unwrap_or(false);

    let exists = tokio::fs::metadata(path).await.is_ok();
    if overwrite && !exists {
        return (format!("{path} does not exist, nothing to overwrite"), true);
    }
    if !overwrite && exists {
        return (
            format!("{path} already exists (pass overwrite: true to replace it)"),
            true,
        );
    }
    if let Some(parent) = std::path::Path::new(path).parent()
        && !parent.as_os_str().is_empty()
        && let Err(e) = tokio::fs::create_dir_all(parent).await
    {
        return (
            format!("failed to create parent directories for {path}: {e}"),
            true,
        );
    }
    match tokio::fs::write(path, content).await {
        Ok(()) => (format!("wrote {path} ({} B)", content.len()), false),
        Err(e) => (format!("failed to write {path}: {e}"), true),
    }
}

pub async fn run_append_file(input: &Value) -> (String, bool) {
    let Some(path) = input["path"].as_str() else {
        return ("missing \"path\"".to_string(), true);
    };
    let Some(content) = input["content"].as_str() else {
        return ("missing \"content\"".to_string(), true);
    };
    if let Some(parent) = std::path::Path::new(path).parent()
        && !parent.as_os_str().is_empty()
        && let Err(e) = tokio::fs::create_dir_all(parent).await
    {
        return (
            format!("failed to create parent directories for {path}: {e}"),
            true,
        );
    }
    use tokio::io::AsyncWriteExt;
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await;
    let mut file = match file {
        Ok(f) => f,
        Err(e) => return (format!("failed to open {path}: {e}"), true),
    };
    match file.write_all(content.as_bytes()).await {
        Ok(()) => (format!("appended {} B to {path}", content.len()), false),
        Err(e) => (format!("failed to append to {path}: {e}"), true),
    }
}

#[cfg(test)]
mod tests {
    use super::{run_append_file, run_create_file};
    use serde_json::json;

    fn scratch_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bridge-mutate-test-{}-{name}",
            uuid::Uuid::new_v4()
        ))
    }

    #[tokio::test]
    async fn create_writes_a_new_file() {
        let path = scratch_path("a.txt");
        let (_, is_error) =
            run_create_file(&json!({ "path": path.to_str().unwrap(), "content": "hello" })).await;
        assert!(!is_error);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "hello");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn create_defaults_to_empty_content() {
        let path = scratch_path("b.txt");
        let (_, is_error) = run_create_file(&json!({ "path": path.to_str().unwrap() })).await;
        assert!(!is_error);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn create_creates_missing_parent_directories() {
        let path = scratch_path("nested").join("deeper").join("c.txt");
        let (_, is_error) = run_create_file(&json!({ "path": path.to_str().unwrap() })).await;
        assert!(!is_error);
        assert!(path.exists());
        std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn create_without_overwrite_errors_if_the_file_exists() {
        let path = scratch_path("d.txt");
        std::fs::write(&path, "original").unwrap();
        let (content, is_error) =
            run_create_file(&json!({ "path": path.to_str().unwrap(), "content": "new" })).await;
        assert!(is_error);
        assert!(content.contains("already exists"));
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "original");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn create_with_overwrite_replaces_an_existing_file() {
        let path = scratch_path("e.txt");
        std::fs::write(&path, "original").unwrap();
        let (_, is_error) = run_create_file(
            &json!({ "path": path.to_str().unwrap(), "content": "replaced", "overwrite": true }),
        )
        .await;
        assert!(!is_error);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "replaced");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn create_with_overwrite_errors_if_the_file_does_not_exist() {
        let path = scratch_path("f.txt");
        let (content, is_error) =
            run_create_file(&json!({ "path": path.to_str().unwrap(), "overwrite": true })).await;
        assert!(is_error);
        assert!(content.contains("does not exist"));
    }

    #[tokio::test]
    async fn append_creates_the_file_if_missing() {
        let path = scratch_path("g.txt");
        let (_, is_error) =
            run_append_file(&json!({ "path": path.to_str().unwrap(), "content": "first" })).await;
        assert!(!is_error);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "first");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn append_writes_verbatim_with_no_inserted_separator() {
        let path = scratch_path("h.txt");
        std::fs::write(&path, "one").unwrap();
        let (_, is_error) =
            run_append_file(&json!({ "path": path.to_str().unwrap(), "content": "two" })).await;
        assert!(!is_error);
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), "onetwo");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn append_creates_missing_parent_directories() {
        let path = scratch_path("nested2").join("deeper").join("i.txt");
        let (_, is_error) =
            run_append_file(&json!({ "path": path.to_str().unwrap(), "content": "x" })).await;
        assert!(!is_error);
        assert!(path.exists());
        std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).ok();
    }
}
