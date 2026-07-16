//! uploads — the attachment upload, the frontend's SECOND concurrency boundary
//! (docs/mvp/tower-ws-spec.md, POST /attachment). Like the socket, it is handled
//! by communicating: the async work (file pick + HTTP) is spawned, and its
//! result returns to the app over a channel, folded like any wire frame. There
//! is no shared mutable write across an await — the exact shape that froze the
//! Svelte app (a `$state` write mid-flush) cannot occur here.
//!
//! Wasm-only: it drives the browser file dialog and fetch. The app owns the
//! receiver and drains it each frame; the conversation concern folds the ref.

use std::sync::mpsc::Sender;

use serde_json::{Value, json};

/// One completed upload, delivered to the app over a channel.
pub struct Upload {
    pub conv: String,
    pub attachment: Value,
}

/// Pick a file, upload its bytes to POST /attachment, and send the resulting
/// AttachmentRef back over `tx`. All async work is spawned; this returns at
/// once and never touches the render or any concern.
pub fn pick_and_upload(conv: String, tx: Sender<Upload>) {
    wasm_bindgen_futures::spawn_local(async move {
        let Some(file) = rfd::AsyncFileDialog::new().pick_file().await else {
            return; // the user dismissed the dialog
        };
        let mime = mime_from_name(&file.file_name());
        let bytes = file.read().await;
        let mut request = ehttp::Request::post("/attachment", bytes);
        request.headers.insert("Content-Type", mime);
        ehttp::fetch(request, move |result| match result {
            Ok(res) if res.ok => match attachment_ref(&res.bytes) {
                Some(attachment) => {
                    let _ = tx.send(Upload { conv, attachment });
                }
                None => log("upload: unparseable /attachment response"),
            },
            Ok(res) => log(&format!("upload failed: {}", res.status)),
            Err(err) => log(&format!("upload error: {err}")),
        });
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
/// header, and the browser File's own type is not exposed through the handle.
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

fn log(msg: &str) {
    web_sys::console::log_1(&msg.into());
}
