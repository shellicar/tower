//! Shared scaffolding for the binary target's own test modules (agent.rs,
//! main.rs) — a plain `cfg(test)` suffices here, unlike bridge-testkit's
//! fakes, since this file compiles as part of the binary crate itself and
//! is under test whenever that crate's own tests run.
#![cfg(test)]

use std::sync::{Arc, RwLock};

use bridge_testkit::TestScratch;

/// A minimal, literal `AgentConfig` pointed at a test's own scratch dir —
/// every test that drives `serve_conversation`/`agent::run` needs one.
pub(crate) fn config(conv: &str, scratch: &TestScratch) -> crate::agent::AgentConfig {
    crate::agent::AgentConfig {
        conv: wire::ConversationId(conv.to_string()),
        model: Arc::new(RwLock::new("claude-sonnet-5".to_string())),
        system: Arc::new(RwLock::new(None)),
        context: Arc::new(RwLock::new(None)),
        auth: crate::anthropic::Auth::ApiKey,
        http: reqwest::Client::new(),
        skills_root: Arc::new(RwLock::new(std::path::PathBuf::new())),
        refs: crate::refs::open(&scratch.path("refs.db")).unwrap(),
        memory: crate::memory::open(&scratch.path("memory.db")).unwrap(),
        history: crate::history::open(&scratch.path("history.db")).unwrap(),
        thinking_budget: None,
        attach: None,
        cwd: Arc::new(RwLock::new(std::env::temp_dir())),
        permissions: Arc::new(RwLock::new(
            crate::permissions::PermissionSet::strict_default(),
        )),
    }
}
