//! The concerns: each an owned store that folds its OWN slice of the frame
//! stream and exposes read-only views. No concern references another. Ported
//! as plain structs (identical shape to frontend-rs), wrapped in a
//! `RwSignal<Rail>` etc. at the composition root — Leptos's ownership model
//! doesn't force field-by-field signals here; a signal around a plain,
//! natively-testable fold struct is the smaller move and keeps `apply` the
//! same shape across all three frontends. Revisit only if a component needs
//! to subscribe to one field of a concern without re-rendering on the rest.

pub mod rail;
