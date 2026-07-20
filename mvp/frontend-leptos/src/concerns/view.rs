//! concerns/view — the view concern (docs/mvp/frontend-architecture.md),
//! ported from mvp/frontend's view.svelte.ts. It owns the shell's tabs and
//! each tab's open set.
//!
//! Promoted onto the wire (settled with the SC 19 Jul, building on the 12 Jul
//! "tower owns the management structure, clients only render it" decision):
//! `tabs` (names + open sets) is now shared, durable fleet state — every
//! connected client sees the same tabs, live, like tmux attach. `apply`
//! folds the server's `Layout` snapshot/broadcast; the action methods mutate
//! locally AND return the `ClientMsg::SetLayout` to send, the same
//! optimistic-write-then-reconcile shape `Rail::set_title` already uses.
//! `active` (which tab is in front) stays local-only, deliberately: which
//! window you're looking at is a fact about the viewer, not the workspace —
//! the same split the SC drew for browser profiles on 12 Jul.
//!
//! `ViewConfig` (filters/grouping) is ported too, local-only like `active`
//! (a fact about how this viewer sliced the rail, not the shared
//! workspace), held per tab and re-attached by name across a `layout` fold
//! — the same "held annotation survives the upsert" pattern the rail uses
//! for titles.

use std::collections::HashMap;

use ws_types::{ClientMsg, ServerMsg, WsTab};

/// The rail's view configuration — per tab, local only. Mirrors
/// mvp/frontend's `ViewConfig`.
#[derive(Debug, Clone, Default)]
pub struct ViewConfig {
    /// key -> selected values; OR within a key, AND across keys.
    pub filters: HashMap<String, Vec<String>>,
    /// Section the rail by this key; empty = flat.
    pub group_key: String,
    /// Keys whose values decorate rows (value only; colour carries the key).
    pub always_show: Vec<String>,
    /// When grouping, drop rows that lack the group key entirely.
    pub hide_untagged: bool,
}

/// A tab is a whole working view: its own config AND its own open set.
#[derive(Debug, Clone)]
pub struct Tab {
    pub name: String,
    pub convs: Vec<String>,
    pub view: ViewConfig,
}

impl From<&Tab> for WsTab {
    fn from(t: &Tab) -> Self {
        WsTab { name: t.name.clone(), convs: t.convs.clone() }
    }
}

impl From<WsTab> for Tab {
    fn from(t: WsTab) -> Self {
        Tab { name: t.name, convs: t.convs, view: ViewConfig::default() }
    }
}

#[derive(Clone)]
pub struct View {
    pub tabs: Vec<Tab>,
    pub active: usize,
    /// Whether the fleet-wide approvals panel is showing — local-only, same
    /// footing as `active` (a fact about this viewer, not the shared
    /// workspace). Mirrors mvp/frontend's `view.approvalsOpen`.
    pub approvals_open: bool,
}

impl Default for View {
    fn default() -> Self {
        View {
            tabs: vec![Tab { name: "main".to_owned(), convs: Vec::new(), view: ViewConfig::default() }],
            active: 0,
            approvals_open: false,
        }
    }
}

impl View {
    /// The `layout` snapshot/broadcast: replaces the tabs wholesale — the
    /// wire's `list`-style fold, not a delta. Absent (a `Layout` with no
    /// tabs) before any client has ever set one; keep the local default
    /// rather than replace it with an empty set, so a fresh fleet still
    /// shows one usable tab instead of none.
    /// `load_config` supplies a `ViewConfig` for a tab name this browser has
    /// never held (mvp/frontend's `readViewConfig(name)` — a previously
    /// saved local config, or the default when there is none). Held config
    /// from tabs already in memory always wins; the loader only fires for a
    /// name genuinely new to this fold.
    pub fn apply(&mut self, event: &ServerMsg, load_config: impl Fn(&str) -> ViewConfig) -> bool {
        if let ServerMsg::Layout { tabs } = event
            && !tabs.is_empty()
        {
            // Held view config (filters/grouping) survives the wholesale
            // replace, re-attached by name — the same pattern the rail uses
            // for titles across a row upsert.
            let held: HashMap<String, ViewConfig> =
                self.tabs.drain(..).map(|t| (t.name, t.view)).collect();
            self.tabs = tabs
                .iter()
                .cloned()
                .map(|t| Tab {
                    view: held.get(&t.name).cloned().unwrap_or_else(|| load_config(&t.name)),
                    ..Tab::from(t)
                })
                .collect();
            if self.active >= self.tabs.len() {
                self.active = self.tabs.len() - 1;
            }
            true
        } else {
            false
        }
    }

    /// The active tab; tabs always number at least one, so this never panics.
    pub fn tab(&self) -> &Tab {
        &self.tabs[self.active.min(self.tabs.len() - 1)]
    }

    fn set_layout_msg(&self, id: String) -> ClientMsg {
        ClientMsg::SetLayout {
            id,
            tabs: self.tabs.iter().map(WsTab::from).collect(),
        }
    }

    pub fn add_tab(&mut self, id: String) -> ClientMsg {
        self.tabs.push(Tab {
            name: format!("view {}", self.tabs.len() + 1),
            convs: Vec::new(),
            view: ViewConfig::default(),
        });
        self.active = self.tabs.len() - 1;
        self.set_layout_msg(id)
    }

    /// The last tab never closes — a shell with no working view is not a
    /// smaller shell, it's a broken one. `None` when there was nothing to
    /// send (the guard rejected the close).
    pub fn close_tab(&mut self, i: usize, id: String) -> Option<ClientMsg> {
        if self.tabs.len() <= 1 || i >= self.tabs.len() {
            return None;
        }
        self.tabs.remove(i);
        if self.active >= self.tabs.len() {
            self.active = self.tabs.len() - 1;
        }
        Some(self.set_layout_msg(id))
    }

    pub fn rename_tab(&mut self, i: usize, name: &str, id: String) -> Option<ClientMsg> {
        let name = name.trim();
        if name.is_empty() {
            return None;
        }
        let tab = self.tabs.get_mut(i)?;
        tab.name = name.to_owned();
        Some(self.set_layout_msg(id))
    }

    /// Local-only: which tab is in front is a fact about this viewer, not
    /// the shared workspace (module doc).
    pub fn switch_tab(&mut self, i: usize) {
        if i < self.tabs.len() {
            self.active = i;
        }
    }

    /// Adds to the active tab's open set if not already there. The caller
    /// (composition root) follows this with `Conversations::set_open(tab().convs)`.
    /// `None` when the conversation was already open (nothing changed to send).
    pub fn open_conversation(&mut self, conv: &str, id: String) -> Option<ClientMsg> {
        let active = self.active.min(self.tabs.len() - 1);
        let tab = &mut self.tabs[active];
        if tab.convs.iter().any(|c| c == conv) {
            return None;
        }
        tab.convs.push(conv.to_owned());
        Some(self.set_layout_msg(id))
    }

    pub fn close_conversation(&mut self, conv: &str, id: String) -> ClientMsg {
        let active = self.active.min(self.tabs.len() - 1);
        self.tabs[active].convs.retain(|c| c != conv);
        self.set_layout_msg(id)
    }

    pub fn toggle_approvals(&mut self) {
        self.approvals_open = !self.approvals_open;
    }

    pub fn close_approvals(&mut self) {
        self.approvals_open = false;
    }

    /// The active tab's config — what the rail reads and mutates.
    pub fn view_config(&self) -> &ViewConfig {
        &self.tab().view
    }

    fn active_view_mut(&mut self) -> &mut ViewConfig {
        let active = self.active.min(self.tabs.len() - 1);
        &mut self.tabs[active].view
    }

    pub fn set_group_key(&mut self, key: String) {
        self.active_view_mut().group_key = key;
    }

    pub fn toggle_hide_untagged(&mut self) {
        let v = self.active_view_mut();
        v.hide_untagged = !v.hide_untagged;
    }

    pub fn toggle_always_show(&mut self, key: &str) {
        let v = self.active_view_mut();
        if let Some(i) = v.always_show.iter().position(|k| k == key) {
            v.always_show.remove(i);
        } else {
            v.always_show.push(key.to_owned());
        }
    }

    /// OR within a key: toggling a value adds/removes it from that key's set.
    pub fn toggle_filter(&mut self, key: &str, value: &str) {
        let v = self.active_view_mut();
        let vs = v.filters.entry(key.to_owned()).or_default();
        if let Some(i) = vs.iter().position(|x| x == value) {
            vs.remove(i);
        } else {
            vs.push(value.to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_with_one_tab_and_an_empty_open_set() {
        let v = View::default();
        assert_eq!(v.tabs.len(), 1);
        assert!(v.tab().convs.is_empty());
    }

    #[test]
    fn opening_a_conversation_adds_it_once_and_sends_only_the_first_time() {
        let mut v = View::default();
        assert!(v.open_conversation("a", "r1".into()).is_some());
        assert!(v.open_conversation("a", "r2".into()).is_none());
        assert_eq!(v.tab().convs, ["a"]);
    }

    #[test]
    fn closing_removes_it_from_the_active_tab_only() {
        let mut v = View::default();
        v.open_conversation("a", "r1".into());
        v.add_tab("r2".into());
        v.open_conversation("b", "r3".into());
        v.close_conversation("b", "r4".into());
        assert!(v.tab().convs.is_empty());
        v.switch_tab(0);
        assert_eq!(v.tab().convs, ["a"]);
    }

    #[test]
    fn add_tab_switches_to_it_and_starts_empty() {
        let mut v = View::default();
        v.open_conversation("a", "r1".into());
        v.add_tab("r2".into());
        assert_eq!(v.active, 1);
        assert!(v.tab().convs.is_empty());
    }

    #[test]
    fn the_last_tab_cannot_close() {
        let mut v = View::default();
        assert!(v.close_tab(0, "r1".into()).is_none());
        assert_eq!(v.tabs.len(), 1);
    }

    #[test]
    fn closing_the_active_tab_falls_back_to_the_previous_one() {
        let mut v = View::default();
        v.add_tab("r1".into());
        v.add_tab("r2".into());
        assert_eq!(v.active, 2);
        v.close_tab(2, "r3".into());
        assert_eq!(v.active, 1);
    }

    #[test]
    fn rename_trims_and_ignores_blank() {
        let mut v = View::default();
        v.rename_tab(0, "  work  ", "r1".into());
        assert_eq!(v.tabs[0].name, "work");
        assert!(v.rename_tab(0, "   ", "r2".into()).is_none());
        assert_eq!(v.tabs[0].name, "work"); // blank ignored
    }

    #[test]
    fn apply_replaces_tabs_wholesale_but_ignores_an_empty_snapshot() {
        let mut v = View::default();
        v.apply(
            &ServerMsg::Layout {
                tabs: vec![WsTab { name: "shared".into(), convs: vec!["x".into()] }],
            },
            |_| ViewConfig::default(),
        );
        assert_eq!(v.tabs.len(), 1);
        assert_eq!(v.tabs[0].name, "shared");
        assert_eq!(v.tab().convs, ["x"]);

        // An empty snapshot (nothing set yet, fresh fleet) doesn't wipe the
        // local default down to zero tabs.
        v.apply(&ServerMsg::Layout { tabs: vec![] }, |_| ViewConfig::default());
        assert_eq!(v.tabs.len(), 1);
    }
}
