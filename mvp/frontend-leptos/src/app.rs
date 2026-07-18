//! The composition root: wires transport + concerns, same as frontend-rs's
//! app.rs and frontend's root. Owns every concern (a `RwSignal` per concern);
//! concerns are blind to each other — the hand knows the fingers, the fingers
//! don't know each other (docs/mvp/frontend-architecture.md).
//!
//! Fan-out survives the pull-vs-push change at the transport: the socket
//! callback offers each decoded frame to every concern's `apply` in turn,
//! same as egui's per-frame drain loop, just triggered by the frame's
//! arrival instead of a redraw tick.
//!
//! Reads vs writes split the same way Rust gives egui: `rail.with(...)`,
//! `conversations.with(...)` etc. take a shared borrow inside the closure, so
//! several concerns are read together while a view renders — no shared store
//! needed for that (Decision 2's "annotations shared" hard case stays a
//! non-issue). Actions call `.update(...)` on exactly one concern's signal;
//! Leptos's runtime borrow check (not the compiler, since signals are
//! `Copy`+interior-mutable) panics on a re-entrant borrow rather than
//! failing to compile — the Leptos-vs-egui enforcement finding, written up in
//! docs/mvp/frontend-comparison-leptos.md.

use leptos::ev;
use leptos::html;
use leptos::prelude::*;
use ws_types::ClientMsg;

use crate::concerns::approvals::{Approvals, ask_input, ask_label};
use crate::concerns::conversation::{Conversations, QueryState};
use crate::concerns::rail::Rail;
use crate::time::{Liveness, Millis, age};
use crate::transport::{IdCounter, Status, Transport};
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

/// The staleness id, shortened for the rail. Titled rows never reach here.
fn short(conv: &str) -> String {
    conv.chars().take(8).collect()
}

/// Staleness heat: fresh green, cooling yellow, cold grey — mvp/frontend's
/// `heat()` thresholds (1h, 6h), read here so the rail matches it exactly.
fn heat_class(now: Millis, ts: Millis) -> &'static str {
    let d = now - ts;
    if d < 3_600_000 {
        "fresh"
    } else if d < 21_600_000 {
        "cooling"
    } else {
        "cold"
    }
}

/// Cap a long value for a compact display — the raw input is the interim
/// reviewable primitive (approval-spec); the content vocabulary is later.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}\u{2026}")
    }
}

/// One content block, rendered per type — mirrors mvp/frontend's BlockView.svelte:
/// text stands open, everything else (thinking, tool traffic, unknown blocks)
/// collapses to a summary line via `<details>`, the primary render lever for
/// per-message collapsing (docs/mvp/tower-v1-design.md, weight-as-refs note).
fn render_block(block: &serde_json::Value) -> AnyView {
    use serde_json::Value;

    fn short(v: &Value, max: usize) -> String {
        let s = v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string());
        truncate(&s, max)
    }

    match block.get("type").and_then(Value::as_str) {
        Some("text") => {
            let text = block
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            view! { <div class="block text">{text}</div> }.into_any()
        }
        Some("thinking") => {
            let thinking = block
                .get("thinking")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            view! {
                <details class="block thinking">
                    <summary>"thinking"</summary>
                    <div class="block-body">{thinking}</div>
                </details>
            }
            .into_any()
        }
        Some("tool_use") => {
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned();
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            let preview = short(&input, 120);
            let full = serde_json::to_string_pretty(&input).unwrap_or_default();
            view! {
                <details class="block tool">
                    <summary>{format!("⚒ {name}")}" "<span class="dim">{preview}</span></summary>
                    <pre class="block-body">{full}</pre>
                </details>
            }
            .into_any()
        }
        Some("tool_result") => {
            let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let content = block.get("content").cloned().unwrap_or(Value::Null);
            let preview = short(&content, 120);
            let full = content
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string_pretty(&content).unwrap_or_default());
            let label = if is_error { "↩ result (error)" } else { "↩ result" };
            view! {
                <details class="block tool">
                    <summary>{label}" "<span class="dim">{preview}</span></summary>
                    <pre class="block-body">{full}</pre>
                </details>
            }
            .into_any()
        }
        Some("image") => view! { <span class="dim">"🖼 image"</span> }.into_any(),
        Some("document") => view! { <span class="dim">"📄 document"</span> }.into_any(),
        Some(other) => {
            let full = serde_json::to_string_pretty(block).unwrap_or_default();
            let other = other.to_owned();
            view! {
                <details class="block">
                    <summary>{other}</summary>
                    <pre class="block-body">{full}</pre>
                </details>
            }
            .into_any()
        }
        None => view! { <span class="dim">"[block]"</span> }.into_any(),
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

    // The re-render ticker — a per-concern cadence detail (Decision 1). Both
    // liveness and approval-void verdicts read `now`; 1s covers both without
    // a bespoke ticker per verdict.
    set_interval(
        move || now.set(now_ms()),
        std::time::Duration::from_secs(1),
    );

    let open_conv = RwSignal::new(None::<String>);
    let draft = RwSignal::new(String::new());
    let messages_ref = NodeRef::<html::Div>::new();
    // Stick-to-bottom while reading live; a manual scroll up drops it, and
    // the "latest" button (mvp/frontend has none — this is a real gap it
    // named) offers the way back down.
    let at_bottom = RwSignal::new(true);

    let scroll_to_bottom = move || {
        if let Some(el) = messages_ref.get() {
            el.set_scroll_top(el.scroll_height());
        }
        at_bottom.set(true);
    };

    let send = move |msg: ClientMsg| transport.with_value(|t| t.send(&msg));
    let next_id = move || ids.try_update_value(|c| c.next()).expect("id counter");

    let open_conversation = move |conv: String| {
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
        if let Some(msg) = conversations
            .try_update(|c| c.open(&conv, id))
            .flatten()
        {
            send(msg);
        }
        open_conv.set(Some(conv));
        draft.set(String::new());
    };

    let send_current = move || {
        let Some(conv) = open_conv.get_untracked() else {
            return;
        };
        let text = draft.get_untracked();
        if text.trim().is_empty() {
            return;
        }
        draft.set(String::new());
        let id = next_id();
        if let Some(msg) = conversations
            .try_update(|c| c.say(&conv, text, id))
            .flatten()
        {
            send(msg);
        }
    };

    let cancel_current = move || {
        let Some(conv) = open_conv.get_untracked() else {
            return;
        };
        let id = next_id();
        if let Some(msg) = conversations
            .try_update(|c| c.cancel(&conv, id))
            .flatten()
        {
            send(msg);
        }
    };

    let answer_approval = move |approval_id: String, approved: bool| {
        let id = next_id();
        let msg = approvals.try_update(|a| a.answer(&approval_id, approved, id));
        if let Some(msg) = msg {
            send(msg);
        }
    };

    let dismiss_approval = move |approval_id: String| {
        approvals.update(|a| a.dismiss(&approval_id));
    };

    let upload_current = move |file: web_sys::File| {
        let Some(conv) = open_conv.get_untracked() else {
            return;
        };
        uploads::pick_and_upload(conv, file, move |Upload { conv, attachment }| {
            conversations.update(|c| c.attach(&conv, vec![attachment]));
        });
    };

    // Stick to the bottom while new content arrives and the reader hasn't
    // scrolled away; runs after the DOM patch, so scrollHeight already
    // reflects the new message/streaming chunk.
    Effect::new(move |_| {
        let conv = open_conv.get();
        let count = conv.as_ref().and_then(|c| {
            conversations.with(|cs| cs.get(c).map(|oc| oc.messages.len() + oc.streaming.len()))
        });
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
        let Some(conv) = open_conv.get() else {
            return;
        };
        if !draft.get_untracked().is_empty() {
            return;
        }
        let restore = conversations
            .with(|c| c.get(&conv).and_then(|oc| oc.restore_say.clone()));
        if let Some(restore) = restore {
            draft.set(restore);
            conversations.update(|c| c.consume_restore(&conv));
        }
    });

    view! {
        <div class="tower">
            <aside class="rail">
                <header class="rail-header">
                    <h1>"Tower"</h1>
                    <span class="meta">
                        {move || {
                            let n = approvals.with(|a| a.live(now.get()).len());
                            (n > 0).then(|| view! { <span class="awaiting">{format!("⚠ {n}")}</span> })
                        }}
                        <span class=move || {
                            let cls = match transport.with_value(|t| t.status()) {
                                Status::Connected => "connected",
                                _ => "disconnected",
                            };
                            format!("status {cls}")
                        }>
                            {move || match transport.with_value(|t| t.status()) {
                                Status::Connecting => "connecting…",
                                Status::Connected => "live",
                                Status::Closed => "reconnecting…",
                            }}
                        </span>
                    </span>
                </header>
                <ul class="rows">
                    {move || {
                        let pending = rail.with(|r| r.pending_by_conv(now.get()));
                        rail.with(|r| {
                            r.ordered()
                                .into_iter()
                                .map(|row| {
                                    let conv = row.conv.clone();
                                    let conv_click = conv.clone();
                                    let label = row.title.clone().unwrap_or_else(|| short(&conv));
                                    let is_pending = pending.contains(&conv);
                                    let live = rail.with(|r| r.verdict(&conv, now.get()));
                                    let selected = open_conv.get() == Some(conv.clone());
                                    let heat = heat_class(now.get(), row.last_event);
                                    view! {
                                        <li
                                            class:selected=selected
                                            on:click=move |_| open_conversation(conv_click.clone())
                                        >
                                            <span class="row-main">
                                                {is_pending.then(|| view! { <span class="pending-mark">"⚠"</span> })}
                                                {live.map(|l| {
                                                    let cls = match l {
                                                        Liveness::Alive => "alive",
                                                        Liveness::Stranded => "stranded",
                                                    };
                                                    view! { <span class=format!("dot {cls}")></span> }
                                                })}
                                                <span class="label">{label}</span>
                                            </span>
                                            <span class="row-side">
                                                <span class=format!("age {heat}")>{age(now.get(), row.last_event)}</span>
                                            </span>
                                        </li>
                                    }
                                })
                                .collect_view()
                        })
                    }}
                </ul>
                <ul class="potential">
                    {move || {
                        rail.with(|r| {
                            r.attached_only()
                                .into_iter()
                                .map(|conv| {
                                    let conv = conv.to_owned();
                                    let conv_click = conv.clone();
                                    view! {
                                        <li on:click=move |_| open_conversation(conv_click.clone())>
                                            {short(&conv)}
                                        </li>
                                    }
                                })
                                .collect_view()
                        })
                    }}
                </ul>
                <ul class="voided">
                    {move || {
                        approvals
                            .with(|a| {
                                a.pending()
                                    .into_iter()
                                    .filter(|ask| a.is_void(ask, now.get()))
                                    .map(|ask| {
                                        let id = ask.id.clone();
                                        let label = ask_label(ask).to_owned();
                                        view! {
                                            <li>
                                                {format!("{label} · holder gone")}
                                                <button on:click=move |_| dismiss_approval(id.clone())>"Dismiss"</button>
                                            </li>
                                        }
                                    })
                                    .collect_view()
                            })
                    }}
                </ul>
            </aside>

            <main class="conversation">
                {move || {
                    let Some(conv) = open_conv.get() else {
                        return view! { <p class="empty">"Open a conversation from the rail."</p> }
                            .into_any();
                    };
                    let header = rail
                        .with(|r| r.row(&conv).and_then(|row| row.title.clone()))
                        .unwrap_or_else(|| short(&conv));
                    let loaded = conversations.with(|c| c.get(&conv).map(|oc| oc.loaded));
                    let Some(loaded) = loaded else {
                        return view! { <p class="opening">"opening…"</p> }.into_any();
                    };

                    let conv_for_live = conv.clone();
                    let conv_for_note = conv.clone();
                    let conv_for_live_query = conv.clone();
                    let conv_for_pending = conv.clone();
                    let conv_for_upload = conv.clone();

                    view! {
                        <div class="conversation-inner">
                            <h2>{header}</h2>
                            {(!loaded).then(|| view! { <p class="opening">"loading…"</p> })}
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
                                                        <button class="approve" on:click=move |_| answer_approval(id_approve.clone(), true)>
                                                            "Approve"
                                                        </button>
                                                        <button class="deny" on:click=move |_| answer_approval(id_deny.clone(), false)>
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
                                            upload_current(file);
                                        }
                                        input.set_value("");
                                    }
                                />
                                {move || {
                                    let live = conversations
                                        .with(|c| c.get(&conv_for_upload).map(|oc| oc.query_state == QueryState::Live))
                                        .unwrap_or(false);
                                    live.then(|| view! { <button on:click=move |_| cancel_current()>"Cancel"</button> })
                                }}
                            </div>
                        </div>
                    }
                    .into_any()
                }}
            </main>
        </div>
    }
}
