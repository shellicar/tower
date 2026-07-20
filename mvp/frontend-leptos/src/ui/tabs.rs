//! The tab bar: reads the `view` concern only. Renaming uses the browser's
//! native `prompt()`, same as mvp/frontend's `RowList`/`App.svelte` — a tab
//! name is a rare, deliberate edit, not worth an inline editor the way a
//! conversation's title is (clicked far more often, from the rail). Closing
//! confirms first, same as `App.svelte`'s `confirm(\`Close tab "${t.name}"?\`)`
//! — a tab is a mission control with however many conversations open in it,
//! not a scratch view; losing that set to a stray click is real work lost.

use leptos::prelude::*;

use crate::concerns::rail::Rail;
use crate::concerns::view::View;

#[component]
pub fn TabBar(
    view: RwSignal<View>,
    rail: RwSignal<Rail>,
    on_switch: Callback<usize>,
    on_add: Callback<()>,
    on_close: Callback<usize>,
    on_rename: Callback<(usize, String)>,
) -> impl IntoView {
    view! {
        <div class="tab-bar">
            {move || {
                let active = view.with(|v| v.active);
                let can_close = view.with(|v| v.tabs.len() > 1);
                view.with(|v| {
                    v.tabs
                        .iter()
                        .enumerate()
                        .map(|(i, tab)| {
                            let name = tab.name.clone();
                            let is_active = i == active;
                            let stale_count = rail.with(|r| {
                                let stale = r.stale_convs();
                                tab.convs.iter().filter(|c| stale.contains(*c)).count()
                            });
                            view! {
                                <span class="tab" class:active=is_active>
                                    {(stale_count > 0).then(|| view! {
                                        <span class="tab-unread" title="unread in this tab">{format!("● {stale_count}")}</span>
                                    })}
                                    <button
                                        class="tab-name"
                                        on:click=move |_| {
                                            if is_active {
                                                if let Some(next) = web_sys::window()
                                                    .and_then(|w| w.prompt_with_message_and_default("tab name", &name).ok().flatten())
                                                {
                                                    on_rename.run((i, next));
                                                }
                                            } else {
                                                on_switch.run(i);
                                            }
                                        }
                                    >
                                        {tab.name.clone()}
                                    </button>
                                    {(can_close && is_active).then(|| {
                                        let confirm_name = tab.name.clone();
                                        view! {
                                            <button
                                                class="tab-close"
                                                on:click=move |_| {
                                                    let confirmed = web_sys::window()
                                                        .and_then(|w| w.confirm_with_message(&format!("Close tab \"{confirm_name}\"?")).ok())
                                                        .unwrap_or(false);
                                                    if confirmed {
                                                        on_close.run(i);
                                                    }
                                                }
                                            >"×"</button>
                                        }
                                    })}
                                </span>
                            }
                        })
                        .collect_view()
                })
            }}
            <button class="tab-add" on:click=move |_| on_add.run(())>"+"</button>
        </div>
    }
}
