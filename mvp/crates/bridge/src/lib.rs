//! The one part of bridge meant for a second consumer: the attach fd
//! mechanism (fd handoff, framing, tee) helm spawns bridge and dials into.
//! Everything else bridge does is the binary in main.rs — this lib target
//! exists solely so helm can depend on `bridge::attach` instead of
//! duplicating it.

pub mod attach;
