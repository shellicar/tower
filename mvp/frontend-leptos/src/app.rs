//! The composition root: wires transport + concerns, same as frontend-rs's
//! app.rs and frontend's root. Owns every concern (a `RwSignal` per concern);
//! concerns are blind to each other — the hand knows the fingers, the fingers
//! don't know each other (docs/mvp/frontend-architecture.md).
//!
//! Fan-out survives the pull-vs-push change at the transport: the socket
//! callback offers each decoded frame to every concern's `apply` in turn,
//! same as egui's per-frame drain loop, just triggered by the frame's
//! arrival instead of a redraw tick.

use leptos::prelude::*;
use ws_types::ServerMsg;

use crate::concerns::rail::Rail;
use crate::time::Millis;
use crate::transport::Transport;

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

    // wasm32 is single-threaded; the socket types aren't Send/Sync, so this
    // is thread-local storage (Leptos's escape hatch for that), not a real
    // cross-thread share.
    let transport = StoredValue::new_local(
        Transport::connect(&ws_url, move |frame: ServerMsg| {
            rail.update(|r| r.apply(&frame));
        })
        .expect("websocket connect"),
    );
    let _ = transport; // kept alive for the session; send() lands with the say/answer/cancel concerns

    let now = now_ms();

    view! {
        <div class="rail">
            <ul>
                {move || {
                    rail.with(|r| {
                        r.ordered()
                            .into_iter()
                            .map(|row| {
                                let conv = row.conv.clone();
                                let title = row.title.clone().unwrap_or_else(|| conv.clone());
                                let live = rail.with(|r| r.verdict(&conv, now));
                                view! {
                                    <li>
                                        {title} " " {format!("{live:?}")}
                                    </li>
                                }
                            })
                            .collect_view()
                    })
                }}
            </ul>
        </div>
    }
}
