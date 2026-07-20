//! The composition root: wires transport + concerns, same as frontend-rs's
//! app.rs and frontend's root. Owns every concern (a `RwSignal` per concern);
//! concerns are blind to each other — the hand knows the fingers, the fingers
//! don't know each other (docs/mvp/frontend-architecture.md). It renders no
//! detail itself: `ui::rail::RailView`, `ui::tabs::TabBar`, and
//! `ui::conversation::ConversationView` read the concerns and hold their own
//! local UI state; this file only wires them to the actions that mutate a
//! concern and send over the transport.
//!
//! Fan-out survives the pull-vs-push change at the transport: the socket
//! callback offers each decoded frame to every concern's `apply` in turn,
//! same as egui's per-frame drain loop, just triggered by the frame's
//! arrival instead of a redraw tick.
//!
//! Tabs: the `view` concern decides WHICH conversations are open (per tab);
//! it never reads the conversation concern's content. This root is what
//! actually calls `Conversations::set_open` after every `view` mutation —
//! the one deliberate cross-concern action the architecture doc names
//! (Decision 2), kept here rather than let `view` reach into `conversations`
//! itself.

use leptos::prelude::*;
use ws_types::ClientMsg;

use crate::concerns::approvals::Approvals;
use crate::concerns::conversation::Conversations;
use crate::concerns::rail::Rail;
use crate::concerns::usage::Usage;
use crate::concerns::view::View;
use crate::time::Millis;
use crate::transport::{IdCounter, Transport};
use crate::ui::approvals::ApprovalsView;
use crate::ui::conversation::ConversationView;
use crate::ui::rail::RailView;
use crate::ui::tabs::TabBar;
use crate::ui::unread::UnreadView;

fn now_ms() -> Millis {
    #[cfg(target_arch = "wasm32")]
    {
        js_sys::Date::now() as Millis
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

fn active_key() -> &'static str {
    "tower.activeTab"
}

/// `active` is the one piece of view state that stays local (module doc on
/// `concerns::view`): a small per-browser convenience, not synced.
fn load_active() -> usize {
    web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .and_then(|s| s.get_item(active_key()).ok().flatten())
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0)
}

fn save_active(i: usize) {
    if let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) {
        let _ = storage.set_item(active_key(), &i.to_string());
    }
}

#[cfg(target_arch = "wasm32")]
#[component]
pub fn App(ws_url: String) -> impl IntoView {
    let rail = RwSignal::new(Rail::default());
    let conversations = RwSignal::new(Conversations::default());
    let approvals = RwSignal::new(Approvals::default());
    let usage = RwSignal::new(Usage::default());
    let view = RwSignal::new({
        let mut v = View::default();
        v.switch_tab(load_active());
        v
    });
    let ids = StoredValue::new_local(IdCounter::default());
    let now = RwSignal::new(now_ms());

    let transport = StoredValue::new_local(
        Transport::connect(&ws_url, move |frame| {
            // Fan-out: one decoded frame, offered to every concern's own
            // `apply`. Each concern's own match decides what it folds.
            rail.update(|r| r.apply(&frame));
            conversations.update(|c| c.apply(&frame));
            approvals.update(|a| a.apply(&frame));
            usage.update(|u| u.apply(&frame));
            view.maybe_update(|v| v.apply(&frame, crate::ui::rail::load_view));
        })
        .expect("websocket connect"),
    );
    let status = Signal::derive(move || transport.with_value(|t| t.status()));

    // The re-render ticker — a per-concern cadence detail (Decision 1). Both
    // liveness and approval-void verdicts read `now`; 1s covers both without
    // a bespoke ticker per verdict.
    set_interval(
        move || now.set(now_ms()),
        std::time::Duration::from_secs(1),
    );

    let send = move |msg: ClientMsg| transport.with_value(|t| t.send(&msg));
    let next_id = move || ids.try_update_value(|c| c.next()).expect("id counter");

    // Reconcile the wire-open set to the active tab's convs after a view
    // mutation: the tab change itself already went out as `SetLayout`
    // (returned by the `View` action and sent below); this is the sibling
    // send that opens/closes the actual conversations named in it.
    let sync_open = move || {
        let wanted = view.with(|v| v.tab().convs.clone());
        let mut mint = next_id;
        let msgs = conversations.try_update(|c| c.set_open(&wanted, &mut mint));
        for msg in msgs.into_iter().flatten() {
            send(msg);
        }
    };

    // The reconnect case Svelte covers with `transport.onConnect(() =>
    // conversations.setOpen(tab.convs))`: the server's `Layout` snapshot
    // updates `view` on its own (inside the transport callback above, which
    // cannot call `sync_open` — `send`/`sync_open` are not yet defined at
    // that point, and `transport` is still under construction). A reactive
    // effect on the active tab's open set covers it instead: it fires once
    // on mount (empty, harmless) and again the moment `Layout` updates the
    // tab, actually requesting those conversations' content — the gap that
    // left a freshly loaded/reconnected page showing open tabs with no
    // messages, `set_open` already being idempotent makes this safe
    // alongside every explicit `sync_open()` call above.
    Effect::new(move |_| {
        view.with(|v| v.tab().convs.clone());
        sync_open();
    });

    let open_conversation = Callback::new(move |conv: String| {
        let msg = view.try_update(|v| v.open_conversation(&conv, next_id()));
        if let Some(msg) = msg.flatten() {
            send(msg);
        }
        sync_open();
    });

    let on_toggle = Callback::new(move |conv: String| {
        if view.with(|v| v.tab().convs.contains(&conv)) {
            let msg = view.try_update(|v| v.close_conversation(&conv, next_id()));
            if let Some(msg) = msg {
                send(msg);
            }
        } else {
            let msg = view.try_update(|v| v.open_conversation(&conv, next_id()));
            if let Some(msg) = msg.flatten() {
                send(msg);
            }
        }
        sync_open();
    });

    let switch_tab = Callback::new(move |i: usize| {
        view.update(|v| v.switch_tab(i));
        save_active(i);
        sync_open();
    });
    let add_tab = Callback::new(move |()| {
        let msg = view.try_update(|v| v.add_tab(next_id()));
        if let Some(msg) = msg {
            send(msg);
        }
        save_active(view.with(|v| v.active));
        sync_open();
    });
    let close_tab = Callback::new(move |i: usize| {
        let msg = view.try_update(|v| v.close_tab(i, next_id()));
        if let Some(msg) = msg.flatten() {
            send(msg);
        }
        save_active(view.with(|v| v.active));
        sync_open();
    });
    let rename_tab = Callback::new(move |(i, name): (usize, String)| {
        let msg = view.try_update(|v| v.rename_tab(i, &name, next_id()));
        if let Some(msg) = msg.flatten() {
            send(msg);
        }
    });

    let answer_approval = move |approval_id: String, approved: bool| {
        let id = next_id();
        let msg = approvals.try_update(|a| a.answer(&approval_id, approved, id));
        if let Some(msg) = msg {
            send(msg);
        }
    };
    let on_answer = Callback::new(move |(id, approved): (String, bool)| {
        answer_approval(id, approved)
    });

    let dismiss_approval = Callback::new(move |approval_id: String| {
        let id = next_id();
        let msg = approvals.with(|a| a.dismiss(&approval_id, id));
        send(msg);
    });
    let toggle_approvals = Callback::new(move |()| view.update(|v| v.toggle_approvals()));
    let close_approvals = Callback::new(move |()| view.update(|v| v.close_approvals()));
    let open_conversation_from_approval = Callback::new(move |conv: String| {
        view.update(|v| v.close_approvals());
        open_conversation.run(conv);
    });
    let toggle_unread = Callback::new(move |()| view.update(|v| v.toggle_unread()));
    let close_unread = Callback::new(move |()| view.update(|v| v.close_unread()));
    let open_conversation_from_unread = Callback::new(move |conv: String| {
        view.update(|v| v.close_unread());
        open_conversation.run(conv);
    });
    let dismiss_attachment = Callback::new(move |conv: String| {
        let id = next_id();
        let msg = rail.with(|r| r.dismiss_attachment(&conv, id));
        if let Some(msg) = msg {
            send(msg);
        }
    });

    let open_convs = Signal::derive(move || view.with(|v| v.tab().convs.clone()));

    view! {
        <div class="tower">
            <RailView
                rail=rail
                approvals=approvals
                view=view
                now=now
                open_convs=open_convs
                status=status
                on_toggle=on_toggle
                on_dismiss_attachment=dismiss_attachment
                on_toggle_approvals=toggle_approvals
                on_toggle_unread=toggle_unread
            />
            <main class="conversation">
                <TabBar view=view rail=rail on_switch=switch_tab on_add=add_tab on_close=close_tab on_rename=rename_tab />
                <div class="panels">
                    {move || {
                        view.with(|v| v.approvals_open).then(|| view! {
                            <ApprovalsView
                                approvals=approvals
                                rail=rail
                                now=now
                                on_open_conversation=open_conversation_from_approval
                                on_answer=on_answer
                                on_dismiss=dismiss_approval
                                on_close=close_approvals
                            />
                        })
                    }}
                    {move || {
                        view.with(|v| v.unread_open).then(|| view! {
                            <UnreadView
                                rail=rail
                                now=now
                                on_open_conversation=open_conversation_from_unread
                                on_close=close_unread
                            />
                        })
                    }}
                    {move || {
                        let convs = view.with(|v| v.tab().convs.clone());
                        (convs.is_empty() && !view.with(|v| v.approvals_open) && !view.with(|v| v.unread_open))
                            .then(|| view! { <p class="empty">"Open a conversation from the rail."</p> })
                    }}
                    <For
                        each=move || view.with(|v| v.tab().convs.clone())
                        key=|conv| conv.clone()
                        let(conv)
                    >
                        {
                            let on_send = Callback::new({
                                let conv = conv.clone();
                                move |text: String| {
                                    let id = next_id();
                                    if let Some(msg) = conversations.try_update(|c| c.say(&conv, text, id)).flatten() {
                                        send(msg);
                                    }
                                }
                            });
                            let on_cancel = Callback::new({
                                let conv = conv.clone();
                                move |()| {
                                    let id = next_id();
                                    if let Some(msg) = conversations.try_update(|c| c.cancel(&conv, id)).flatten() {
                                        send(msg);
                                    }
                                }
                            });
                            let on_attach = Callback::new({
                                let conv = conv.clone();
                                move |attachment| {
                                    conversations.update(|c| c.attach(&conv, vec![attachment]));
                                }
                            });
                            let on_set_title = Callback::new({
                                let conv = conv.clone();
                                move |title: String| {
                                    let id = next_id();
                                    if let Some(msg) = rail.try_update(|r| r.set_title(&conv, title, id)).flatten() {
                                        send(msg);
                                    }
                                }
                            });
                            let on_close = Callback::new({
                                let conv = conv.clone();
                                move |()| {
                                    let msg = view.try_update(|v| v.close_conversation(&conv, next_id()));
                                    if let Some(msg) = msg {
                                        send(msg);
                                    }
                                    sync_open();
                                }
                            });
                            view! {
                                <ConversationView
                                    conv=conv
                                    rail=rail
                                    conversations=conversations
                                    approvals=approvals
                                    usage=usage
                                    now=now
                                    on_send=on_send
                                    on_cancel=on_cancel
                                    on_attach=on_attach
                                    on_answer=on_answer
                                    on_set_title=on_set_title
                                    on_close=on_close
                                />
                            }
                        }
                    </For>
                </div>
            </main>
        </div>
    }
}
