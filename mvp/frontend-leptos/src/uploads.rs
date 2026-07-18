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

/// One completed upload, delivered to the app via callback.
pub struct Upload {
    pub conv: String,
    pub attachment: Value,
}

#[cfg(target_arch = "wasm32")]
pub fn pick_and_upload(conv: String, file: web_sys::File, on_done: impl Fn(Upload) + 'static) {
    use gloo_net::http::Request;
    use wasm_bindgen_futures::JsFuture;

    wasm_bindgen_futures::spawn_local(async move {
        let mime = mime_from_name(&file.name());
        let buf = match JsFuture::from(file.array_buffer()).await {
            Ok(buf) => buf,
            Err(err) => {
                log(&format!("upload: failed to read file: {err:?}"));
                return;
            }
        };
        let bytes = js_sys::Uint8Array::new(&buf).to_vec();

        let request = match Request::post("/attachment")
            .header("Content-Type", mime)
            .body(bytes)
        {
            Ok(r) => r,
            Err(err) => {
                log(&format!("upload: failed to build request: {err}"));
                return;
            }
        };
        match request.send().await {
            Ok(res) if res.ok() => match res.binary().await {
                Ok(body) => match attachment_ref(&body) {
                    Some(attachment) => on_done(Upload { conv, attachment }),
                    None => log("upload: unparseable /attachment response"),
                },
                Err(err) => log(&format!("upload: failed to read response: {err}")),
            },
            Ok(res) => log(&format!("upload failed: {}", res.status())),
            Err(err) => log(&format!("upload error: {err}")),
        }
    });
}

/// Build the say's AttachmentRef from the transit store's reply
/// (`{ id, mediaType, size }`), per the ws-spec attachment shape.
fn attachment_ref(body: &[u8]) -> Option<Value> {
    let meta: Value = serde_json::from_slice(body).ok()?;
    let id = meta.get("id")?.as_str()?;
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
        "source": { "type": "object", "id": id, "mediaType": media, "size": size },
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
        let img = attachment_ref(br#"{"id":"o1","mediaType":"image/png","size":10}"#).unwrap();
        assert_eq!(img["type"], "image");
        let doc = attachment_ref(br#"{"id":"o2","mediaType":"application/pdf","size":10}"#).unwrap();
        assert_eq!(doc["type"], "document");
    }

    #[test]
    fn an_unparseable_body_yields_none() {
        assert!(attachment_ref(b"not json").is_none());
    }
}
