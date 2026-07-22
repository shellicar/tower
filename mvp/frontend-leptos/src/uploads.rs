//! uploads — the attachment upload, the frontend's SECOND concurrency boundary
//! (docs/mvp/tower-ws-spec.md, POST /attachment). Like the socket, it is handled
//! by communicating: the async work (read + HTTP) is spawned, and its result
//! reaches the app through a callback, folded like any wire frame. There is no
//! shared mutable write across an await — the exact shape that froze the
//! Svelte app (a `$state` write mid-flush) cannot occur here.
//!
//! Shape difference from frontend-rs's uploads.rs: that build drives `rfd`'s
//! file dialog itself, because egui draws its own UI with no DOM underneath.
//! Here the file picker is a real `<input type="file">` element — the browser
//! gives it for free — so this module starts one step later, from a
//! `web_sys::File` the component already has in hand. The upload (read bytes,
//! POST, parse the ref) is the same shape either way: async, spawned, result
//! delivered as a message.
//!
//! Wasm-only: it reads a browser File and calls fetch. The app folds the
//! resulting ref into the conversation concern.

use serde_json::{Value, json};

/// Uploads one file. `on_done` fires with the won ref on success (it rides
/// the next say — the caller already knows which conversation, so only the
/// ref comes back); `on_error` carries a human-readable reason for the
/// composer's upload-note line (mvp/frontend's `uploadNote`); `on_settled`
/// always fires last, success or failure, so the caller can drop its
/// "uploading…" count without duplicating the outcome match.
#[cfg(target_arch = "wasm32")]
pub fn pick_and_upload(
    file: web_sys::File,
    on_done: impl Fn(Value) + 'static,
    on_error: impl Fn(String) + 'static,
    on_settled: impl Fn() + 'static,
) {
    wasm_bindgen_futures::spawn_local(async move {
        let mime = mime_from_name(&file.name());
        match upload(&file, mime).await {
            Ok(attachment) => on_done(attachment),
            Err(reason) => {
                log(&format!("upload: {reason}"));
                on_error(reason);
            }
        }
        on_settled();
    });
}

#[cfg(target_arch = "wasm32")]
async fn upload(file: &web_sys::File, mime: &str) -> Result<Value, String> {
    use gloo_net::http::Request;
    use wasm_bindgen_futures::JsFuture;

    let buf = JsFuture::from(file.array_buffer())
        .await
        .map_err(|err| format!("failed to read file: {err:?}"))?;
    let bytes = js_sys::Uint8Array::new(&buf).to_vec();

    let request = Request::post("/attachment")
        .header("Content-Type", mime)
        .body(bytes)
        .map_err(|err| format!("failed to build request: {err}"))?;
    let res = request.send().await.map_err(|err| format!("{err}"))?;
    if !res.ok() {
        return Err(format!("upload failed: {}", res.status()));
    }
    let body = res
        .binary()
        .await
        .map_err(|err| format!("failed to read response: {err}"))?;
    attachment_ref(&body).ok_or_else(|| "unparseable /attachment response".to_owned())
}

/// Build the say's AttachmentRef from the transit store's reply
/// (`{ id, mediaType, size, bucket }`), per the ws-spec attachment shape.
/// `bucket` names the store the object actually landed in — carried
/// verbatim so the servicer resolves against the bucket the object is
/// really in, never a guess from its own deployment config
/// (docs/mvp/bridge-stdio-spec.md). Missing it is a malformed reply, not
/// something to paper over: the whole point is that a block with no bucket
/// cannot be resolved, so a reply without one yields no ref at all.
fn attachment_ref(body: &[u8]) -> Option<Value> {
    let meta: Value = serde_json::from_slice(body).ok()?;
    let id = meta.get("id")?.as_str()?;
    let bucket = meta.get("bucket")?.as_str()?;
    let media = meta
        .get("mediaType")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let size = meta.get("size").and_then(Value::as_i64).unwrap_or(0);
    let kind = if media.starts_with("image/") {
        "image"
    } else {
        "document"
    };
    Some(json!({
        "type": kind,
        "source": { "type": "object", "id": id, "bucket": bucket, "mediaType": media, "size": size },
    }))
}

/// A coarse content type from the file name — towerd trusts the Content-Type
/// header, and the input element's own `type` is unreliable across browsers.
fn mime_from_name(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(target_arch = "wasm32")]
fn log(msg: &str) {
    web_sys::console::log_1(&msg.into());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_media_type_maps_to_image_or_document() {
        let img = attachment_ref(br#"{"id":"o1","bucket":"attach","mediaType":"image/png","size":10}"#).unwrap();
        assert_eq!(img["type"], "image");
        assert_eq!(img["source"]["bucket"], "attach");
        let doc = attachment_ref(br#"{"id":"o2","bucket":"attach","mediaType":"application/pdf","size":10}"#).unwrap();
        assert_eq!(doc["type"], "document");
    }

    #[test]
    fn an_unparseable_body_yields_none() {
        assert!(attachment_ref(b"not json").is_none());
    }

    #[test]
    fn a_reply_missing_the_bucket_yields_none() {
        assert!(attachment_ref(br#"{"id":"o1","mediaType":"image/png","size":10}"#).is_none());
    }
}
