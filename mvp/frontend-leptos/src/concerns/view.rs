//! concerns/view — the view concern (docs/mvp/frontend-architecture.md),
//! ported from mvp/frontend's view.svelte.ts. It owns the shell's local
//! state: tabs and each tab's open set. None of it touches the wire — its
//! inputs are user action (persistence is the ui layer's job, same split as
//! the composer's draft: this struct is pure and natively testable, the
//! `localStorage` read/write happens where it's called from). It decides
//! WHICH conversations are open; it never reads the conversation concern's
//! content, and the composition root is what drives
//! `Conversations::set_open` from a tab's `convs` after any mutation here —
//! a deliberate cross-concern action, not a shared state read (Decision 2).
//!
//! Scope note: this build ports tabs and rename (the SC asked for these
//! explicitly); the filter/group/facet machine `view.svelte.ts` also owns
//! stays out for now — a further, lower-priority ask, not free to include
//! silently on the coattails of this one.

/// A tab is a whole working view: its own open set. (Svelte's `Tab` also
/// carries `view: ViewConfig` for filters/grouping — omitted here, see the
/// module doc's scope note.)
#[derive(Debug, Clone)]
pub struct Tab {
    pub name: String,
    pub convs: Vec<String>,
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
    /// The active tab; tabs always number at least one, so this never panics.
    pub fn tab(&self) -> &Tab {
        &self.tabs[self.active.min(self.tabs.len() - 1)]
    }

    pub fn add_tab(&mut self) {
        self.tabs.push(Tab { name: format!("view {}", self.tabs.len() + 1), convs: Vec::new() });
        self.active = self.tabs.len() - 1;
    }

    /// The last tab never closes — a shell with no working view is not a
    /// smaller shell, it's a broken one.
    pub fn close_tab(&mut self, i: usize) {
        if self.tabs.len() <= 1 || i >= self.tabs.len() {
            return;
        }
        self.tabs.remove(i);
        if self.active >= self.tabs.len() {
            self.active = self.tabs.len() - 1;
        }
    }

    pub fn rename_tab(&mut self, i: usize, name: &str) {
        let name = name.trim();
        if !name.is_empty()
            && let Some(tab) = self.tabs.get_mut(i)
        {
            tab.name = name.to_owned();
        }
    }

    pub fn switch_tab(&mut self, i: usize) {
        if i < self.tabs.len() {
            self.active = i;
        }
    }

    /// Adds to the active tab's open set if not already there. The caller
    /// (composition root) follows this with `Conversations::set_open(tab().convs)`.
    pub fn open_conversation(&mut self, conv: &str) {
        let active = self.active.min(self.tabs.len() - 1);
        let tab = &mut self.tabs[active];
        if !tab.convs.iter().any(|c| c == conv) {
            tab.convs.push(conv.to_owned());
        }
    }

    pub fn close_conversation(&mut self, conv: &str) {
        let active = self.active.min(self.tabs.len() - 1);
        self.tabs[active].convs.retain(|c| c != conv);
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
    fn opening_a_conversation_adds_it_once() {
        let mut v = View::default();
        v.open_conversation("a");
        v.open_conversation("a");
        assert_eq!(v.tab().convs, ["a"]);
    }

    #[test]
    fn closing_removes_it_from_the_active_tab_only() {
        let mut v = View::default();
        v.open_conversation("a");
        v.add_tab();
        v.open_conversation("b");
        v.close_conversation("b");
        assert!(v.tab().convs.is_empty());
        v.switch_tab(0);
        assert_eq!(v.tab().convs, ["a"]);
    }

    #[test]
    fn add_tab_switches_to_it_and_starts_empty() {
        let mut v = View::default();
        v.open_conversation("a");
        v.add_tab();
        assert_eq!(v.active, 1);
        assert!(v.tab().convs.is_empty());
    }

    #[test]
    fn the_last_tab_cannot_close() {
        let mut v = View::default();
        v.close_tab(0);
        assert_eq!(v.tabs.len(), 1);
    }

    #[test]
    fn closing_the_active_tab_falls_back_to_the_previous_one() {
        let mut v = View::default();
        v.add_tab();
        v.add_tab();
        assert_eq!(v.active, 2);
        v.close_tab(2);
        assert_eq!(v.active, 1);
    }

    #[test]
    fn rename_trims_and_ignores_blank() {
        let mut v = View::default();
        v.rename_tab(0, "  work  ");
        assert_eq!(v.tabs[0].name, "work");
        v.rename_tab(0, "   ");
        assert_eq!(v.tabs[0].name, "work"); // blank ignored
    }
}
