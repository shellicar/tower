//! Attachment resolution at the servicer's edge (conversation-spec, say
//! `attachments`): the record and the wire carry reference blocks; the
//! bytes live in the deployment's transit object store, fetched here and
//! inlined only into the model-facing request. An object that no longer
//! resolves (transit expiry, an adopted conversation past the window)
//! becomes a stated placeholder - the record still holds the block, and
//! the repair is re-attaching.

use base64::Engine;
use serde_json::{Value, json};

/// Resolve every `object`-source block in a model-facing history, in place.
/// This runs at request-build over the WHOLE history, not just the fresh
/// say: the tree (and any adopted record) holds reference blocks verbatim,
/// and the API must never see one. Fetch and inline as base64; unknown
/// source kinds and failed fetches degrade to a placeholder text block
/// carrying what the block itself states (media type, size).
pub async fn resolve_history(client: &async_nats::Client, bucket: &str, history: &mut [Value]) {
    // Cheap scan first: most requests carry no reference blocks at all.
    let needs = history.iter().any(|m| {
        m["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(is_object_source))
    });
    if !needs {
        return;
    }
    let js = async_nats::jetstream::new(client.clone());
    let store = js.get_object_store(bucket).await.ok();
    for message in history.iter_mut() {
        let Some(blocks) = message["content"].as_array_mut() else {
            continue;
        };
        for block in blocks.iter_mut() {
            if is_object_source(block) {
                *block = resolve_one(store.as_ref(), block).await;
            }
        }
    }
}

fn is_object_source(block: &Value) -> bool {
    block["source"]["type"] == "object"
}

async fn resolve_one(
    store: Option<&async_nats::jetstream::object_store::ObjectStore>,
    block: &Value,
) -> Value {
    let source = &block["source"];
    let media_type = source["mediaType"]
        .as_str()
        .unwrap_or("application/octet-stream");
    let size = source["size"].as_u64().unwrap_or(0);
    let placeholder = || {
        json!({
            "type": "text",
            "text": format!("[attachment unavailable: {media_type}, {size} B]"),
        })
    };

    let Some(id) = source["id"].as_str() else {
        return placeholder();
    };
    let Some(store) = store else {
        return placeholder();
    };

    let bytes = match store.get(id).await {
        Ok(mut object) => {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::with_capacity(size as usize);
            match object.read_to_end(&mut buf).await {
                Ok(_) => buf,
                Err(_) => return placeholder(),
            }
        }
        Err(_) => return placeholder(),
    };

    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    json!({
        "type": block["type"].as_str().unwrap_or("image"),
        "source": { "type": "base64", "media_type": media_type, "data": data },
    })
}

#[cfg(test)]
mod tests {
    use super::{is_object_source, resolve_one};
    use serde_json::json;

    #[test]
    fn object_sources_are_recognised() {
        assert!(is_object_source(&json!({
            "type": "image",
            "source": { "type": "object", "id": "x" },
        })));
        assert!(!is_object_source(&json!({ "type": "text", "text": "hi" })));
        assert!(!is_object_source(&json!({
            "type": "image",
            "source": { "type": "base64", "data": "..." },
        })));
    }

    #[tokio::test]
    async fn without_a_store_the_block_degrades_to_a_stated_placeholder() {
        // The record still holds the reference block; the repair is
        // re-attaching. The placeholder states what the block itself carries.
        let block = json!({
            "type": "image",
            "source": { "type": "object", "id": "abc", "mediaType": "image/png", "size": 2048 },
        });
        let out = resolve_one(None, &block).await;
        assert_eq!(out["type"], "text");
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("image/png"), "media type absent: {text:?}");
        assert!(text.contains("2048"), "size absent: {text:?}");
    }

    #[tokio::test]
    async fn a_source_without_an_id_is_a_placeholder_too() {
        let block = json!({
            "type": "document",
            "source": { "type": "object", "mediaType": "application/pdf", "size": 10 },
        });
        let out = resolve_one(None, &block).await;
        assert_eq!(out["type"], "text");
        assert!(out["text"].as_str().unwrap().contains("application/pdf"));
    }
}
