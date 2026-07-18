//! The open conversation panel: reads `conversations`, `approvals`, and
//! `rail` (the header title only — the read/write split Rust gives for free,
//! docs/mvp/frontend-architecture.md). Owns its own local UI state (the
//! composer draft, the scroll anchor) — a component's state, per the
//! architecture doc, never a concern's.

use leptos::ev;
use leptos::html;
use leptos::prelude::*;

use crate::concerns::approvals::{Approvals, ask_input, ask_label};
use crate::concerns::conversation::{Conversations, QueryState};
use crate::concerns::rail::Rail;
use crate::time::Millis;
use crate::ui::block::render_block;
use crate::ui::{short, truncate};

#[component]
pub fn ConversationView(
    conv: String,
    rail: RwSignal<Rail>,
    conversations: RwSignal<Conversations>,
    approvals: RwSignal<Approvals>,
    now: RwSignal<Millis>,
    on_send: Callback<String>,
    on_cancel: Callback<()>,
    on_upload: Callback<web_sys::File>,
    on_answer: Callback<(String, bool)>,
) -> impl IntoView {
    let header = rail
        .with(|r| r.row(&conv).and_then(|row| row.title.clone()))
        .unwrap_or_else(|| short(&conv));

    let draft = RwSignal::new(String::new());
    let messages_ref = NodeRef::<html::Div>::new();
    // Stick-to-bottom while reading live; a manual scroll up drops it, and
    // the "latest" button (mvp/frontend has none — a real gap it named)
    // offers the way back down.
    let at_bottom = RwSignal::new(true);
    let scroll_to_bottom = move || {
        if let Some(el) = messages_ref.get() {
            el.set_scroll_top(el.scroll_height());
        }
        at_bottom.set(true);
    };

    let conv_for_live = conv.clone();
    let conv_for_note = conv.clone();
    let conv_for_live_query = conv.clone();
    let conv_for_pending = conv.clone();
    let conv_for_upload = conv.clone();
    let conv_for_stick = conv.clone();
    let conv_for_restore = conv.clone();
    let conv_for_loaded = conv.clone();

    let send_current = move || {
        let text = draft.get_untracked();
        if text.trim().is_empty() {
            return;
        }
        draft.set(String::new());
        on_send.run(text);
    };

    // Stick to the bottom while new content arrives and the reader hasn't
    // scrolled away; runs after the DOM patch, so scrollHeight already
    // reflects the new message/streaming chunk.
    Effect::new(move |_| {
        let count = conversations
            .with(|cs| cs.get(&conv_for_stick).map(|oc| oc.messages.len() + oc.streaming.len()));
        let _ = count; // the dependency that re-triggers this effect
        if at_bottom.get_untracked()
            && let Some(el) = messages_ref.get()
        {
            el.set_scroll_top(el.scroll_height());
        }
    });

    // A rejected or revoked say comes home to the editor: pull its words back
    // into the draft if the box is empty, then consume the restore.
    Effect::new(move |_| {
        if !draft.get_untracked().is_empty() {
            return;
        }
        let restore = conversations
            .with(|c| c.get(&conv_for_restore).and_then(|oc| oc.restore_say.clone()));
        if let Some(restore) = restore {
            draft.set(restore);
            conversations.update(|c| c.consume_restore(&conv_for_restore));
        }
    });

    view! {
        <div class="conversation-inner">
            <h2>{header}</h2>
            {move || {
                let loaded = conversations.with(|c| c.get(&conv_for_loaded).map(|oc| oc.loaded));
                (loaded == Some(false)).then(|| view! { <p class="opening">"loading…"</p> })
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
                    let messages = conversations
                        .with(|c| c.get(&conv).map(|oc| oc.messages.clone()));
                    messages.map(|messages| {
                        messages
                            .into_iter()
                            .map(|m| {
                                let (who, cls) = match m.role.as_str() {
                                    "user" => ("you".to_owned(), "user"),
                                    "assistant" => ("agent".to_owned(), "assistant"),
                                    other => (other.to_owned(), "other"),
                                };
                                let blocks: Vec<AnyView> =
                                    m.content.iter().map(render_block).collect();
                                view! {
                                    <div class=format!("message {cls}")>
                                        <div class="who">{who}</div>
                                        {blocks}
                                    </div>
                                }
                            })
                            .collect_view()
                    })
                }}
                {move || {
                    let segments = conversations
                        .with(|c| c.get(&conv_for_live).map(|oc| oc.streaming.clone()));
                    segments.map(|segments| {
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
                                        <span class="who">"agent › "</span>
                                        {marker}
                                        {body}
                                    </p>
                                }
                            })
                            .collect_view()
                    })
                }}
                {move || {
                    conversations.with(|c| {
                        c.get(&conv_for_pending)
                            .and_then(|oc| oc.pending_say.clone())
                            .map(|pending| {
                                view! {
                                    <p class="pending-say">
                                        {format!("you (sending…) › {pending}")}
                                    </p>
                                }
                            })
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

            {move || {
                approvals
                    .with(|a| {
                        a.live_for_conv(&conv_for_live_query, now.get())
                            .into_iter()
                            .map(|ask| {
                                let id = ask.id.clone();
                                let id_approve = id.clone();
                                let id_deny = id.clone();
                                let label = ask_label(ask).to_owned();
                                let input = ask_input(ask);
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

            <p class="last-say">
                {move || conversations.with(|c| c.get(&conv_for_note).and_then(|oc| oc.last_say.clone()))}
            </p>

            <div class="composer">
                <input
                    type="text"
                    placeholder="say something…"
                    prop:value=move || draft.get()
                    on:input=move |ev| draft.set(event_target_value(&ev))
                    on:keydown=move |ev: ev::KeyboardEvent| {
                        if ev.key() == "Enter" {
                            send_current();
                        }
                    }
                />
                <button on:click=move |_| send_current()>"Send"</button>
                <input
                    type="file"
                    on:change=move |ev| {
                        let input: web_sys::HtmlInputElement = event_target(&ev);
                        if let Some(files) = input.files()
                            && let Some(file) = files.get(0)
                        {
                            on_upload.run(file);
                        }
                        input.set_value("");
                    }
                />
                {move || {
                    let live = conversations
                        .with(|c| c.get(&conv_for_upload).map(|oc| oc.query_state == QueryState::Live))
                        .unwrap_or(false);
                    live.then(|| view! { <button on:click=move |_| on_cancel.run(())>"Cancel"</button> })
                }}
            </div>
        </div>
    }
    .into_any()
}
