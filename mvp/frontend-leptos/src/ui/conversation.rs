//! The open conversation panel: reads `conversations`, `approvals`, and
//! `rail` (the header title, `lastKind`/staleness — the read/write split
//! Rust gives for free, mvp/docs/frontend-architecture.md). Owns its own
//! local UI state (the composer draft, attachment chips, the scroll anchor,
//! the title editor) — a component's state, per the architecture doc, never
//! a concern's. Tracks mvp/frontend-svelte's ConversationPanel.svelte feature for
//! feature, including usage/pricing and attachments — the slice grew past
//! mvp/docs/frontend-leptos-plan.md's original frontend-rs-only scope once
//! the plan's question 2 (full Svelte parity) was answered. Tabs live in
//! `ui/tabs.rs` and the `view` concern instead.
//!
//! `oc` (this conversation's own `RwSignal<ConversationState>`) is a `Copy`
//! handle fetched once by the composition root and passed down, not looked
//! up from a shared `Conversations` signal on every render — that's what
//! gives this panel its OWN reactive scope, isolated from every other open
//! panel (a delta in another conversation cannot invalidate this one).
//!
//! `conv` is held as a `StoredValue<String>` (Copy), not a plain `String`:
//! this view has a dozen reactive closures that each need the conversation
//! id, and a plain `String` can only be moved into the first one — every
//! later closure fails to borrow-check ("use of moved value"). `StoredValue`
//! is Leptos's answer to exactly this: a `Copy` handle every closure can
//! capture independently, cloning the string out only where one is needed.

use std::collections::HashMap;

use leptos::ev;
use leptos::html;
use leptos::prelude::*;
use send_wrapper::SendWrapper;
use serde_json::Value;
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
use ws_types::WsMessage;

use crate::concerns::approvals::{Approvals, ask_input, ask_label};
use crate::concerns::conversation::{ConversationState, QueryState};
use crate::concerns::rail::Rail;
use crate::concerns::usage::Usage;
use crate::pricing::{format_tokens, format_usd, parse_model_name, price_usage};
use crate::time::{Millis, age, format_time};
use crate::ui::block::render_block;
use crate::ui::truncate;
use crate::uploads;

/// Fallback row height (px) for a message never yet measured — ported from
/// mvp/frontend-svelte's VirtualList.svelte `estimate` default. Deliberately flat,
/// same inherited minor defect (under-reports totalHeight, short scrollbar);
/// parity means inheriting this, not fixing it here.
const ROW_ESTIMATE_PX: f64 = 96.0;
/// Extra px windowed beyond the viewport on each side, so a small scroll
/// doesn't pop rows in at the edge — same value as VirtualList.svelte.
const OVERSCAN_PX: f64 = 600.0;

fn draft_key(conv: &str) -> String {
    format!("tower.draft.{conv}")
}

fn load_draft(conv: &str) -> String {
    web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .and_then(|s| s.get_item(&draft_key(conv)).ok().flatten())
        .unwrap_or_default()
}

/// Persisted on every keystroke — mvp/frontend-svelte debounces this (a synchronous
/// write per keystroke is main-thread I/O the typing loop doesn't need); this
/// build accepts that cost for now rather than reproduce the debounce timer.
fn save_draft(conv: &str, value: &str) {
    let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) else {
        return;
    };
    let key = draft_key(conv);
    if value.is_empty() {
        let _ = storage.remove_item(&key);
    } else {
        let _ = storage.set_item(&key, value);
    }
}

fn size_label(v: &Value) -> String {
    let n = v
        .get("source")
        .and_then(|s| s.get("size"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if n <= 0 {
        String::new()
    } else if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{} KB", n / 1024)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

/// Prefix offset (px) of each message's top edge, given the current height
/// cache — unmeasured rows count as `ROW_ESTIMATE_PX`. Ported from
/// VirtualList.svelte's `offsets` derivation: O(n) is fine, CLAUDE.md's
/// workload facts cap n at a few thousand.
fn message_offsets(messages: &[WsMessage], heights: &HashMap<String, f64>) -> Vec<f64> {
    let mut y = 0.0;
    let mut out = Vec::with_capacity(messages.len());
    for m in messages {
        out.push(y);
        y += heights.get(&m.id).copied().unwrap_or(ROW_ESTIMATE_PX);
    }
    out
}

fn total_height(messages: &[WsMessage], offsets: &[f64], heights: &HashMap<String, f64>) -> f64 {
    match messages.last() {
        None => 0.0,
        Some(last) => {
            offsets[messages.len() - 1] + heights.get(&last.id).copied().unwrap_or(ROW_ESTIMATE_PX)
        }
    }
}

/// First index whose offset is <= target — offsets is ascending (binary search,
/// ported verbatim from VirtualList.svelte's `findStart`).
fn find_start(offsets: &[f64], target: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = offsets.len();
    while lo < hi {
        let mid = (lo + hi) / 2;
        if offsets[mid] <= target {
            lo = mid + 1
        } else {
            hi = mid
        }
    }
    lo.saturating_sub(1)
}

/// The `[start, end)` window of message indices to actually mount, given the
/// current scroll position — everything else is represented by a spacer.
fn visible_range(
    offsets: &[f64],
    messages_len: usize,
    scroll_top: f64,
    viewport_height: f64,
) -> (usize, usize) {
    if messages_len == 0 {
        return (0, 0);
    }
    let top = (scroll_top - OVERSCAN_PX).max(0.0);
    let bottom = scroll_top + viewport_height + OVERSCAN_PX;
    let start = find_start(offsets, top);
    let mut end = start;
    while end < messages_len && offsets[end] < bottom {
        end += 1;
    }
    (start, end.min(messages_len))
}

fn media_label(v: &Value) -> String {
    v.get("source")
        .and_then(|s| s.get("mediaType"))
        .and_then(Value::as_str)
        .or_else(|| v.get("type").and_then(Value::as_str))
        .unwrap_or("file")
        .to_owned()
}

/// The conversation's cost surface: towerd ships the token facts, priced
/// here ($ and context %) — the client owns that policy, same split as
/// mvp/frontend-svelte's `ConversationPanel.svelte`. Model leads the line: it's a
/// per-conversation fact (a spawn may name its own, mvp/docs/bridge-stdio-
/// spec.md), read off THIS conversation's own usage snapshot — never a
/// host-wide default — same footing claude-sdk-cli gives it front and
/// centre in its own status line.
fn price_usage_line(u: &ws_types::WsUsage) -> impl IntoView + use<> {
    let p = price_usage(u);
    let (name, version) = parse_model_name(&u.model);
    // U+26A1 defaults to TEXT presentation in the Unicode emoji spec (unlike
    // most emoji, which default to colour) — without the U+FE0F variation
    // selector a browser renders it as a plain monochrome glyph, not the
    // colour bolt.
    let model_label = match version {
        Some(v) => format!("⚡\u{fe0f} {name} {v}"),
        None => format!("⚡\u{fe0f} {name}"),
    };
    view! {
        <p class="usage-line">
            <span class="model" title=u.model.clone()>{model_label}</span>
            <span>{format!("in {}", format_tokens(u.input_tokens))}</span>
            <span title="cache write">{format!("↑{}", format_tokens(u.cache_creation_tokens))}</span>
            <span title="cache read">{format!("↓{}", format_tokens(u.cache_read_tokens))}</span>
            <span>{format!("out {}", format_tokens(u.output_tokens))}</span>
            <span class="cost">{format_usd(p.cost_usd)}</span>
            <span title="context window used">
                {format!("ctx {}/{} ({:.1}%)", format_tokens(p.context_used), format_tokens(p.context_max), p.context_pct)}
            </span>
            <span>{format!("turns {}", u.turns)}</span>
        </p>
    }
}

#[component]
pub fn ConversationView(
    conv: String,
    rail: RwSignal<Rail>,
    oc: RwSignal<ConversationState>,
    approvals: RwSignal<Approvals>,
    usage: RwSignal<Usage>,
    now: RwSignal<Millis>,
    on_send: Callback<String>,
    on_cancel: Callback<()>,
    on_attach: Callback<Value>,
    on_answer: Callback<(String, bool)>,
    on_set_title: Callback<String>,
    on_close: Callback<()>,
) -> impl IntoView {
    let conv = StoredValue::new_local(conv);
    let draft = RwSignal::new(conv.with_value(|c| load_draft(c)));
    let editor_ref = NodeRef::<html::Textarea>::new();
    let messages_ref = NodeRef::<html::Div>::new();
    // Stick-to-bottom while reading live; a manual scroll up drops it, and
    // the "latest" button offers the way back down.
    let at_bottom = RwSignal::new(true);
    let scroll_to_bottom = move || {
        if let Some(el) = messages_ref.get() {
            el.set_scroll_top(el.scroll_height());
        }
        at_bottom.set(true);
    };
    // Windowing state, ported from mvp/frontend-svelte's VirtualList.svelte: a
    // per-message-id height cache (unmeasured rows fall back to
    // `ROW_ESTIMATE_PX`), plus the scroller's own scroll position and
    // viewport height, both needed to derive which messages are actually
    // mounted. Component-local, same footing as `at_bottom`/`draft` above.
    let heights = RwSignal::new(HashMap::<String, f64>::new());
    let scroll_top = RwSignal::new(0.0_f64);
    let viewport_height = RwSignal::new(0.0_f64);
    // Tracks the scroller's own size (not a row's) so the window grows/
    // shrinks with the panel — mirrors VirtualList.svelte's viewportHeight
    // effect, which reads the same ResizeObserver entry already needed for
    // width there; this build has no prediction phase, so only height.
    Effect::new(move |_| {
        let Some(el) = messages_ref.get() else { return };
        viewport_height.set(el.client_height() as f64);
        let closure = Closure::<dyn FnMut(js_sys::Array)>::new(move |entries: js_sys::Array| {
            if let Some(entry) = entries.get(0).dyn_ref::<web_sys::ResizeObserverEntry>() {
                viewport_height.set(entry.content_rect().height());
            }
        });
        let Ok(ro) = web_sys::ResizeObserver::new(closure.as_ref().unchecked_ref()) else {
            return;
        };
        ro.observe(&el);
        // wasm32 is single-threaded; `on_cleanup` demands Send + Sync only
        // because reactive_graph is shared with leptos's multi-threaded ssr
        // target — SendWrapper is the accepted way to hand it a !Send
        // Closure that a real thread will never actually touch.
        let guard = SendWrapper::new((ro, closure));
        on_cleanup(move || {
            let (ro, _closure) = guard.take();
            ro.disconnect();
        });
    });
    let message_offsets_signal = Memo::new(move |_| {
        let full = oc.with(|s| s.messages.clone());
        let h = heights.get();
        message_offsets(&full, &h)
    });
    let visible_range_signal = Memo::new(move |_| {
        let len = oc.with(|s| s.messages.len());
        let offs = message_offsets_signal.get();
        visible_range(&offs, len, scroll_top.get(), viewport_height.get())
    });
    // Local upload state — a component's own, per the architecture doc; the
    // concern only ever holds the ref once it's won (`on_attach`).
    let uploading = RwSignal::new(0u32);
    let upload_error = RwSignal::new(String::new());

    let editing_title = RwSignal::new(false);
    let title_draft = RwSignal::new(String::new());
    let title_input_ref = NodeRef::<html::Input>::new();

    // The input never receives focus just by appearing (unlike Svelte's
    // `autofocus` attribute, there's no Leptos equivalent) — without this,
    // "click out" has nothing to blur, so commit never fires and only a
    // direct click into the input, then Enter, works. Runs after the DOM
    // patch so the node exists.
    Effect::new(move |_| {
        if editing_title.get()
            && let Some(el) = title_input_ref.get()
        {
            let _ = el.focus();
            el.select();
        }
    });

    let send_current = Callback::new(move |()| {
        let text = draft.get_untracked();
        let allowed = oc.with(|s| {
            s.can_send(
                text.trim().is_empty(),
                !s.pending_attachments.is_empty(),
                uploading.get_untracked() > 0,
            )
        });
        if !allowed {
            return;
        }
        conv.with_value(|c| save_draft(c, ""));
        draft.set(String::new());
        on_send.run(text);
    });

    let handle_files = Callback::new(move |files: web_sys::FileList| {
        for i in 0..files.length() {
            let Some(file) = files.get(i) else { continue };
            uploading.update(|n| *n += 1);
            uploads::pick_and_upload(
                file,
                move |attachment| on_attach.run(attachment),
                move |reason| upload_error.set(reason),
                move || uploading.update(|n| *n = n.saturating_sub(1)),
            );
        }
    });

    // Stick to the bottom while new content arrives and the reader hasn't
    // scrolled away. Reads only THIS panel's `oc` — another open
    // conversation's activity never fires this effect — which means it now
    // fires exactly once per real update instead of also being nudged by
    // unrelated traffic the way the old shared-signal version was. That
    // exposed a real race: the effect itself runs before the browser has
    // laid out the newly patched message DOM, so `scroll_height()` read
    // synchronously here is still the OLD (smaller) height — observed live
    // as a conversation opening at the top and the "latest" button never
    // appearing (the scroll position and `at_bottom` both got set against
    // stale geometry). Deferring to the next animation frame, same trick
    // `autosize` already uses, reads geometry after layout instead.
    Effect::new(move |_| {
        let count = oc.with(|s| s.messages.len() + s.streaming.len());
        let _ = count; // the dependency that re-triggers this effect
        if at_bottom.get_untracked() {
            request_animation_frame(move || {
                if let Some(el) = messages_ref.get() {
                    // Never read scroll_height() to compute this: that read
                    // forces a synchronous layout right then, and profiling
                    // live (21 Jul) showed Layout as the dominant cost with
                    // several panels streaming at once. Writing a constant
                    // far past any real height needs no read at all — the
                    // browser clamps scroll_top to the actual max for you.
                    el.set_scroll_top(1_000_000_000);
                }
            });
        }
    });

    // A revoked say comes home whole: words prepended to the draft (a newer
    // half-typed thought survives), files back to the pending set — the
    // concern already restores attachments into `pending_attachments`
    // itself, so only the text needs handling here.
    Effect::new(move |_| {
        let restore = oc.with(|s| s.restore_say.clone());
        if let Some(restore) = restore {
            draft.update(|d| {
                *d = if d.is_empty() {
                    restore
                } else {
                    format!("{restore}\n{d}")
                };
            });
            oc.update(|s| {
                s.restore_say = None;
                s.restore_attachments.clear();
            });
        }
    });

    let start_title_edit = Callback::new(move |()| {
        let held = conv.with_value(|c| rail.with(|r| r.row(c).and_then(|row| row.title.clone())));
        title_draft.set(held.unwrap_or_default());
        editing_title.set(true);
    });
    let commit_title = Callback::new(move |()| {
        if !editing_title.get_untracked() {
            return;
        }
        editing_title.set(false);
        on_set_title.run(title_draft.get_untracked().trim().to_owned());
    });

    view! {
        <div class="conversation-inner">
            <header class="conversation-header">
                {move || {
                    if editing_title.get() {
                        view! {
                            <input
                                class="title-editor"
                                node_ref=title_input_ref
                                prop:value=move || title_draft.get()
                                on:input=move |ev| title_draft.set(event_target_value(&ev))
                                on:blur=move |_| commit_title.run(())
                                on:keydown=move |ev: ev::KeyboardEvent| match ev.key().as_str() {
                                    "Enter" => commit_title.run(()),
                                    "Escape" => editing_title.set(false),
                                    _ => {}
                                }
                            />
                        }
                        .into_any()
                    } else {
                        let label = conv.with_value(|c| {
                            rail.with(|r| r.row(c).and_then(|row| row.title.clone()))
                                .unwrap_or_else(|| c.to_owned())
                        });
                        view! {
                            <button class="title" on:click=move |_| start_title_edit.run(())>{label}</button>
                        }
                        .into_any()
                    }
                }}
                <button class="close" on:click=move |_| on_close.run(())>"×"</button>
            </header>
            {move || {
                let loaded = oc.with(|s| s.loaded);
                (!loaded).then(|| view! { <p class="opening">"loading…"</p> })
            }}
            <div
                class="messages"
                node_ref=messages_ref
                on:scroll=move |_| {
                    if let Some(el) = messages_ref.get() {
                        let top = el.scroll_top() as f64;
                        let gap = el.scroll_height() - el.scroll_top() - el.client_height();
                        at_bottom.set(gap < 32);
                        scroll_top.set(top);
                    }
                }
            >
                // Windowed: only messages within `visible_range_signal` (plus
                // overscan) are actually mounted, spacers stand in for the
                // rest — the technique from VirtualList.svelte, ported (keyed
                // `<For>`, height cache, spacer-before/after). Each row's own
                // ResizeObserver (below) is the authority on its real height;
                // the estimate only has to get the scrollbar roughly right
                // before a row has ever been mounted (memory 666f3737: any
                // DOM-free prediction diverges from the engine at some wrap
                // boundary — never remove the observer on the argument the
                // estimate is accurate, and this build doesn't even attempt
                // prediction, so the observer is the ONLY source of truth).
                <div style=move || format!("height: {}px", message_offsets_signal.get().get(visible_range_signal.get().0).copied().unwrap_or(0.0))></div>
                <For
                    each=move || {
                        let (start, end) = visible_range_signal.get();
                        oc.with(|s| s.messages[start..end].to_vec())
                    }
                    key=|m| m.id.clone()
                    let(m)
                >
                    {
                        let cls = match m.role.as_str() {
                            "user" => "user",
                            "assistant" => "assistant",
                            _ => "other",
                        };
                        // Absent `from` is real: a tool_result carries no sender
                        // (a mechanical delivery, not an utterance — nothing is
                        // fabricated to fill the slot).
                        let who = match &m.from {
                            Some(from) => from
                                .get("userId")
                                .and_then(Value::as_str)
                                .or_else(|| from.get("kind").and_then(Value::as_str))
                                .unwrap_or(&m.role)
                                .to_owned(),
                            None => "tool".to_owned(),
                        };
                        let time = format_time(m.ts);
                        let blocks: Vec<AnyView> = m.content.iter().map(|b| render_block(b, &m.role)).collect();
                        let row_id = m.id.clone();
                        let row_ref = NodeRef::<html::Div>::new();
                        // Measures once mounted (mirrors VirtualList.svelte's
                        // `measureAction`: an initial `getBoundingClientRect`
                        // read seeds the cache, then a `ResizeObserver` keeps
                        // it correct on reflow — font load, image decode,
                        // wrap-boundary drift the estimate could never predict).
                        Effect::new(move |_| {
                            let Some(el) = row_ref.get() else { return };
                            let h = el.get_bounding_client_rect().height();
                            if h > 0.0 {
                                heights.update(|hm| {
                                    if hm.get(&row_id) != Some(&h) {
                                        hm.insert(row_id.clone(), h);
                                    }
                                });
                            }
                            let row_id2 = row_id.clone();
                            let closure = Closure::<dyn FnMut(js_sys::Array)>::new(move |entries: js_sys::Array| {
                                if let Some(entry) = entries.get(0).dyn_ref::<web_sys::ResizeObserverEntry>() {
                                    // Border box, to match the mount seed's
                                    // `get_bounding_client_rect` read below —
                                    // `content_rect` excludes padding/border
                                    // and disagreed with the seed by the
                                    // row's own vertical padding, flapping
                                    // the cache on every mount (VirtualList.
                                    // svelte:150 prefers borderBoxSize for
                                    // the same reason; falls back to
                                    // content_rect only if unsupported).
                                    let h = entry
                                        .border_box_size()
                                        .get(0)
                                        .dyn_into::<web_sys::ResizeObserverSize>()
                                        .map(|s| s.block_size())
                                        .unwrap_or_else(|_| entry.content_rect().height());
                                    if h > 0.0 {
                                        heights.update(|hm| {
                                            if hm.get(&row_id2) != Some(&h) {
                                                hm.insert(row_id2.clone(), h);
                                            }
                                        });
                                    }
                                }
                            });
                            let Ok(ro) = web_sys::ResizeObserver::new(closure.as_ref().unchecked_ref()) else {
                                return;
                            };
                            ro.observe(&el);
                            let guard = SendWrapper::new((ro, closure));
                            on_cleanup(move || {
                                let (ro, _closure) = guard.take();
                                ro.disconnect();
                            });
                        });
                        view! {
                            <div class=format!("message {cls}") node_ref=row_ref>
                                <div class="who">
                                    <span class="who-name">{who}</span>
                                    <span class="who-time">{time}</span>
                                </div>
                                {blocks}
                            </div>
                        }
                    }
                </For>
                <div style=move || {
                    let (_, end) = visible_range_signal.get();
                    let offs = message_offsets_signal.get();
                    let full = oc.with(|s| s.messages.clone());
                    let total = total_height(&full, &offs, &heights.get());
                    let mounted_bottom = if end == 0 {
                        0.0
                    } else {
                        offs[end - 1] + heights.get().get(&full[end - 1].id).copied().unwrap_or(ROW_ESTIMATE_PX)
                    };
                    format!("height: {}px", (total - mounted_bottom).max(0.0))
                }></div>
                {move || {
                    let pending = oc.with(|s| s.pending_say.clone());
                    pending.map(|pending| view! { <p class="pending-say">{pending}</p> })
                }}
                // Keyed by index, not a cloned-and-rebuilt Vec: `each` here
                // only actually differs in SHAPE (add/remove) when a new
                // block starts, so a delta appended to the growing segment's
                // text never tears down and recreates every prior `<p>` —
                // the old `.collect_view()` over a fresh clone did exactly
                // that on EVERY chunk, which live profiling (21 Jul) showed
                // as the actual driver of the periodic Layout-dominated CPU
                // spikes during active streaming (not the scroll-to-bottom
                // read fixed earlier the same night). Each item's own body
                // is its own `move ||`, so only the segment whose text
                // actually changed gets its content patched.
                <For
                    each=move || {
                        let n = oc.with(|s| s.streaming.len());
                        (0..n).collect::<Vec<usize>>()
                    }
                    key=|i| *i
                    let(i)
                >
                    {move || {
                        oc.with(|s| s.streaming.get(i).cloned()).map(|seg| {
                            let last = i + 1 == oc.with(|s| s.streaming.len());
                            let body = if last {
                                format!("{}▊", seg.text)
                            } else {
                                seg.text
                            };
                            let marker = (seg.block_type != "text")
                                .then(|| format!("[{}] ", seg.block_type))
                                .unwrap_or_default();
                            view! {
                                <p class="message assistant streaming">
                                    <span class="who">"agent"</span>
                                    {marker}
                                    {body}
                                </p>
                            }
                        })
                    }}
                </For>
            </div>

            {move || {
                (!at_bottom.get()).then(|| {
                    view! {
                        <button class="latest" on:click=move |_| scroll_to_bottom()>
                            "↓ latest"
                        </button>
                    }
                })
            }}

            <div class="conversation-footer">
                {move || {
                    let live_asks = conv.with_value(|c| approvals.with(|a| a.live_for_conv(c, now.get())
                        .into_iter().map(|ask| ask.id.clone()).collect::<Vec<_>>()));
                    approvals.with(|a| {
                        live_asks
                            .into_iter()
                            .filter_map(|id| a.pending().into_iter().find(|ask| ask.id == id).cloned())
                            .map(|ask| {
                                let id = ask.id.clone();
                                let id_approve = id.clone();
                                let id_deny = id.clone();
                                let label = ask_label(&ask).to_owned();
                                let input = ask_input(&ask);
                                let note = a.answer_note(&id).map(str::to_owned);
                                view! {
                                    <div class="approval">
                                        <span class="warn">"⚠"</span>
                                        <strong>{label}</strong>
                                        <button class="approve" on:click=move |_| on_answer.run((id_approve.clone(), true))>
                                            "Approve"
                                        </button>
                                        <button class="deny" on:click=move |_| on_answer.run((id_deny.clone(), false))>
                                            "Deny"
                                        </button>
                                        {note.map(|n| view! { <span class="note">{n}</span> })}
                                        {input.map(|i| view! { <pre>{truncate(&i, 600)}</pre> })}
                                    </div>
                                }
                            })
                            .collect_view()
                    })
                }}

                <p class="status-line">
                    {move || {
                        conv.with_value(|c| rail.with(|r| r.row(c).map(|row| {
                            format!("{} · {} ago", row.last_kind, age(now.get(), row.last_event))
                        })))
                    }}
                    {move || {
                        // Where this conversation is being served — the live
                        // attachment's cwd, if any. Absent is real (no live
                        // attachment, or the agent never reported one): render
                        // nothing, never a placeholder.
                        conv.with_value(|c| rail.with(|r| r.live_cwd(c).map(str::to_owned)))
                            .map(|cwd| { let title = cwd.clone(); view! { <span class="cwd" title=title>{cwd}</span> } })
                    }}
                    {move || {
                        let state = oc.with(|s| s.query_state);
                        match state {
                            QueryState::Unknown => {
                                view! { <span class="badge unknown" title="no evidence yet whether a query is running">"state unknown"</span> }.into_any()
                            }
                            QueryState::Live => {
                                view! {
                                    <>
                                        <span class="badge live">"query running"</span>
                                        <button class="cancel" on:click=move |_| on_cancel.run(())>"cancel"</button>
                                    </>
                                }
                                .into_any()
                            }
                            _ => ().into_any(),
                        }
                    }}
                </p>

                {move || {
                    let snapshot = conv.with_value(|c| usage.with(|u| u.get(c).cloned()));
                    snapshot.map(|s| price_usage_line(&s))
                }}

                {move || {
                    let note = oc.with(|s| s.last_say.clone());
                    note.map(|n| view! { <p class="last-say">{n}</p> })
                }}
                {move || {
                    let err = upload_error.get();
                    (!err.is_empty()).then(|| view! { <p class="last-say">{err}</p> })
                }}

                {move || {
                    let pending = oc.with(|s| s.pending_attachments.clone());
                    let n_uploading = uploading.get();
                    (!pending.is_empty() || n_uploading > 0).then(|| {
                        let chips: Vec<AnyView> = pending
                            .iter()
                            .enumerate()
                            .map(|(i, a)| {
                                let label = format!("{} · {}", media_label(a), size_label(a));
                                view! {
                                    <span class="chip">
                                        {label}
                                        <button on:click=move |_| oc.update(|s| {
                                            if i < s.pending_attachments.len() {
                                                s.pending_attachments.remove(i);
                                            }
                                        })>"×"</button>
                                    </span>
                                }
                                .into_any()
                            })
                            .collect();
                        view! {
                            <p class="attachments">
                                {chips}
                                {(n_uploading > 0).then(|| view! { <span class="dim">"uploading…"</span> })}
                            </p>
                        }
                    })
                }}

                <textarea
                    class="composer-input"
                    node_ref=editor_ref
                    prop:value=move || draft.get()
                    placeholder="say… (⌘⏎ to send)"
                    on:input=move |ev| {
                        let value = event_target_value(&ev);
                        conv.with_value(|c| save_draft(c, &value));
                        draft.set(value);
                    }
                    on:keydown=move |ev: ev::KeyboardEvent| {
                        if ev.key() == "Enter" && (ev.meta_key() || ev.ctrl_key()) {
                            ev.prevent_default();
                            send_current.run(());
                        }
                    }
                    on:paste=move |ev: ev::ClipboardEvent| {
                        let Some(data) = ev.clipboard_data() else { return };
                        let items = data.items();
                        let mut any = false;
                        for i in 0..items.length() {
                            if let Some(item) = items.get(i)
                                && item.kind() == "file"
                                && let Ok(Some(file)) = item.get_as_file()
                            {
                                any = true;
                                uploading.update(|n| *n += 1);
                                uploads::pick_and_upload(
                                    file,
                                    move |attachment| on_attach.run(attachment),
                                    move |reason| upload_error.set(reason),
                                    move || uploading.update(|n| *n = n.saturating_sub(1)),
                                );
                            }
                        }
                        if any {
                            ev.prevent_default();
                        }
                    }
                ></textarea>
                <div class="composer-actions">
                    <button
                        // The one source of truth for send-eligibility is
                        // `ConversationState::can_send` (concerns/conversation.rs),
                        // pure and unit-tested — this closure only supplies the
                        // UI-local reads (draft, uploading), never re-derives the
                        // rule itself.
                        disabled=move || {
                            !oc.with(|s| {
                                s.can_send(
                                    draft.with(|d| d.trim().is_empty()),
                                    !s.pending_attachments.is_empty(),
                                    uploading.get() > 0,
                                )
                            })
                        }
                        on:click=move |_| send_current.run(())
                    >"Send"</button>
                    <button
                        title="attach a file"
                        on:click=move |_| {
                            if let Some(doc) = web_sys::window().and_then(|w| w.document()) {
                                let input = doc.create_element("input").ok();
                                if let Some(input) = input
                                    && let Ok(input) = input.dyn_into::<web_sys::HtmlInputElement>()
                                {
                                    input.set_type("file");
                                    input.set_multiple(true);
                                    let handler = move |ev: ev::Event| {
                                        let target: web_sys::HtmlInputElement = event_target(&ev);
                                        if let Some(files) = target.files() {
                                            handle_files.run(files);
                                        }
                                    };
                                    let closure = wasm_bindgen::closure::Closure::<dyn FnMut(_)>::new(handler);
                                    input.set_onchange(Some(closure.as_ref().unchecked_ref()));
                                    closure.forget();
                                    input.click();
                                }
                            }
                        }
                    >"📎 attach"</button>
                </div>
            </div>
        </div>
    }
    .into_any()
}
