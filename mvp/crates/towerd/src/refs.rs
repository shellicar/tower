//! Ref externalisation (tower-v1-design.md, Views schema): heavy values leave
//! the message at apply time, replaced in place by
//! `{ "$ref": id, "size", "hint" }` — an opaque content-addressed id, never a
//! URL. v1 applies it at four fixed nodes:
//!
//!   1. `image.source`      (base64, wherever the block nests)
//!   2. `document.source`   (base64, wherever the block nests)
//!   3. `tool_result.content`
//!   4. string values inside `tool_use.input` over ~16 KB
//!
//! The mechanism is position-agnostic and new nodes are add-only; clients
//! handle a `$ref` at any node. Interim — the real split lands at the CLI
//! level (content vocabulary).

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// Threshold for `tool_use.input` string values — input is arbitrary JSON and
/// unbounded; a large generated document is legitimately all input.
pub const INPUT_THRESHOLD: usize = 16 * 1024;

/// A stored blob: what the store callback receives.
pub struct Blob {
    pub id: String,
    pub hint: String,
    pub bytes: Vec<u8>,
}

fn ref_id(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut id = String::with_capacity(7 + 64);
    id.push_str("sha256-");
    for b in digest {
        id.push_str(&format!("{b:02x}"));
    }
    id
}

fn make_ref(value: &Value, hint: &str, store: &mut dyn FnMut(Blob)) -> Value {
    let bytes = serde_json::to_vec(value).expect("serialising a Value cannot fail");
    let size = bytes.len();
    let id = ref_id(&bytes);
    store(Blob {
        id: id.clone(),
        hint: hint.to_string(),
        bytes,
    });
    json!({ "$ref": id, "size": size, "hint": hint })
}

/// `source.media_type` when present makes the better hint than the block kind.
fn source_hint(block: &Map<String, Value>, fallback: &str) -> String {
    block
        .get("source")
        .and_then(|s| s.get("media_type"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

/// Walk content blocks (the stored `content` array) and externalise the four
/// fixed nodes, in place. Recurses into nested block arrays because image and
/// document blocks nest (e.g. inside a `tool_result`'s content list).
pub fn externalise(content: &mut [Value], store: &mut dyn FnMut(Blob)) {
    for block in content.iter_mut() {
        externalise_block(block, store);
    }
}

fn externalise_block(block: &mut Value, store: &mut dyn FnMut(Blob)) {
    let Some(obj) = block.as_object_mut() else {
        return;
    };
    let block_type = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    match block_type.as_str() {
        "image" | "document" => {
            let hint = source_hint(obj, &block_type);
            if let Some(source) = obj.get_mut("source")
                && !source.is_null()
                && source.get("$ref").is_none()
                // Only sources carrying bytes deserve externalisation. An
                // attachment reference (`source.type: "object"` — ~100 B of
                // id and facts) must stay inline: wrapping it in a $ref
                // buries the reference inside a reference and the client
                // renders garbage.
                && source.get("data").is_some()
            {
                *source = make_ref(source, &hint, store);
            }
        }
        "tool_result" => {
            if let Some(content) = obj.get_mut("content") {
                match content {
                    // Nested blocks first: an image inside a tool_result is
                    // the image node's job, and what remains is light.
                    Value::Array(blocks) => {
                        for b in blocks.iter_mut() {
                            externalise_block(b, store);
                        }
                        *content = make_ref(content, "tool_result", store);
                    }
                    Value::Null => {}
                    other if other.get("$ref").is_none() => {
                        *other = make_ref(other, "tool_result", store);
                    }
                    _ => {}
                }
            }
        }
        "tool_use" => {
            if let Some(input) = obj.get_mut("input") {
                externalise_oversized_strings(input, store);
            }
        }
        _ => {}
    }
}

/// Inside `tool_use.input`: any string value over the threshold, at any
/// depth, becomes a ref. Structure stays; only the heavy leaves leave.
fn externalise_oversized_strings(value: &mut Value, store: &mut dyn FnMut(Blob)) {
    match value {
        Value::String(s) if s.len() > INPUT_THRESHOLD => {
            *value = make_ref(&Value::String(std::mem::take(s)), "tool_use.input", store);
        }
        Value::Object(map) => {
            for (_, v) in map.iter_mut() {
                externalise_oversized_strings(v, store);
            }
        }
        Value::Array(items) => {
            for v in items.iter_mut() {
                externalise_oversized_strings(v, store);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(content: &mut [Value]) -> Vec<Blob> {
        let mut blobs = Vec::new();
        externalise(content, &mut |b| blobs.push(b));
        blobs
    }

    #[test]
    fn text_blocks_untouched() {
        let mut content = vec![json!({ "type": "text", "text": "hello" })];
        let blobs = run(&mut content);
        assert!(blobs.is_empty());
        assert_eq!(content[0]["text"], "hello");
    }

    #[test]
    fn image_source_becomes_ref_with_media_type_hint() {
        let mut content = vec![json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo…" }
        })];
        let blobs = run(&mut content);
        assert_eq!(blobs.len(), 1);
        assert_eq!(blobs[0].hint, "image/png");
        let source = &content[0]["source"];
        assert!(source["$ref"].as_str().unwrap().starts_with("sha256-"));
        assert_eq!(source["hint"], "image/png");
        assert!(source["size"].as_u64().unwrap() > 0);
    }

    #[test]
    fn attachment_reference_sources_stay_inline() {
        // The transit-attachment reference block (conversation-spec, say
        // attachments): no bytes, nothing to externalise.
        let mut content = vec![json!({
            "type": "image",
            "source": { "type": "object", "id": "att-7c9e", "mediaType": "image/png", "size": 48213 }
        })];
        let blobs = run(&mut content);
        assert!(blobs.is_empty());
        assert_eq!(content[0]["source"]["type"], "object");
        assert_eq!(content[0]["source"]["id"], "att-7c9e");
    }

    #[test]
    fn tool_result_content_becomes_ref() {
        let mut content = vec![json!({
            "type": "tool_result", "tool_use_id": "toolu_01ABC",
            "content": "…file contents…"
        })];
        let blobs = run(&mut content);
        assert_eq!(blobs.len(), 1);
        assert_eq!(blobs[0].hint, "tool_result");
        assert!(content[0]["content"]["$ref"].is_string());
        // Identity and outcome stay inline.
        assert_eq!(content[0]["tool_use_id"], "toolu_01ABC");
    }

    #[test]
    fn image_nested_in_tool_result_is_externalised() {
        let mut content = vec![json!({
            "type": "tool_result", "tool_use_id": "toolu_02",
            "content": [
                { "type": "text", "text": "here" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "AAAA" } }
            ]
        })];
        let blobs = run(&mut content);
        // The nested image, then the (now light) list itself.
        assert_eq!(blobs.len(), 2);
        assert_eq!(blobs[0].hint, "image/jpeg");
        assert_eq!(blobs[1].hint, "tool_result");
    }

    #[test]
    fn oversized_tool_use_input_string_becomes_ref() {
        let big = "x".repeat(INPUT_THRESHOLD + 1);
        let mut content = vec![json!({
            "type": "tool_use", "id": "toolu_03", "name": "CreateFile",
            "input": { "path": "doc.md", "content": big }
        })];
        let blobs = run(&mut content);
        assert_eq!(blobs.len(), 1);
        assert_eq!(blobs[0].hint, "tool_use.input");
        assert_eq!(content[0]["input"]["path"], "doc.md"); // small values stay
        assert!(content[0]["input"]["content"]["$ref"].is_string());
    }

    #[test]
    fn small_tool_use_input_untouched() {
        let mut content = vec![json!({
            "type": "tool_use", "id": "toolu_04", "name": "ReadFile",
            "input": { "path": "X" }
        })];
        assert!(run(&mut content).is_empty());
    }

    #[test]
    fn content_addressing_dedupes() {
        let mut a =
            vec![json!({ "type": "tool_result", "tool_use_id": "t1", "content": "same bytes" })];
        let mut b =
            vec![json!({ "type": "tool_result", "tool_use_id": "t2", "content": "same bytes" })];
        let (blobs_a, blobs_b) = (run(&mut a), run(&mut b));
        assert_eq!(blobs_a[0].id, blobs_b[0].id);
    }

    #[test]
    fn already_ref_is_idempotent() {
        let mut content = vec![json!({
            "type": "tool_result", "tool_use_id": "t1",
            "content": { "$ref": "sha256-abc", "size": 10, "hint": "tool_result" }
        })];
        assert!(run(&mut content).is_empty());
    }
}
