//! The lookout: it watches the workers and delivers one batched digest to
//! their handler. It is the mechanism for up — many workers report, one
//! handler hears — and it is a participant in neither direction: it never
//! sends an instruction to anyone.
//!
//! `../../../../docs/design/lookout.md` is the design record. Four things it
//! never does, each load-bearing rather than an omission:
//!
//! - **No API and no write path of its own.** Nothing registers with it. It
//!   reads the reporting lines (a KV bucket the spawn tool owns) and the bus,
//!   and writes only into a handler.
//! - **It never parses a message body.** Whether a query is open is a subject
//!   and a `queryId`; how long a worker has been silent is a timestamp.
//!   `facts::observe` is the whole of what it reads off an event, and
//!   `facts`' own tests pin that content cannot reach a classification.
//! - **It renders no verdict.** It establishes facts — a query closed, a
//!   conversation went quiet. Whether the work is acceptable is judgment, and
//!   judgment belongs to an agent.
//! - **It carries no workflow knowledge.** It knows nothing of missions,
//!   phases, or what any kind of work means; a completely new kind of work is
//!   addable without touching it.

pub mod classify;
pub mod digest;
pub mod facts;
pub mod lines;
pub mod watch;
