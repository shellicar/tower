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
use crate::ui::conversation::ConversationView;
use crate::ui::rail::RailView;
use crate::ui::tabs::TabBar;

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

fn tabs_key() -> &'static str {
    "tower.tabs"
}
fn active_key() -> &'static str {
    "tower.activeTab"
}

fn load_view() -> View {
    let storage = web_sys::window().and_then(|w| w.local_storage().ok().flatten());
    let Some(storage) = storage else { return View::default() };
    let tabs: Option<Vec<crate::concerns::view::Tab>> = storage
        .get_item(tabs_key())
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<(String, Vec<String>)>>(&raw).ok())
        .map(|parsed| {
            parsed
                .into_iter()
                .map(|(name, convs)| crate::concerns::view::Tab { name, convs })
                .collect()
        });
    let active = storage
        .get_item(active_key())
        .ok()
        .flatten()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(0);
    match tabs {
        Some(tabs) if !tabs.is_empty() => View { active: active.min(tabs.len() - 1), tabs },
        _ => View::default(),
    }
}

fn save_view(view: &View) {
    let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) else {
        return;
    };
    let shape: Vec<(String, Vec<String>)> =
        view.tabs.iter().map(|t| (t.name.clone(), t.convs.clone())).collect();
    if let Ok(json) = serde_json::to_string(&shape) {
        let _ = storage.set_item(tabs_key(), &json);
    }
    let _ = storage.set_item(active_key(), &view.active.to_string());
}

#[cfg(target_arch = "wasm32")]
#[component]
pub fn App(ws_url: String) -> impl IntoView {
    let rail = RwSignal::new(Rail::default());
    let conversations = RwSignal::new(Conversations::default());
    let approvals = RwSignal::new(Approvals::default());
    let usage = RwSignal::new(Usage::default());
    let view = RwSignal::new(load_view());
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

    // Reconcile the wire-open set to the active tab's convs, then persist —
    // every view mutation funnels through this one place. `next_id` is Copy
    // (it only closes over the Copy `ids` handle), so a fresh local mutable
    // copy per call keeps `sync_open` itself a `Fn`, callable from every
    // action below without needing a `mut` binding at each call site.
    let sync_open = move || {
        let wanted = view.with(|v| v.tab().convs.clone());
        let mut mint = next_id;
        let msgs = conversations.try_update(|c| c.set_open(&wanted, &mut mint));
        for msg in msgs.into_iter().flatten() {
            send(msg);
        }
        view.with(save_view);
    };

    let open_conversation = Callback::new(move |conv: String| {
        view.update(|v| v.open_conversation(&conv));
        sync_open();
    });

    let switch_tab = Callback::new(move |i: usize| {
        view.update(|v| v.switch_tab(i));
        sync_open();
    });
    let add_tab = Callback::new(move |()| {
        view.update(|v| v.add_tab());
        sync_open();
    });
    let close_tab = Callback::new(move |i: usize| {
        view.update(|v| v.close_tab(i));
        sync_open();
    });
    let rename_tab = Callback::new(move |(i, name): (usize, String)| {
        view.update(|v| v.rename_tab(i, &name));
        view.with(save_view);
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
        approvals.update(|a| a.dismiss(&approval_id));
    });

    let open_convs = Signal::derive(move || view.with(|v| v.tab().convs.clone()));

    view! {
        <div class="tower">
            <RailView
                rail=rail
                approvals=approvals
                now=now
                open_convs=open_convs
                status=status
                on_open=open_conversation
                on_dismiss=dismiss_approval
            />
            <main class="conversation">
                <TabBar view=view on_switch=switch_tab on_add=add_tab on_close=close_tab on_rename=rename_tab />
                <div class="panels">
                    {move || {
                        let convs = view.with(|v| v.tab().convs.clone());
                        if convs.is_empty() {
                            return view! { <p class="empty">"Open a conversation from the rail."</p> }.into_any();
                        }
                        convs
                            .into_iter()
                            .map(|conv| {
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
                                        view.update(|v| v.close_conversation(&conv));
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
                            })
                            .collect_view()
                            .into_any()
                    }}
                </div>
            </main>
        </div>
    }
}
