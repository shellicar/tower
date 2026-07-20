//! The dedicated unread/stale-conversations view: every conversation nobody
//! on the fleet has looked at, oldest-touched first, mirrors mvp/frontend's
//! UnreadView.svelte. Toggled from the rail's ● badge, same footing as
//! `ApprovalsView`'s ⚠. Reads `rail` only (it owns the stale set and the row
//! titles); owns no state of its own. Opening a conversation from here isn't
//! itself an ack \u2014 towerd infers the ack from the conversation being open,
//! so the badge just clears once that lands back over the wire.

use leptos::prelude::*;

use crate::concerns::rail::Rail;
use crate::time::{Millis, age};

#[component]
pub fn UnreadView(
    rail: RwSignal<Rail>,
    now: RwSignal<Millis>,
    on_open_conversation: Callback<String>,
    on_close: Callback<()>,
) -> impl IntoView {
    view! {
        <section class="unread-view">
            <header class="unread-header">
                <span class="count">
                    {move || format!("unread · {}", rail.with(|r| r.stale_rows().len()))}
                </span>
                <button class="close" on:click=move |_| on_close.run(())>"×"</button>
            </header>
            <div class="unread-list">
                {move || {
                    let rows = rail.with(|r| r.stale_rows());
                    if rows.is_empty() {
                        return view! { <p class="empty">"Nothing's gone stale."</p> }.into_any();
                    }
                    rows.into_iter()
                        .map(|row| {
                            let conv = row.conv.clone();
                            let label = row.title.clone().unwrap_or_else(|| conv.clone());
                            let last_event = row.last_event;
                            view! {
                                <article class="unread-row">
                                    <button class="conv-link" on:click=move |_| on_open_conversation.run(conv.clone())>
                                        "● "{label}
                                    </button>
                                    <span class="age">{move || age(now.get(), last_event)}</span>
                                </article>
                            }
                        })
                        .collect_view()
                        .into_any()
                }}
            </div>
        </section>
    }
}
