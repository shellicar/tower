//! The composition root: wires transport + concerns, same as frontend-rs's
//! app.rs and frontend's root. Owns every concern (a `RwSignal` per concern);
//! concerns are blind to each other — the hand knows the fingers, the fingers
//! don't know each other (docs/mvp/frontend-architecture.md). It renders no
//! detail itself: `ui::rail::RailView` and `ui::conversation::ConversationView`
//! read the concerns and hold their own local UI state; this file only wires
//! them to the actions that mutate a concern and send over the transport.
//!
//! Fan-out survives the pull-vs-push change at the transport: the socket
//! callback offers each decoded frame to every concern's `apply` in turn,
//! same as egui's per-frame drain loop, just triggered by the frame's
//! arrival instead of a redraw tick.

use leptos::prelude::*;
use ws_types::ClientMsg;

use crate::concerns::approvals::Approvals;
use crate::concerns::conversation::Conversations;
use crate::concerns::rail::Rail;
use crate::time::Millis;
use crate::transport::{IdCounter, Transport};
use crate::ui::conversation::ConversationView;
use crate::ui::rail::RailView;
use crate::uploads::{self, Upload};

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

#[cfg(target_arch = "wasm32")]
#[component]
pub fn App(ws_url: String) -> impl IntoView {
    let rail = RwSignal::new(Rail::default());
    let conversations = RwSignal::new(Conversations::default());
    let approvals = RwSignal::new(Approvals::default());
    let ids = StoredValue::new_local(IdCounter::default());
    let now = RwSignal::new(now_ms());

    let transport = StoredValue::new_local(
        Transport::connect(&ws_url, move |frame| {
            // Fan-out: one decoded frame, offered to every concern's own
            // `apply`. Each concern's own match decides what it folds.
            rail.update(|r| r.apply(&frame));
            conversations.update(|c| c.apply(&frame));
            approvals.update(|a| a.apply(&frame));
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

    let open_conv = RwSignal::new(None::<String>);

    let send = move |msg: ClientMsg| transport.with_value(|t| t.send(&msg));
    let next_id = move || ids.try_update_value(|c| c.next()).expect("id counter");

    let open_conversation = Callback::new(move |conv: String| {
        if open_conv.get_untracked().as_deref() == Some(conv.as_str()) {
            return;
        }
        if let Some(prev) = open_conv.get_untracked() {
            let id = next_id();
            if let Some(msg) = conversations.try_update(|c| c.close(&prev, id)).flatten() {
                send(msg);
            }
        }
        let id = next_id();
        if let Some(msg) = conversations.try_update(|c| c.open(&conv, id)).flatten() {
            send(msg);
        }
        open_conv.set(Some(conv));
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

    view! {
        <div class="tower">
            <RailView
                rail=rail
                approvals=approvals
                now=now
                open_conv=open_conv
                status=status
                on_open=open_conversation
                on_dismiss=dismiss_approval
            />
            <main class="conversation">
                {move || match open_conv.get() {
                    None => view! { <p class="empty">"Open a conversation from the rail."</p> }.into_any(),
                    Some(conv) => {
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
                        let on_upload = Callback::new({
                            let conv = conv.clone();
                            move |file: web_sys::File| {
                                uploads::pick_and_upload(conv.clone(), file, move |Upload { conv, attachment }| {
                                    conversations.update(|c| c.attach(&conv, vec![attachment]));
                                });
                            }
                        });
                        view! {
                            <ConversationView
                                conv=conv
                                rail=rail
                                conversations=conversations
                                approvals=approvals
                                now=now
                                on_send=on_send
                                on_cancel=on_cancel
                                on_upload=on_upload
                                on_answer=on_answer
                            />
                        }
                        .into_any()
                    }
                }}
            </main>
        </div>
    }
}

