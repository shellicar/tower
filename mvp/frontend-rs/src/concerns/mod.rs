//! The concerns: each an owned store that folds its OWN slice of the frame
//! stream and exposes read-only views. No concern references another — the
//! `apply(&mut self, &ServerMsg)` signature gives each a mutable borrow of only
//! itself, so a sibling reach does not compile. The composition root (the app)
//! knows every concern; the concerns are blind to each other.

pub mod approvals;
pub mod conversation;
pub mod rail;
