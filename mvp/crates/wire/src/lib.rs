//! Spec types + pure folds for the tower wire (docs/spec/*). No I/O, no
//! tokio: everything here is a function from bytes to values, tested against
//! the conformance fixtures in docs/spec/scenarios.md.

pub mod agent;
pub mod approval;
pub mod conv;
pub mod ids;
pub mod ingest;
pub mod say;
pub mod ts;

pub use agent::{AgentTelemetry, Attached, Detached, Pulse, Ready};
pub use approval::{AnswerOutcome, ApprovalLifecycle, encode_answer, parse_answer_reply};
pub use conv::{
    ConvBlock, ConvChange, ConvDelta, ConvTelemetry, Message, Query, Revision, TipMoved, Tolerant,
    ToolUse, TurnAborted, TurnCancelled, TurnEnded, TurnStarted, Usage,
};
pub use ids::{
    ApprovalId, ConversationId, InstanceId, MessageId, QueryId, TurnId, WorldId,
};
pub use ingest::{
    AgentEvent, AgentKind, ApprovalEvent, ApprovalKind, Event, EventKind, WireEvent, parse_wire,
};
pub use say::{
    ConvRequest, SayCommand, SayOutcome, encode_accepted, encode_rejected, encode_say,
    parse_request, parse_say_reply,
};
pub use ts::{format_ts, now_iso, parse_ts};
