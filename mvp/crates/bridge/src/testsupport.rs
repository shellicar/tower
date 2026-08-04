//! Shared scaffolding for the binary target's own test modules (agent.rs,
//! main.rs) — a plain `cfg(test)` suffices here, unlike bridge-testkit's
//! fakes, since this file compiles as part of the binary crate itself and
//! is under test whenever that crate's own tests run.
#![cfg(test)]

use std::sync::{Arc, RwLock};

use bridge_testkit::{FakeBroker, TestScratch};

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

/// A literal `Host` over the FakeBroker — world `mac`, instance `inst-me`,
/// stream `conv-approval` — for tests that drive the world request path.
/// Arc-wrapped because that is how the request path holds it: the service
/// handler shares it with the work it hands off.
pub(crate) fn host(
    scratch: &TestScratch,
    broker: FakeBroker,
) -> Arc<crate::Host<FakeBroker, crate::anthropic::NoopDeltaSink>> {
    Arc::new(crate::Host {
        broker,
        delta: crate::anthropic::NoopDeltaSink,
        world: "mac".to_string(),
        instance: "inst-me".to_string(),
        default_model: Arc::new(RwLock::new("claude-sonnet-5".to_string())),
        auth: crate::anthropic::Auth::ApiKey,
        http: reqwest::Client::new(),
        skills_root: Arc::new(RwLock::new(std::path::PathBuf::new())),
        system: Arc::new(RwLock::new(None)),
        context: Arc::new(RwLock::new(None)),
        attach_bucket: "attach".to_string(),
        thinking_budget: None,
        refs: crate::refs::open(&scratch.path("refs.db")).unwrap(),
        memory: crate::memory::open(&scratch.path("memory.db")).unwrap(),
        history: crate::history::open(&scratch.path("history.db")).unwrap(),
        refs_path: scratch.path("refs.db"),
        memory_path: scratch.path("memory.db"),
        history_path: scratch.path("history.db"),
        attach: None,
        served: Arc::new(RwLock::new(std::collections::HashMap::new())),
        default_cwd: Arc::new(RwLock::new(std::env::temp_dir())),
        permissions: Arc::new(RwLock::new(
            crate::permissions::PermissionSet::strict_default(),
        )),
        stream: "conv-approval".to_string(),
        stream_ephemeral: "conv-ephemeral".to_string(),
        liveness: Arc::new(std::sync::Mutex::new(crate::service::WorldLiveness::new())),
    })
}
