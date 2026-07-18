//! concerns/usage — the per-conversation usage snapshot store, ported from
//! mvp/frontend's usage.svelte.ts. It folds one wire slice — the `usage`
//! frame — into an owned map, keyed by conversation. The frame is an
//! ABSOLUTE snapshot (towerd owns the accumulation, precisely because a
//! turn's usage streams cumulatively on the wire), so a fold is a
//! replacement, never a sum.
//!
//! Facts only: the snapshot is what towerd measured. The dollar and the
//! context percentage are display policy, derived by `crate::pricing` where
//! they are read — this concern holds no derivation.

use std::collections::HashMap;

use ws_types::{ServerMsg, WsUsage};

#[derive(Default)]
pub struct Usage {
    by_conv: HashMap<String, WsUsage>,
}

impl Usage {
    pub fn apply(&mut self, event: &ServerMsg) {
        if let ServerMsg::Usage(snapshot) = event {
            self.by_conv.insert(snapshot.conv.clone(), snapshot.clone());
        }
    }

    /// The conversation's usage, or None if none yet (absent = zero).
    pub fn get(&self, conv: &str) -> Option<&WsUsage> {
        self.by_conv.get(conv)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(conv: &str, input_tokens: i64) -> WsUsage {
        WsUsage {
            conv: conv.into(),
            model: "claude-sonnet-4-5".into(),
            input_tokens,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_creation_5m_tokens: 0,
            cache_creation_1h_tokens: 0,
            cache_read_tokens: 0,
            turns: 1,
            context_tokens: 0,
        }
    }

    #[test]
    fn a_later_frame_replaces_rather_than_accumulates() {
        let mut u = Usage::default();
        u.apply(&ServerMsg::Usage(snapshot("a", 100)));
        u.apply(&ServerMsg::Usage(snapshot("a", 250)));
        assert_eq!(u.get("a").unwrap().input_tokens, 250);
    }

    #[test]
    fn absent_until_the_first_frame() {
        let u = Usage::default();
        assert!(u.get("a").is_none());
    }

    #[test]
    fn keyed_per_conversation() {
        let mut u = Usage::default();
        u.apply(&ServerMsg::Usage(snapshot("a", 10)));
        u.apply(&ServerMsg::Usage(snapshot("b", 20)));
        assert_eq!(u.get("a").unwrap().input_tokens, 10);
        assert_eq!(u.get("b").unwrap().input_tokens, 20);
    }
}
