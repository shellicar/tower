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
//! Scope note: this build ports tabs and rename; the filter/group/facet
//! machine `view.svelte.ts` also owns stays out for now — a further,
//! lower-priority ask, not free to include silently on the coattails of
//! this one.

use ws_types::{ClientMsg, ServerMsg, WsTab};

/// A tab is a whole working view: its own open set. (Svelte's `Tab` also
/// carries `view: ViewConfig` for filters/grouping — omitted here, see the
/// module doc's scope note.)
#[derive(Debug, Clone)]
pub struct Tab {
    pub name: String,
    pub convs: Vec<String>,
}

impl From<&Tab> for WsTab {
    fn from(t: &Tab) -> Self {
        WsTab { name: t.name.clone(), convs: t.convs.clone() }
    }
}

impl From<WsTab> for Tab {
    fn from(t: WsTab) -> Self {
        Tab { name: t.name, convs: t.convs }
    }
}

pub struct View {
    pub tabs: Vec<Tab>,
    pub active: usize,
}

impl Default for View {
    fn default() -> Self {
        View {
            tabs: vec![Tab { name: "main".to_owned(), convs: Vec::new() }],
            active: 0,
        }
    }
}

impl View {
    /// The `layout` snapshot/broadcast: replaces the tabs wholesale — the
    /// wire's `list`-style fold, not a delta. Absent (a `Layout` with no
    /// tabs) before any client has ever set one; keep the local default
    /// rather than replace it with an empty set, so a fresh fleet still
    /// shows one usable tab instead of none.
    pub fn apply(&mut self, event: &ServerMsg) {
        if let ServerMsg::Layout { tabs } = event
            && !tabs.is_empty()
        {
            self.tabs = tabs.iter().cloned().map(Tab::from).collect();
            if self.active >= self.tabs.len() {
                self.active = self.tabs.len() - 1;
            }
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
        self.tabs.push(Tab { name: format!("view {}", self.tabs.len() + 1), convs: Vec::new() });
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
        v.apply(&ServerMsg::Layout {
            tabs: vec![WsTab { name: "shared".into(), convs: vec!["x".into()] }],
        });
        assert_eq!(v.tabs.len(), 1);
        assert_eq!(v.tabs[0].name, "shared");
        assert_eq!(v.tab().convs, ["x"]);

        // An empty snapshot (nothing set yet, fresh fleet) doesn't wipe the
        // local default down to zero tabs.
        v.apply(&ServerMsg::Layout { tabs: vec![] });
        assert_eq!(v.tabs.len(), 1);
    }
}
