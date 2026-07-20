//! The open conversation panel: reads `conversations`, `approvals`, and
//! `rail` (the header title, `lastKind`/staleness — the read/write split
//! Rust gives for free, docs/mvp/frontend-architecture.md). Owns its own
//! local UI state (the composer draft, attachment chips, the scroll anchor,
//! the title editor) — a component's state, per the architecture doc, never
//! a concern's. Tracks mvp/frontend's ConversationPanel.svelte feature for
//! feature, including usage/pricing and attachments — the slice grew past
//! docs/mvp/frontend-leptos-plan.md's original frontend-rs-only scope once
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

use leptos::ev;
use leptos::html;
use leptos::prelude::*;
use serde_json::Value;
use wasm_bindgen::JsCast;

use crate::concerns::approvals::{Approvals, ask_input, ask_label};
use crate::concerns::conversation::{ConversationState, QueryState};
use crate::concerns::rail::Rail;
use crate::concerns::usage::Usage;
use crate::pricing::{format_tokens, format_usd, price_usage};
use crate::time::{Millis, age, format_time};
use crate::ui::block::render_block;
use crate::ui::{short, truncate};
use crate::uploads;

fn draft_key(conv: &str) -> String {
    format!("tower.draft.{conv}")
}

fn load_draft(conv: &str) -> String {
    web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .and_then(|s| s.get_item(&draft_key(conv)).ok().flatten())
        .unwrap_or_default()
}

/// Persisted on every keystroke — mvp/frontend debounces this (a synchronous
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
/// mvp/frontend's `ConversationPanel.svelte`.
fn price_usage_line(u: &ws_types::WsUsage) -> impl IntoView + use<> {
    let p = price_usage(u);
    view! {
        <p class="usage-line" title=u.model.clone()>
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
    let autosize = move || {
        if let Some(el) = editor_ref.get() {
            // `.style()` on the leptos-wrapped element resolves to tachys's
            // reactive-attribute method, not web_sys's `CSSStyleDeclaration`
            // getter, so borrow the underlying DOM element explicitly.
            let html_el: &web_sys::HtmlElement = el.unchecked_ref();
            html_el.style().set_property("height", "auto").ok();
            let h = el.scroll_height();
            html_el.style().set_property("height", &format!("{h}px")).ok();
        }
    };

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
            s.can_send(text.trim().is_empty(), !s.pending_attachments.is_empty(), uploading.get_untracked() > 0)
        });
        if !allowed {
            return;
        }
        conv.with_value(|c| save_draft(c, ""));
        draft.set(String::new());
        on_send.run(text);
        request_animation_frame(autosize);
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
            request_animation_frame(autosize);
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
                                .unwrap_or_else(|| short(c))
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
                        let gap = el.scroll_height() - el.scroll_top() - el.client_height();
                        at_bottom.set(gap < 32);
                    }
                }
            >
                {move || {
                    let messages = oc.with(|s| s.messages.clone());
                    (!messages.is_empty()).then(|| {
                        messages
                            .into_iter()
                            .map(|m| {
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
                                let blocks: Vec<AnyView> =
                                    m.content.iter().map(render_block).collect();
                                view! {
                                    <div class=format!("message {cls}")>
                                        <div class="who">
                                            <span class="who-name">{who}</span>
                                            <span class="who-time">{time}</span>
                                        </div>
                                        {blocks}
                                    </div>
                                }
                            })
                            .collect_view()
                    })
                }}
                {move || {
                    let pending = oc.with(|s| s.pending_say.clone());
                    pending.map(|pending| view! { <p class="pending-say">{pending}</p> })
                }}
                {move || {
                    let segments = oc.with(|s| s.streaming.clone());
                    (!segments.is_empty()).then(|| {
                        let total = segments.len();
                        segments
                            .into_iter()
                            .enumerate()
                            .map(|(i, seg)| {
                                let last = i + 1 == total;
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
                            .collect_view()
                    })
                }}
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
                        autosize();
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
