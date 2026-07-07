//! TUI component of the agent-over-NATS POC. The binary in `main.rs` wires this
//! together; the logic lives here where tests can reach it.

pub mod bridge;
pub mod protocol;
pub mod state;
pub mod ui;
