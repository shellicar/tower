//! Attachment resolution at the servicer's edge (conversation-spec, say
//! `attachments`): the record and the wire carry reference blocks; the
//! bytes live in the deployment's transit object store, fetched here and
//! inlined only into the model-facing request. A reference block names its
//! own bucket (`source.bucket`) — the client that minted it knows exactly
//! where the object landed. There is no default and no fallback: a block
//! naming no bucket cannot be resolved, full stop — guessing a bucket
//! from the servicer's own config is exactly the silent-wrong-store failure
//! this exists to rule out.
//!
//! Two resolution modes, deliberately different in how they fail:
//! - **History replay** (`resolve_history`): every already-committed message,
//!   replayed on every turn. An object that no longer resolves here (transit
//!   expiry, an adopted conversation past the window) is expected over time
//!   and becomes a stated placeholder — the record still holds the block,
//!   and the repair is re-attaching.
//! - **Fresh attachments** (`validate_fresh`): the blocks riding THIS say,
//!   uploaded moments ago. A failure here is never "expired" — it is a live
//!   bug (no bucket named, wrong bucket, dropped upload, unreachable store)
//!   — so it must reject the say outright, before anything commits, rather
//!   than silently hand the model a placeholder in place of the image the
//!   sender just sent.

use base64::Engine;
use serde_json::{Value, json};

pub(crate) fn is_object_source(block: &Value) -> bool {
    block["source"]["type"] == "object"
}

/// Fetch one `object`-source block's bytes from the bucket it names. No
/// fallback: a block naming no bucket is unresolvable, not a guess away from
/// resolvable. Never degrades — the caller decides what a failure means.
async fn fetch_object(
    client: Option<&async_nats::Client>,
    source: &Value,
) -> Result<(Vec<u8>, String), String> {
    let media_type = source["mediaType"]
        .as_str()
        .unwrap_or("application/octet-stream")
        .to_string();
    let Some(id) = source["id"].as_str() else {
        return Err("attachment reference carries no id".to_string());
    };
    let Some(bucket) = source["bucket"].as_str() else {
        return Err("attachment reference carries no bucket".to_string());
    };
    let Some(client) = client else {
        return Err("no object store client configured".to_string());
    };
    let js = async_nats::jetstream::new(client.clone());
    let store = js
        .get_object_store(bucket)
        .await
        .map_err(|e| format!("object store {bucket:?} unavailable: {e}"))?;
    let mut object = store
        .get(id)
        .await
        .map_err(|e| format!("attachment {id:?} not found in {bucket:?}: {e}"))?;
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    object
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| format!("attachment {id:?} read failed: {e}"))?;
    Ok((bytes, media_type))
}

/// Condition at the model-facing edge, never in the store: the record and
/// the transit object stay verbatim (whatever the client sent), and every
/// attachment source — helm, tower, an adopted record — gets the same
/// bounded long edge on its way into a request.
async fn condition(block_type: &str, bytes: Vec<u8>, media_type: String) -> (Vec<u8>, String) {
    if block_type == "image" {
        crate::imaging::condition_image(bytes, &media_type).await
    } else {
        (bytes, media_type)
    }
}

/// Resolve every `object`-source block in a model-facing history, in place.
/// This runs at request-build over the WHOLE history, not just the fresh
/// say: the tree (and any adopted record) holds reference blocks verbatim,
/// and the API must never see one. Fetch and inline as base64; unknown
/// source kinds and failed fetches degrade to a placeholder text block
/// carrying what the block itself states (media type, size) — this is
/// replay, so a failure here is ageing, not a live bug (module doc).
pub async fn resolve_history(client: &async_nats::Client, history: &mut [Value]) {
    // Cheap scan first: most requests carry no reference blocks at all.
    let needs = history.iter().any(|m| {
        m["content"]
            .as_array()
            .is_some_and(|blocks| blocks.iter().any(is_object_source))
    });
    if !needs {
        return;
    }
    // Every block resolves concurrently: fetches overlap on the wire and
    // conditioning overlaps on the blocking pool (imaging.rs), so a history
    // with many images pays for the slowest one, not the sum.
    let mut slots: Vec<&mut Value> = Vec::new();
    for message in history.iter_mut() {
        let Some(blocks) = message["content"].as_array_mut() else {
            continue;
        };
        slots.extend(blocks.iter_mut().filter(|b| is_object_source(b)));
    }
    let resolved =
        futures::future::join_all(slots.iter().map(|b| resolve_one(Some(client), b))).await;
    for (slot, value) in slots.into_iter().zip(resolved) {
        *slot = value;
    }
}

async fn resolve_one(client: Option<&async_nats::Client>, block: &Value) -> Value {
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

    let Ok((bytes, media_type)) = fetch_object(client, source).await else {
        return placeholder();
    };
    let block_type = block["type"].as_str().unwrap_or("image").to_string();
    let (bytes, media_type) = condition(&block_type, bytes, media_type).await;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    json!({
        "type": block_type,
        "source": { "type": "base64", "media_type": media_type, "data": data },
    })
}

/// Validate every fresh `object`-source block a say just carried in — before
/// anything commits. Unlike history replay, a failure here is never
/// ageing: it means the object this say just referenced genuinely isn't
/// there (no bucket named, wrong bucket, dropped upload, unreachable store),
/// so the whole say must reject rather than let the model see a placeholder
/// in place of what the sender actually attached (module doc).
pub async fn validate_fresh(
    client: &async_nats::Client,
    attachments: &[Value],
) -> Result<(), String> {
    for block in attachments {
        if is_object_source(block) {
            fetch_object(Some(client), &block["source"]).await?;
        }
    }
    Ok(())
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
            "source": { "type": "object", "id": "abc", "bucket": "attach", "mediaType": "image/png", "size": 2048 },
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
            "source": { "type": "object", "bucket": "attach", "mediaType": "application/pdf", "size": 10 },
        });
        let out = resolve_one(None, &block).await;
        assert_eq!(out["type"], "text");
        assert!(out["text"].as_str().unwrap().contains("application/pdf"));
    }

    #[tokio::test]
    async fn a_source_without_a_bucket_is_a_placeholder_in_replay() {
        let block = json!({
            "type": "image",
            "source": { "type": "object", "id": "abc", "mediaType": "image/png", "size": 2048 },
        });
        let out = resolve_one(None, &block).await;
        assert_eq!(out["type"], "text");
    }
}

