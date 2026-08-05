//! The lookout: it watches the workers and delivers one batched digest to
//! their handler. It is the mechanism for up — many workers report, one
//! handler hears — and it is a participant in neither direction: it never
//! sends an instruction to anyone.
//!
//! `../../../../docs/design/lookout.md` is the design record. Four things it
//! never does, each load-bearing rather than an omission:
//!
//! - **No API and no write path of its own.** Nothing registers with it. It
//!   reads the reporting lines (a KV bucket another tool owns) and the bus,
//!   and writes only into a handler.
//! - **It extracts, and never interprets.** Whether a query is open is a
//!   subject and a `queryId`; how long a worker has been silent is a
//!   timestamp. Pulling those out of an envelope is mechanical; deciding what
//!   a worker meant is not, and only the first happens here.
//!   `facts::observe` is the whole of what it reads off an event, and two
//!   tests hold the line at the level that matters: the same event classifies
//!   identically however its content differs, and an event whose content no
//!   message parser would accept still yields both facts.
//! - **It renders no verdict.** It establishes facts — a query closed, a
//!   conversation went quiet. Whether the work is acceptable is judgment, and
//!   judgment belongs to an agent.
//! - **It carries no workflow knowledge.** It knows nothing of missions,
//!   phases, or what any kind of work means; a completely new kind of work is
//!   addable without touching it.

pub mod classify;
pub mod daemon;
pub mod digest;
pub mod facts;
pub mod lines;
pub mod watch;
