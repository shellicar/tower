//! The dedicated approvals view: every outstanding ask fleet-wide, oldest
//! first, mirrors mvp/frontend's ApprovalsView.svelte. Toggled from the
//! rail's ⚠ badge (docs/mvp/tower-ws-spec.md's approvals model — pending is
//! unconditional, void is the client's own derivation). Reads `approvals`
//! and `rail` (for the conversation label only); owns no state of its own.

use leptos::prelude::*;
use serde_json::Value;

use crate::concerns::approvals::{Approvals, ask_input, ask_label};
use crate::concerns::rail::Rail;
use crate::time::{Millis, age};
use crate::ui::{short, truncate};

/// The decision-relevant payload: file paths render as themselves (the 90%
/// case — DeleteFile/DeleteDirectory take a top-level `files` array; the
/// typed-content shape carries `content.type: "files"`); anything else
/// truncates. Mirrors mvp/frontend's `payload()`.
fn payload(input: Option<&Value>) -> String {
    let Some(input) = input else { return String::new() };
    if let Some(files) = input.get("files").and_then(Value::as_array)
        && files.iter().all(|f| f.is_string())
    {
        return files.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
    }
    if let Some(content) = input.get("content")
        && content.get("type").and_then(Value::as_str) == Some("files")
        && let Some(values) = content.get("values").and_then(Value::as_array)
    {
        return values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
    }
    truncate(&serde_json::to_string(input).unwrap_or_default(), 120)
}

#[component]
pub fn ApprovalsView(
    approvals: RwSignal<Approvals>,
    rail: RwSignal<Rail>,
    now: RwSignal<Millis>,
    on_open_conversation: Callback<String>,
    on_answer: Callback<(String, bool)>,
    on_dismiss: Callback<String>,
    on_close: Callback<()>,
) -> impl IntoView {
    view! {
        <section class="approvals-view">
            <header class="approvals-header">
                <span class="count">
                    {move || {
                        let live = approvals.with(|a| a.live(now.get()).len());
                        let pending = approvals.with(|a| a.pending().len());
                        let void = pending.saturating_sub(live);
                        if void > 0 {
                            format!("approvals · {live} pending · {void} void")
                        } else {
                            format!("approvals · {live} pending")
                        }
                    }}
                </span>
                <button class="close" on:click=move |_| on_close.run(())>"×"</button>
            </header>
            <div class="approvals-list">
                {move || {
                    let asks = approvals.with(|a| a.pending().into_iter().cloned().collect::<Vec<_>>());
                    if asks.is_empty() {
                        return view! { <p class="empty">"Nothing waiting on you."</p> }.into_any();
                    }
                    approvals.with(|a| {
                        asks.iter()
                            .map(|ask| {
                                let id = ask.id.clone();
                                let id_approve = id.clone();
                                let id_deny = id.clone();
                                let id_dismiss = id.clone();
                                let label = ask_label(ask).to_owned();
                                let input = ask_input(ask).and_then(|s| serde_json::from_str::<Value>(&s).ok());
                                let payload_str = payload(input.as_ref());
                                let void = a.is_void(ask, now.get());
                                let note = a.answer_note(&id).map(str::to_owned);
                                let conv = ask
                                    .correlation
                                    .as_ref()
                                    .and_then(|c| c.get("conversationId"))
                                    .and_then(Value::as_str)
                                    .map(str::to_owned);
                                let conv_label = conv.clone().map(|c| {
                                    rail.with(|r| r.row(&c).and_then(|row| row.title.clone())).unwrap_or_else(|| short(&c))
                                });
                                let raised = ask.raised_ts;
                                view! {
                                    <article class="ask" class:void=void>
                                        <div class="ask-top">
                                            <span class="name">"⚒ "{label}" "<span class="payload">{payload_str}</span></span>
                                            <span class="age">{move || age(now.get(), raised)}</span>
                                        </div>
                                        <div class="ask-bottom">
                                            {match conv.clone() {
                                                Some(c) => {
                                                    let c2 = c.clone();
                                                    view! {
                                                        <button class="conv-link" on:click=move |_| on_open_conversation.run(c2.clone())>
                                                            {conv_label.clone().unwrap_or(c)}
                                                        </button>
                                                    }
                                                    .into_any()
                                                }
                                                None => view! { <span class="no-conv">"no conversation"</span> }.into_any(),
                                            }}
                                            <span class="actions">
                                                {note.map(|n| view! { <span class="note">{n}</span> })}
                                                {if void {
                                                    view! {
                                                        <>
                                                            <span class="void-label">"void — holder silent"</span>
                                                            <button class="dismiss" on:click=move |_| on_dismiss.run(id_dismiss.clone())>"dismiss"</button>
                                                        </>
                                                    }
                                                    .into_any()
                                                } else {
                                                    view! {
                                                        <>
                                                            <button class="approve" on:click=move |_| on_answer.run((id_approve.clone(), true))>"approve"</button>
                                                            <button class="deny" on:click=move |_| on_answer.run((id_deny.clone(), false))>"deny"</button>
                                                        </>
                                                    }
                                                    .into_any()
                                                }}
                                            </span>
                                        </div>
                                    </article>
                                }
                            })
                            .collect_view()
                            .into_any()
                    })
                }}
            </div>
        </section>
    }
}
