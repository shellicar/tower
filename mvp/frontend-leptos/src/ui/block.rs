//! One content block, rendered per type — mirrors mvp/frontend's
//! BlockView.svelte: text stands open, everything else (thinking, tool
//! traffic, unknown blocks) collapses to a summary line via `<details>`, the
//! primary render lever for per-message collapsing (docs/mvp/tower-v1-design.md,
//! weight-as-refs note).

use leptos::prelude::*;
use serde_json::Value;

use super::truncate;

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
            let preview = short(&content, 120);
            let full = content
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string_pretty(&content).unwrap_or_default());
            let label = if is_error { "↩ result (error)" } else { "↩ result" };
            view! {
                <details class="block tool">
                    <summary>{label}" "<span class="dim">{preview}</span></summary>
                    <pre class="block-body">{full}</pre>
                </details>
            }
            .into_any()
        }
        Some("image") => view! { <span class="dim">"🖼 image"</span> }.into_any(),
        Some("document") => view! { <span class="dim">"📄 document"</span> }.into_any(),
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
