//! Spec types + pure folds for the tower wire (docs/spec/*). No I/O, no
//! tokio: everything here is a function from bytes to values, tested against
//! the conformance fixtures in docs/spec/scenarios.md.

pub mod conv;
pub mod ids;
pub mod ingest;
pub mod say;
pub mod ts;

pub use conv::{ConvChange, ConvDelta, ConvTelemetry, Tolerant};
pub use ids::{ConversationId, MessageId, QueryId, TurnId};
pub use ingest::{Event, EventKind, parse_wire};
pub use say::{SayCommand, SayOutcome, encode_say, parse_say_reply};
pub use ts::parse_ts;
