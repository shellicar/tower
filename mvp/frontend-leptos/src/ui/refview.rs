//! A `$ref` node — mirrors mvp/frontend's RefView.svelte. The protocol
//! supplies facts only (id, size, hint); materialising it is entirely this
//! client's policy: nothing fetches until asked ("load · 513 KB"), text
//! renders inline, images become a data URL. `/ref/{id}` is this client's
//! own route knowledge, never carried in the data (docs/mvp/tower-ws-spec.md).

use leptos::prelude::*;
use serde_json::Value;

/// True when `v` is a `$ref` node (an object with a string `$ref` field) —
/// mirrors `types.ts`'s `isRef`.
pub fn is_ref(v: &Value) -> bool {
    v.get("$ref").and_then(Value::as_str).is_some()
}

fn size_label(bytes: i64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

#[derive(Clone)]
enum Loaded {
    None,
    Text(String),
    DataUrl(String),
    Failed,
}

#[component]
pub fn RefView(r: Value, label: &'static str, #[prop(default = false)] image: bool) -> impl IntoView {
    let ref_id = r.get("$ref").and_then(Value::as_str).unwrap_or_default().to_owned();
    let hint = r.get("hint").and_then(Value::as_str).unwrap_or_default().to_owned();
    let size = r.get("size").and_then(Value::as_i64).unwrap_or(0);

    let loaded = RwSignal::new(Loaded::None);

    let load = {
        let ref_id = ref_id.clone();
        move |_| {
            let ref_id = ref_id.clone();
            loaded.set(Loaded::None);
            wasm_bindgen_futures::spawn_local(async move {
                let outcome = fetch_ref(&ref_id, image).await;
                loaded.set(outcome.unwrap_or(Loaded::Failed));
            });
        }
    };

    view! {
        {move || match loaded.get() {
            Loaded::DataUrl(src) => view! { <img class="ref-image" src=src alt=hint.clone() /> }.into_any(),
            Loaded::Text(text) => view! { <pre class="ref-text">{text}</pre> }.into_any(),
            Loaded::Failed => {
                view! { <span class="dim">{format!("{label} · {} · fetch failed", size_label(size))}</span> }
                    .into_any()
            }
            Loaded::None => {
                view! {
                    <button class="ref-load" on:click=load.clone()>
                        {format!("{label} · {hint} · load {}", size_label(size))}
                    </button>
                }
                    .into_any()
            }
        }}
    }
}

#[cfg(target_arch = "wasm32")]
async fn fetch_ref(id: &str, image: bool) -> Option<Loaded> {
    use gloo_net::http::Request;

    let res = Request::get(&format!("/ref/{id}")).send().await.ok()?;
    if !res.ok() {
        return None;
    }
    if image {
        // The stored value is the source object's JSON ({ media_type, data }).
        let source: Value = res.json().await.ok()?;
        let media_type = source.get("media_type").and_then(Value::as_str)?;
        let data = source.get("data").and_then(Value::as_str)?;
        Some(Loaded::DataUrl(format!("data:{media_type};base64,{data}")))
    } else {
        Some(Loaded::Text(res.text().await.ok()?))
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn fetch_ref(_id: &str, _image: bool) -> Option<Loaded> {
    None
}
