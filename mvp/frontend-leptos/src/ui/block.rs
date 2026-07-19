//! One content block, rendered per type — mirrors mvp/frontend's
//! BlockView.svelte: text stands open, everything else (thinking, tool
//! traffic, unknown blocks) collapses to a summary line via `<details>`, the
//! primary render lever for per-message collapsing (docs/mvp/tower-v1-design.md,
//! weight-as-refs note).

use leptos::prelude::*;
use serde_json::Value;

use super::refview::{RefView, is_ref};
use super::truncate;

fn object_source(source: &Value) -> Option<&Value> {
    (source.get("type").and_then(Value::as_str) == Some("object")).then_some(source)
}

fn size_label(source: &Value) -> String {
    let n = source.get("size").and_then(Value::as_i64).unwrap_or(0);
    if n <= 0 {
        String::new()
    } else if n < 1024 {
        format!("· {n} B")
    } else if n < 1024 * 1024 {
        format!("· {} KB", n / 1024)
    } else {
        format!("· {:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

fn short(v: &Value, max: usize) -> String {
    let s = v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
    truncate(&s, max)
}

pub fn render_block(block: &Value) -> AnyView {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            view! { <div class="block text">{text}</div> }.into_any()
        }
        Some("thinking") => {
            let thinking = block
                .get("thinking")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            view! {
                <details class="block thinking">
                    <summary>"thinking"</summary>
                    <div class="block-body">{thinking}</div>
                </details>
            }
            .into_any()
        }
        Some("tool_use") => {
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            let preview = short(&input, 120);
            let full = serde_json::to_string_pretty(&input).unwrap_or_default();
            view! {
                <details class="block tool">
                    <summary>{format!("⚒ {name}")}" "<span class="dim">{preview}</span></summary>
                    <pre class="block-body">{full}</pre>
                </details>
            }
            .into_any()
        }
        Some("tool_result") => {
            let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let content = block.get("content").cloned().unwrap_or(Value::Null);
            let label = if is_error { "↩ result (error)" } else { "↩ result" };
            if is_ref(&content) {
                return view! { <RefView r=content label=label /> }.into_any();
            }
            let preview = short(&content, 120);
            let full = content
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string_pretty(&content).unwrap_or_default());
            view! {
                <details class="block tool">
                    <summary>{label}" "<span class="dim">{preview}</span></summary>
                    <pre class="block-body">{full}</pre>
                </details>
            }
            .into_any()
        }
        Some("image") => {
            let source = block.get("source").cloned().unwrap_or(Value::Null);
            if is_ref(&source) {
                view! { <RefView r=source label="🖼 image" image=true /> }.into_any()
            } else if let Some(obj) = object_source(&source) {
                let media = obj.get("mediaType").and_then(Value::as_str).unwrap_or("image").to_owned();
                let id = obj.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                let summary = format!("📎 {media} {} (attachment)", size_label(obj));
                let failed = RwSignal::new(false);
                view! {
                    <details class="block">
                        <summary>{summary}</summary>
                        {move || if failed.get() {
                            view! { <span class="dim">"preview expired — the transit object is gone"</span> }.into_any()
                        } else {
                            view! {
                                <img
                                    class="attachment-preview"
                                    src=format!("/attachment/{id}")
                                    alt=media.clone()
                                    on:error=move |_| failed.set(true)
                                />
                            }.into_any()
                        }}
                    </details>
                }
                .into_any()
            } else {
                view! { <span class="dim">"🖼 image (inline)"</span> }.into_any()
            }
        }
        Some("document") => {
            let source = block.get("source").cloned().unwrap_or(Value::Null);
            if is_ref(&source) {
                view! { <RefView r=source label="📄 document" /> }.into_any()
            } else if let Some(obj) = object_source(&source) {
                let media = obj.get("mediaType").and_then(Value::as_str).unwrap_or("document").to_owned();
                let id = obj.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                let label = format!("📎 {media} {} (attachment)", size_label(obj));
                view! {
                    <a class="dim" href=format!("/attachment/{id}") target="_blank" rel="noreferrer">{label}</a>
                }
                .into_any()
            } else {
                view! { <span class="dim">"📄 document (inline)"</span> }.into_any()
            }
        }
        Some(other) => {
            let full = serde_json::to_string_pretty(block).unwrap_or_default();
            let other = other.to_owned();
            view! {
                <details class="block">
                    <summary>{other}</summary>
                    <pre class="block-body">{full}</pre>
                </details>
            }
            .into_any()
        }
        None => view! { <span class="dim">"[block]"</span> }.into_any(),
    }
}
