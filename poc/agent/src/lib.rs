//! The agent component: a NATS bridge up, a streaming HTTP model client down,
//! and a one-turn-at-a-time loop between them. See `spec.md` for the contract.

pub mod agent;
pub mod bridge;
pub mod model;
pub mod protocol;
pub mod sse;
