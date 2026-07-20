//! Seam types (tower-v1-design.md, Seams) — the wire-adjacent shapes `ViewEvent`
//! and `ViewQuery` carry, and the read-model state structs each query answers
//! with.

use serde_json::Value;
use tokio::sync::oneshot;

use wire::{ApprovalId, ConversationId, InstanceId, MessageId, QueryId, TurnId, WorldId};

#[derive(Debug, Clone)]
pub enum ViewEvent {
    Row(RowChanged),
    Message {
        conv: ConversationId,
        message: ConversationMessage,
    },
    Streaming {
        conv: ConversationId,
        text: String,
    },
    /// The in-flight stream changed character; the streaming chunks that
    /// follow are `block_type`. Ephemeral, like `Streaming`.
    StreamBlock {
        conv: ConversationId,
        block_type: String,
    },
    /// An approval's state changed — raised, pulsed, or settled. Awareness
    /// is unconditional, like `Row`.
    Approval(ApprovalState),
    /// One agent wire fact — one packet, however many conversations ride on
    /// it (a pulse never fans out per conversation). Awareness is
    /// unconditional, like `Row`.
    Agent(AgentFact),
    /// A query closed — the wire's committal closure, forwarded (not
    /// folded: towerd stores no query state; the client's knowledge is the
    /// client's). Gated by `open`, like `Message`.
    QueryClosed {
        conv: ConversationId,
        query: QueryId,
        reason: String,
    },
    /// The conversation's running cost surface — cumulative token totals, the
    /// turn count, and the latest turn's context size and model. Folded
    /// (towerd accumulates), gated by `open` like `Message`. Absolute
    /// snapshot: the client replaces what it holds, never sums.
    Usage(UsageState),
    /// The fleet's layout changed — tabs, JSON text verbatim (the shape a
    /// client already sent). Awareness is unconditional, like `Row`: every
    /// connected session sees the same shared workspace change live, the
    /// tmux-attach model settled 12 Jul.
    Layout(String),
    /// A human dismissed an attached-but-message-less conversation — tower's
    /// own annotation, not an agent fact (a real `Detached` still comes
    /// through `Agent`). Awareness is unconditional, like `Row`.
    AttachmentDismissed {
        world: WorldId,
        instance: InstanceId,
        conv: ConversationId,
    },
}

/// The agent concern's facts, verdict-free: alive/released/stranded is the
/// client's derivation from `last_pulse` against its own clock (the
/// approval-void pattern) — stored liveness would be false the moment it is
/// written.
#[derive(Debug, Clone)]
pub enum AgentFact {
    Ready {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        host: Option<String>,
    },
    Pulse {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        interval_s: i64,
    },
    Attached {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        conv: ConversationId,
        cwd: Option<String>,
        /// The liveness promise, optionally carried on attach too (docs/spec/
        /// agent-spec.md) — absent for a producer that hasn't been updated;
        /// the reader's fold applies its own default threshold then.
        interval_s: Option<i64>,
    },
    Detached {
        world: WorldId,
        instance: InstanceId,
        ts: i64,
        conv: ConversationId,
    },
}

#[derive(Debug, Clone)]
pub struct AgentInstanceState {
    pub world: WorldId,
    pub instance: InstanceId,
    pub host: Option<String>,
    pub last_pulse: i64,
    /// The instance's own promise; `None` until its first pulse.
    pub interval_s: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct AgentAttachmentState {
    pub world: WorldId,
    pub instance: InstanceId,
    pub conv: ConversationId,
    pub cwd: Option<String>,
    pub attached_ts: i64,
}

/// `agents`'s answer: every retained instance and every live attachment.
pub type AgentsSnapshot = (Vec<AgentInstanceState>, Vec<AgentAttachmentState>);

#[derive(Debug, Clone)]
pub struct ApprovalState {
    pub id: ApprovalId,
    /// Verbatim from the wire; ask types are an open set.
    pub ask: Value,
    pub correlation: Option<Value>,
    pub raised_ts: i64,
    pub last_pulse: i64,
    pub settled: Option<SettledState>,
    /// A human's own decision to stop tracking this ask — tower's annotation
    /// (`dismissed_approvals`), never a claim the ask was answered. Excluded
    /// from the outstanding snapshot once true.
    pub dismissed: bool,
}

#[derive(Debug, Clone)]
pub struct SettledState {
    pub approved: bool,
    pub by: Value,
    pub ts: i64,
}

#[derive(Debug, Clone)]
pub struct RowChanged {
    pub conv: ConversationId,
    pub last_event: i64,
    pub last_kind: String,
}

#[derive(Debug, Clone)]
pub struct RowState {
    pub conv: ConversationId,
    pub last_event: i64,
    pub last_kind: String,
    /// Tower's own annotation (`titles` table) — never wire state.
    pub title: Option<String>,
    /// Tower's own annotations (`tags` table) — flat key:value, verbatim.
    pub tags: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ConversationMessage {
    pub id: MessageId,
    pub query: QueryId,
    pub turn: TurnId,
    pub role: String,
    /// Absent for a tool_result — it carries no sender (conversation-spec:
    /// a mechanical delivery is not an utterance).
    pub from: Option<Value>,
    pub content: Vec<Value>,
    pub ts: i64,
}

/// One conversation's usage fold: cumulative token totals + turn count, plus
/// the latest turn's context size and model. Facts only; the client prices
/// the dollar and the context percentage.
#[derive(Debug, Clone)]
pub struct UsageState {
    pub conv: ConversationId,
    pub input_tokens: i64,
    pub cache_creation_tokens: i64,
    /// The 5m/1h split of cache_creation, cumulative like the total. Both 0
    /// when the producer never reported the breakdown.
    pub cache_creation_5m_tokens: i64,
    pub cache_creation_1h_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub turns: i64,
    pub context_tokens: i64,
    pub model: String,
}

/// `list`'s answer: the rows and the key→colour map (the shared colour
/// language), one round trip.
pub type ListSnapshot = (Vec<RowState>, Vec<(String, String)>);

pub enum ViewQuery {
    List {
        reply: oneshot::Sender<ListSnapshot>,
    },
    Conversation {
        conv: ConversationId,
        /// The client's high-water mark; `None` = from the start.
        after: Option<i64>,
        reply: oneshot::Sender<Vec<ConversationMessage>>,
    },
    /// The conversation's usage snapshot for `open`; `None` if no usage yet.
    Usage {
        conv: ConversationId,
        reply: oneshot::Sender<Option<UsageState>>,
    },
    Ref {
        id: String,
        reply: oneshot::Sender<Option<(String, Vec<u8>)>>,
    },
    /// Table row counts, per-stream cursor positions, schema version and db
    /// size — the plain-JSON diagnostic surface so "what's actually in the
    /// db" doesn't require a manual sqlite3 session. Nothing here is part of
    /// any wire contract; it exists for a human looking, not a client
    /// deriving state.
    Stats { reply: oneshot::Sender<Value> },
    /// Empty title clears the name. Last write wins.
    SetTitle {
        conv: ConversationId,
        title: String,
        reply: oneshot::Sender<()>,
    },
    /// Empty value clears the key. Last write wins. First use of a key
    /// assigns it a colour from the palette.
    SetTag {
        conv: ConversationId,
        key: String,
        value: String,
        reply: oneshot::Sender<()>,
    },
    /// The outstanding snapshot: every unsettled ask (void is the client's
    /// derivation from `last_pulse`; a dead holder's ask is information).
    Approvals {
        reply: oneshot::Sender<Vec<ApprovalState>>,
    },
    /// The servicing snapshot: facts only, never verdicts.
    Agents {
        reply: oneshot::Sender<AgentsSnapshot>,
    },
    /// Ingest's reconcile, on every consumer build: "the stream I found was
    /// created at `created` and its sequences end at `last_seq` — where do I
    /// resume?" The reply is the cursor to resume after (0 = replay from the
    /// start).
    SyncStream {
        stream: String,
        created: String,
        last_seq: u64,
        reply: oneshot::Sender<u64>,
    },
    /// The current layout's tabs, JSON text verbatim; `None` before any
    /// client has ever set one.
    Layout {
        reply: oneshot::Sender<Option<String>>,
    },
    /// Replaces the whole layout — coarse, not per-action: tabs are few and
    /// small, so a full replace on every change is simpler than a dozen
    /// fine-grained ops (add_tab/rename_tab/...) and costs nothing extra.
    SetLayout {
        tabs: String,
        reply: oneshot::Sender<()>,
    },
    /// A human's own decision ("connection is authority") to stop tracking
    /// this ask — never a claim it was answered. Idempotent. `now` is the
    /// caller's clock (Views holds no `Clock`; ws.rs supplies it, same as
    /// every other timestamp here comes from the event that carried it).
    DismissApproval {
        id: ApprovalId,
        now: i64,
        reply: oneshot::Sender<()>,
    },
    /// Same standing, for an attached-but-message-less conversation whose
    /// holder has gone silent. Idempotent; a later re-attach un-hides it.
    DismissAttachment {
        world: WorldId,
        instance: InstanceId,
        conv: ConversationId,
        now: i64,
        reply: oneshot::Sender<()>,
    },
}

/// What sessions hold: the read channel plus the event fan-out.
#[derive(Clone)]
pub struct ViewsHandle {
    pub queries: tokio::sync::mpsc::Sender<ViewQuery>,
    pub events: tokio::sync::broadcast::Sender<ViewEvent>,
}
