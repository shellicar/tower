//! The staleness rail: reads the `rail` and `approvals` concerns (the
//! pending-marker and the void-list are each concern's own slice, not a
//! shared store — Decision 2's default). Owns no state of its own; the open
//! conversation and every action are the composition root's.

use leptos::prelude::*;

use crate::concerns::approvals::{Approvals, ask_label};
use crate::concerns::rail::Rail;
use crate::time::{Liveness, Millis, age};
use crate::transport::Status;
use crate::ui::short;

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

#[component]
pub fn RailView(
    rail: RwSignal<Rail>,
    approvals: RwSignal<Approvals>,
    now: RwSignal<Millis>,
    /// The active tab's open set — a row is "selected" if it's in it. A
    /// derived `Signal`, not the `View` concern itself: this component reads
    /// one fact (which convs are open), not the whole tab machine.
    open_convs: Signal<Vec<String>>,
    status: Signal<Status>,
    on_open: Callback<String>,
    on_dismiss: Callback<String>,
    on_dismiss_attachment: Callback<String>,
) -> impl IntoView {
    view! {
        <aside class="rail">
            <header class="rail-header">
                <h1>"Tower"</h1>
                <span class="meta">
                    {move || {
                        let n = approvals.with(|a| a.live(now.get()).len());
                        (n > 0).then(|| view! { <span class="awaiting">{format!("⚠ {n}")}</span> })
                    }}
                    <span class=move || {
                        let cls = match status.get() {
                            Status::Connected => "connected",
                            _ => "disconnected",
                        };
                        format!("status {cls}")
                    }>
                        {move || match status.get() {
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
                                let selected = open_convs.with(|c| c.contains(&conv));
                                let heat = heat_class(now.get(), row.last_event);
                                view! {
                                    <li
                                        class:selected=selected
                                        on:click=move |_| on_open.run(conv_click.clone())
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
                        r.attached_only(now.get())
                            .into_iter()
                            .map(|p| {
                                let conv = p.conv.to_owned();
                                let conv_click = conv.clone();
                                let conv_dismiss = conv.clone();
                                let cwd = p.cwd.map(str::to_owned);
                                let stranded = p.verdict == Some(Liveness::Stranded);
                                let dot = p.verdict.map(|l| match l {
                                    Liveness::Alive => "alive",
                                    Liveness::Stranded => "stranded",
                                });
                                view! {
                                    <li on:click=move |_| on_open.run(conv_click.clone())>
                                        <span class="row-main">
                                            {dot.map(|cls| view! { <span class=format!("dot {cls}")></span> })}
                                            <span class="label">{short(&conv)}</span>
                                        </span>
                                        <span class="row-side">
                                            "served, silent"
                                            {stranded.then(|| {
                                                view! {
                                                    <button
                                                        class="dismiss"
                                                        on:click=move |ev| {
                                                            ev.stop_propagation();
                                                            on_dismiss_attachment.run(conv_dismiss.clone());
                                                        }
                                                    >
                                                        "Dismiss"
                                                    </button>
                                                }
                                            })}
                                        </span>
                                        {cwd.map(|c| view! { <span class="cwd">{c}</span> })}
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
                                            <button on:click=move |_| on_dismiss.run(id.clone())>"Dismiss"</button>
                                        </li>
                                    }
                                })
                                .collect_view()
                        })
                }}
            </ul>
        </aside>
    }
}
