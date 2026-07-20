//! The staleness rail: reads the `rail` and `approvals` concerns (the
//! pending-marker and the void-list are each concern's own slice, not a
//! shared store — Decision 2's default). Owns no state of its own; the open
//! conversation and every action are the composition root's.

use std::collections::HashMap;

use leptos::prelude::*;

use crate::concerns::approvals::Approvals;
use crate::concerns::rail::Rail;
use crate::concerns::view::View;
use crate::time::{Liveness, Millis, age};
use crate::transport::Status;
use crate::ui::short;
use ws_types::WsRow;

fn view_key(tab_name: &str) -> String {
    format!("tower.viewConfig.{tab_name}")
}

/// Persists the active tab's filters/grouping — local only, keyed by tab
/// name (mirrors mvp/frontend's `View.saveView`, called here rather than in
/// the concern since it's UI-triggered browser persistence, the same split
/// `conversation.rs`'s draft save uses).
fn save_view(tab_name: &str, view: &View) {
    let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) else {
        return;
    };
    let cfg = &view.view_config();
    let json = serde_json::json!({
        "filters": cfg.filters,
        "groupKey": cfg.group_key,
        "alwaysShow": cfg.always_show,
        "hideUntagged": cfg.hide_untagged,
    });
    let _ = storage.set_item(&view_key(tab_name), &json.to_string());
}

/// A tab's persisted view config, by name — defaults when never saved (a tab
/// new to this browser, e.g. one another client created). Passed into
/// `View::apply` as the fallback for a tab name this browser has never held.
pub fn load_view(tab_name: &str) -> crate::concerns::view::ViewConfig {
    use crate::concerns::view::ViewConfig;
    let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) else {
        return ViewConfig::default();
    };
    let Ok(Some(raw)) = storage.get_item(&view_key(tab_name)) else {
        return ViewConfig::default();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return ViewConfig::default();
    };
    ViewConfig {
        filters: serde_json::from_value(v.get("filters").cloned().unwrap_or_default()).unwrap_or_default(),
        group_key: v.get("groupKey").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned(),
        always_show: serde_json::from_value(v.get("alwaysShow").cloned().unwrap_or_default()).unwrap_or_default(),
        hide_untagged: v.get("hideUntagged").and_then(serde_json::Value::as_bool).unwrap_or(false),
    }
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

/// One section of grouped rows, or the single flat group when ungrouped.
struct Section {
    label: Option<String>,
    rows: Vec<WsRow>,
    max: Millis,
}

fn tag_of(row: &WsRow, key: &str) -> String {
    row.tags.get(key).cloned().unwrap_or_else(|| "(untagged)".to_owned())
}

fn matches(row: &WsRow, filters: &HashMap<String, Vec<String>>) -> bool {
    filters.iter().all(|(k, vs)| vs.is_empty() || vs.contains(&tag_of(row, k)))
}

#[component]
pub fn RailView(
    rail: RwSignal<Rail>,
    approvals: RwSignal<Approvals>,
    view: RwSignal<View>,
    now: RwSignal<Millis>,
    /// The active tab's open set — a row is "selected" if it's in it. A
    /// derived `Signal`, not the `View` concern itself: this component reads
    /// one fact (which convs are open), not the whole tab machine.
    open_convs: Signal<Vec<String>>,
    status: Signal<Status>,
    on_toggle: Callback<String>,
    on_dismiss_attachment: Callback<String>,
    on_toggle_approvals: Callback<()>,
    on_toggle_unread: Callback<()>,
) -> impl IntoView {
    // Which key's values are expanded in the facet bar; component-local UI
    // state, same footing as Svelte's `expandedKey` in `RowList.svelte`.
    let expanded_key = RwSignal::new(String::new());

    let tab_name = move || view.with(|v| v.tab().name.clone());

    let keys = move || rail.with(|r| { let mut ks: Vec<String> = r.tag_keys().keys().cloned().collect(); ks.sort(); ks });
    view! {
        <aside class="rail">
            <header class="rail-header">
                <h1>"Tower"</h1>
                <span class="meta">
                    {move || {
                        let n = approvals.with(|a| a.live(now.get()).len());
                        (n > 0).then(|| view! {
                            <button class="awaiting" on:click=move |_| on_toggle_approvals.run(())>
                                {format!("⚠ {n}")}
                            </button>
                        })
                    }}
                    {move || {
                        let n = rail.with(|r| r.stale_rows().len());
                        (n > 0).then(|| view! {
                            <button class="unread-toggle" on:click=move |_| on_toggle_unread.run(())>
                                {format!("● {n}")}
                            </button>
                        })
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
            <div class="view-controls">
                <div class="controls-row">
                    <span class="dim">"group"</span>
                    <select
                        prop:value=move || view.with(|v| v.view_config().group_key.clone())
                        on:change=move |ev| {
                            let key = event_target_value(&ev);
                            view.update(|v| v.set_group_key(key));
                            save_view(&tab_name(), &view.get_untracked());
                        }
                    >
                        <option value="">"none"</option>
                        {move || keys().into_iter().map(|k| view! { <option value=k.clone()>{k.clone()}</option> }).collect_view()}
                    </select>
                    {move || {
                        (!view.with(|v| v.view_config().group_key.is_empty())).then(|| {
                            let hidden = view.with(|v| v.view_config().hide_untagged);
                            view! {
                                <button
                                    class="facet-toggle"
                                    class:on=hidden
                                    on:click=move |_| {
                                        view.update(|v| v.toggle_hide_untagged());
                                        save_view(&tab_name(), &view.get_untracked());
                                    }
                                >"hide untagged"</button>
                            }
                        })
                    }}
                    <span class="dim">"show"</span>
                    {move || {
                        rail.with(|r| {
                            let tag_keys = r.tag_keys().clone();
                            keys()
                                .into_iter()
                                .map(|k| {
                                    let on = view.with(|v| v.view_config().always_show.contains(&k));
                                    let colour = tag_keys.get(&k).cloned().unwrap_or_default();
                                    let k2 = k.clone();
                                    view! {
                                        <button
                                            class="facet-toggle"
                                            class:on=on
                                            style=move || on.then(|| format!("color: {colour}")).unwrap_or_default()
                                            on:click=move |_| {
                                                view.update(|v| v.toggle_always_show(&k2));
                                                save_view(&tab_name(), &view.get_untracked());
                                            }
                                        >{k}</button>
                                    }
                                })
                                .collect_view()
                        })
                    }}
                </div>
                <div class="controls-row">
                    <span class="dim">"filter"</span>
                    {move || {
                        keys()
                            .into_iter()
                            .map(|k| {
                                let count = view.with(|v| v.view_config().filters.get(&k).map(Vec::len).unwrap_or(0));
                                let expanded = expanded_key.with(|e| e == &k);
                                let k2 = k.clone();
                                view! {
                                    <button
                                        class="facet-toggle"
                                        class:on=(expanded || count > 0)
                                        on:click=move |_| {
                                            expanded_key.update(|e| *e = if *e == k2 { String::new() } else { k2.clone() });
                                        }
                                    >
                                        {if count > 0 { format!("{k} ({count})") } else { k }}
                                    </button>
                                }
                            })
                            .collect_view()
                    }}
                </div>
                {move || {
                    let ek = expanded_key.get();
                    (!ek.is_empty()).then(|| {
                        let ek3 = ek.clone();
                        let colour = rail.with(|r| r.tag_keys().get(&ek).cloned().unwrap_or_default());
                        // Value counts honour the OTHER keys' filters.
                        let mut counts: HashMap<String, usize> = HashMap::new();
                        rail.with(|r| {
                            let filters = view.with(|v| v.view_config().filters.clone());
                            for row in r.ordered() {
                                let others_match = filters.iter().all(|(k, vs)| k == &ek || vs.is_empty() || vs.contains(&tag_of(row, k)));
                                if others_match && let Some(v) = row.tags.get(&ek) {
                                    *counts.entry(v.clone()).or_insert(0) += 1;
                                }
                            }
                        });
                        let mut values: Vec<(String, usize)> = counts.into_iter().collect();
                        values.sort_by(|a, b| b.1.cmp(&a.1));
                        view! {
                            <div class="controls-row facet-values">
                                {values.into_iter().map(|(value, count)| {
                                    let selected = view.with(|v| v.view_config().filters.get(&ek3).map(|vs| vs.contains(&value)).unwrap_or(false));
                                    let value2 = value.clone();
                                    let ek4 = ek3.clone();
                                    let colour = colour.clone();
                                    view! {
                                        <button
                                            class="facet-value"
                                            class:on=selected
                                            style=move || selected.then(|| format!("color: {colour}")).unwrap_or_default()
                                            on:click=move |_| {
                                                view.update(|v| v.toggle_filter(&ek4, &value2));
                                                save_view(&tab_name(), &view.get_untracked());
                                            }
                                        >{format!("{value} ({count})")}</button>
                                    }
                                }).collect_view()}
                            </div>
                        }
                    })
                }}
            </div>
            <ul class="rows">
                {move || {
                    let pending = rail.with(|r| r.pending_by_conv(now.get()));
                    let filters = view.with(|v| v.view_config().filters.clone());
                    let group_key = view.with(|v| v.view_config().group_key.clone());
                    let hide_untagged = view.with(|v| v.view_config().hide_untagged);
                    let always_show = view.with(|v| v.view_config().always_show.clone());
                    rail.with(|r| {
                        let visible: Vec<WsRow> = r.ordered().into_iter().filter(|row| matches(row, &filters)).cloned().collect();
                        let sections: Vec<Section> = if group_key.is_empty() {
                            vec![Section { label: None, rows: visible, max: 0 }]
                        } else {
                            let mut grouped: Vec<(String, Vec<WsRow>)> = Vec::new();
                            for row in visible {
                                let value = row.tags.get(&group_key).cloned();
                                if value.is_none() && hide_untagged {
                                    continue;
                                }
                                let label = value.unwrap_or_else(|| "(untagged)".to_owned());
                                match grouped.iter_mut().find(|(l, _)| l == &label) {
                                    Some((_, rows)) => rows.push(row),
                                    None => grouped.push((label, vec![row])),
                                }
                            }
                            let mut sections: Vec<Section> = grouped
                                .into_iter()
                                .map(|(label, rows)| {
                                    let max = rows.iter().map(|r| r.last_event).max().unwrap_or(0);
                                    Section { label: Some(label), rows, max }
                                })
                                .collect();
                            sections.sort_by(|a, b| {
                                let ua = (a.label.as_deref() == Some("(untagged)")) as u8;
                                let ub = (b.label.as_deref() == Some("(untagged)")) as u8;
                                ua.cmp(&ub).then(b.max.cmp(&a.max))
                            });
                            sections
                        };
                        sections
                            .into_iter()
                            .map(|section| {
                                let header = section.label.clone().map(|label| {
                                    let count = section.rows.len();
                                    let max = section.max;
                                    let heat = heat_class(now.get(), max);
                                    let colour = rail.with(|r| r.tag_keys().get(&group_key).cloned().unwrap_or_default());
                                    view! {
                                        <li class="section-header">
                                            <span style=format!("color: {colour}")>{label}</span>
                                            <span class="dim">{count}" · "<span class=format!("age {heat}")>{age(now.get(), max)}</span></span>
                                        </li>
                                    }
                                });
                                let rows = section.rows.into_iter().map(|row| {
                                    let conv = row.conv.clone();
                                    let conv_click = conv.clone();
                                    let label = row.title.clone().unwrap_or_else(|| short(&conv));
                                    let is_pending = pending.contains(&conv);
                                    let live = rail.with(|r| r.verdict(&conv, now.get()));
                                    let selected = open_convs.with(|c| c.contains(&conv));
                                    let heat = heat_class(now.get(), row.last_event);
                                    let chips: Vec<_> = always_show
                                        .iter()
                                        .filter_map(|k| {
                                            row.tags.get(k).map(|v| {
                                                let colour = rail.with(|r| r.tag_keys().get(k).cloned().unwrap_or_default());
                                                view! { <span class="tag-chip" style=format!("color: {colour}")>{v.clone()}</span> }
                                            })
                                        })
                                        .collect();
                                    view! {
                                        <li
                                            class:selected=selected
                                            on:click=move |_| on_toggle.run(conv_click.clone())
                                        >
                                            <span class="row-main">
                                                {is_pending.then(|| view! { <span class="pending-mark">"⚠"</span> })}
                                                {rail.with(|r| r.stale_convs().contains(&conv)).then(|| view! {
                                                    <span class="stale-mark" title="nobody's looked at this since it last got new content">"●"</span>
                                                })}
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
                                            {(!chips.is_empty()).then(|| view! { <span class="tag-chips">{chips}</span> })}
                                        </li>
                                    }
                                }).collect_view();
                                view! { <>{header}{rows}</> }
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
                                    <li on:click=move |_| on_toggle.run(conv_click.clone())>
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
        </aside>
    }
}
