//! ui — one Leptos component per render surface, each reading only the
//! concern(s) it needs (mvp/docs/frontend-architecture.md: "a component
//! reads a concern... and owns only local UI state"). `app.rs` stays the
//! composition root: it owns the concerns and the transport and wires these
//! together; it renders none of the detail itself.

pub mod approvals;
pub mod block;
pub mod conversation;
pub mod rail;
pub mod refview;
pub mod tabs;
pub mod unread;

/// Cap a long value for a compact display — the raw input is the interim
/// reviewable primitive (approval.md); the content vocabulary is later.
pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}\u{2026}")
    }
}
