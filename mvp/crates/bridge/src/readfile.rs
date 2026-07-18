//! `ReadFile`: read a single file of any type, outside the composable `Read`
//! family (which takes many paths but text only). Text returns as
//! line-numbered content; PDF and images return as a native document/image
//! content block, inline base64 — the same block shape `objects.rs` resolves
//! a stored *reference* block into, built here directly from local disk (no
//! transit store, no reference — the file is read straight off the
//! filesystem the bridge runs on).

use base64::Engine;
use serde_json::{Value, json};

/// Text cap, matching every other tool's model-facing limit.
const MAX_TEXT_BYTES: usize = 100 * 1024;
/// A binary attachment's own sanity limit — Anthropic documents no per-call
/// cap here; large enough for a real PDF/image, small enough that a
/// mistaken multi-GB file fails fast instead of hanging a base64 encode.
const MAX_BINARY_BYTES: usize = 20 * 1024 * 1024;

pub fn read_file_schema() -> Value {
    json!({
        "name": "ReadFile",
        "description": "Read a single file, outside the composable Read family (which \
            takes many paths but text only). Text returns as line-numbered content \
            (capped at 100 KB). PDFs and images return as a native document/image block \
            the model reads directly — base64, capped at 20 MB. Read-only, so no \
            approval is required.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the file." }
            },
            "required": ["path"],
            "additionalProperties": false
        }
    })
}

/// Sniff by extension — cheap, and matches the tool's own contract (PDF and
/// image are the two binary cases; everything else is text). Magic-byte
/// sniffing is future work if extension-less binaries turn out to matter.
fn media_type_for(path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(path)
        .extension()?
        .to_str()?
        .to_lowercase();
    Some(match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    })
}

/// Run `ReadFile`. Returns the tool_result's `content` as a `Value` — a
/// plain string for text, a one-block array for a binary attachment — and
/// whether the read failed. `Value` (not `String`) because this is the one
/// tool whose result isn't text: the caller pushes it into `tool_result`
/// verbatim, unlike every composable tool's `(String, bool)`.
pub async fn run_read_file(input: &Value) -> (Value, bool) {
    let Some(path) = input["path"].as_str() else {
        return (json!("missing \"path\""), true);
    };
    match media_type_for(path) {
        Some(media_type) => read_binary(path, media_type).await,
        None => read_text(path).await,
    }
}

async fn read_text(path: &str) -> (Value, bool) {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let truncated = bytes.len() > MAX_TEXT_BYTES;
            let take = bytes.len().min(MAX_TEXT_BYTES);
            let mut text = String::from_utf8_lossy(&bytes[..take]).into_owned();
            if truncated {
                text.push_str("\n[truncated at 100 KB]");
            }
            (json!(text), false)
        }
        Err(e) => (json!(format!("failed to read {path}: {e}")), true),
    }
}

async fn read_binary(path: &str, media_type: &str) -> (Value, bool) {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) => return (json!(format!("failed to read {path}: {e}")), true),
    };
    if bytes.len() > MAX_BINARY_BYTES {
        return (
            json!(format!(
                "{path} is {} B, over the {MAX_BINARY_BYTES} B attachment cap",
                bytes.len()
            )),
            true,
        );
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let block_type = if media_type == "application/pdf" {
        "document"
    } else {
        "image"
    };
    (
        json!([{
            "type": block_type,
            "source": { "type": "base64", "media_type": media_type, "data": data },
        }]),
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::run_read_file;
    use serde_json::json;

    fn scratch_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bridge-readfile-test-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes).expect("write scratch file");
        path
    }

    #[tokio::test]
    async fn a_text_file_returns_a_plain_string() {
        let path = scratch_file("a.txt", b"hello world");
        let (content, is_error) = run_read_file(&json!({ "path": path.to_str().unwrap() })).await;
        assert!(!is_error);
        assert_eq!(content, json!("hello world"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_pdf_returns_a_base64_document_block() {
        let path = scratch_file("a.pdf", b"%PDF-1.4 fake content");
        let (content, is_error) = run_read_file(&json!({ "path": path.to_str().unwrap() })).await;
        assert!(!is_error);
        let arr = content.as_array().expect("document block is an array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "document");
        assert_eq!(arr[0]["source"]["media_type"], "application/pdf");
        assert_eq!(arr[0]["source"]["type"], "base64");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_png_returns_a_base64_image_block() {
        let path = scratch_file("a.png", &[0x89, 0x50, 0x4E, 0x47]);
        let (content, is_error) = run_read_file(&json!({ "path": path.to_str().unwrap() })).await;
        assert!(!is_error);
        let arr = content.as_array().expect("image block is an array");
        assert_eq!(arr[0]["type"], "image");
        assert_eq!(arr[0]["source"]["media_type"], "image/png");
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_missing_file_is_an_error() {
        let (_, is_error) =
            run_read_file(&json!({ "path": "/definitely/not/a/real/path.txt" })).await;
        assert!(is_error);
    }

    #[tokio::test]
    async fn missing_path_field_is_an_error() {
        let (_, is_error) = run_read_file(&json!({})).await;
        assert!(is_error);
    }
}
