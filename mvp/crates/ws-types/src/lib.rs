//! The browser boundary contract: `ClientMsg` / `ServerMsg` and their payload
//! shapes, normative in docs/mvp/tower-ws-spec.md (serde mirrors the zod).
//!
//! One definition, both sides. towerd (producer) serialises `ServerMsg` and
//! deserialises `ClientMsg`; the Rust-WASM frontend (consumer) does the mirror.
//! So every type derives `Serialize + Deserialize` — this is the piece that
//! makes the WS contract impossible to drift (was duplicated in towerd's ws.rs
//! and hand-mirrored in the Svelte types.ts).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMsg {
    #[serde(rename = "open")]
    Open {
        id: String,
        conv: String,
        after: Option<i64>,
    },
    #[serde(rename = "close")]
    Close { id: String, conv: String },
    #[serde(rename = "say")]
    Say {
        id: String,
        conv: String,
        text: String,
        tip: Option<String>,
        /// Reference blocks from POST /attachment, forwarded verbatim.
        #[serde(default)]
        attachments: Vec<Value>,
    },
    #[serde(rename = "cancel")]
    Cancel {
        id: String,
        conv: String,
        query: String,
    },
    #[serde(rename = "set_title")]
    SetTitle {
        id: String,
        conv: String,
        title: String,
    },
    #[serde(rename = "set_tag")]
    SetTag {
        id: String,
        conv: String,
        key: String,
        value: String,
    },
    #[serde(rename = "answer")]
    Answer {
        id: String,
        approval: String,
        approved: bool,
    },
    /// Replaces the whole layout — the fleet's shared tabs (docs/mvp/
    /// frontend-architecture.md's `view` concern, since promoted off
    /// localStorage onto the wire: settled 12 Jul, "tower owns the
    /// management structure, clients only render it").
    #[serde(rename = "set_layout")]
    SetLayout { id: String, tabs: Vec<WsTab> },
    /// A human's own decision ("connection is authority") to stop tracking
    /// an ask — never a claim it was answered. The settlement stays whatever
    /// it was (usually none); `dismissed` rides on the next `approval` fact.
    #[serde(rename = "dismiss_approval")]
    DismissApproval { id: String, approval: String },
    /// Same standing, for an attached-but-message-less conversation whose
    /// holder has gone silent. Not a claim the agent detached — that fact
    /// stays the agent's alone to publish.
    #[serde(rename = "dismiss_attachment")]
    DismissAttachment {
        id: String,
        world: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        conv: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMsg {
    #[serde(rename = "list")]
    List {
        rows: Vec<WsRow>,
        /// key → colour: the shared colour language, once per connection.
        #[serde(rename = "tagKeys", default, skip_serializing_if = "HashMap::is_empty")]
        tag_keys: HashMap<String, String>,
    },
    #[serde(rename = "row")]
    Row {
        conv: String,
        #[serde(rename = "lastEvent")]
        last_event: i64,
        #[serde(rename = "lastKind")]
        last_kind: String,
    },
    #[serde(rename = "conversation")]
    Conversation {
        id: String,
        conv: String,
        messages: Vec<WsMessage>,
    },
    #[serde(rename = "closed")]
    Closed { id: String, conv: String },
    #[serde(rename = "title_set")]
    TitleSet { id: String, conv: String },
    #[serde(rename = "tag_set")]
    TagSet { id: String, conv: String },
    #[serde(rename = "approvals")]
    Approvals { approvals: Vec<WsApproval> },
    #[serde(rename = "approval")]
    Approval(WsApproval),
    #[serde(rename = "agents")]
    Agents {
        instances: Vec<WsAgentInstance>,
        attachments: Vec<WsAgentAttachment>,
    },
    #[serde(rename = "agent")]
    Agent(WsAgent),
    #[serde(rename = "answer_result")]
    AnswerResult {
        id: String,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "say_result")]
    SayResult {
        id: String,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        query: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "cancel_result")]
    CancelResult {
        id: String,
        outcome: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "query")]
    Query {
        conv: String,
        #[serde(rename = "queryId")]
        query_id: String,
        reason: String,
    },
    #[serde(rename = "message")]
    Message { conv: String, message: WsMessage },
    #[serde(rename = "streaming")]
    Streaming { conv: String, text: String },
    #[serde(rename = "stream_block")]
    StreamBlock {
        conv: String,
        #[serde(rename = "blockType")]
        block_type: String,
    },
    #[serde(rename = "usage")]
    Usage(WsUsage),
    /// The fleet's layout, once at connect (after `agents`) and again
    /// whenever any client changes it — every connected session sees the
    /// same shared workspace live, the tmux-attach model.
    #[serde(rename = "layout")]
    Layout { tabs: Vec<WsTab> },
    #[serde(rename = "layout_set")]
    LayoutSet { id: String },
    /// An attachment a human dismissed — broadcast to every connected
    /// session, like `row`/`approval`. Not an agent fact: a real `detached`
    /// still arrives separately, from the agent, if it ever does.
    #[serde(rename = "attachment_dismissed")]
    AttachmentDismissed {
        world: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        conv: String,
    },
    #[serde(rename = "error")]
    Error { id: String, reason: String },
}

/// One tab: a name and its open set. mvp/frontend's `Tab` also carries a
/// `ViewConfig` (filters/grouping) — not on the wire yet, out of scope for
/// this pass (docs/mvp/frontend-leptos-plan.md's scope note applies here too).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsTab {
    pub name: String,
    pub convs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsRow {
    pub conv: String,
    #[serde(rename = "lastEvent")]
    pub last_event: i64,
    #[serde(rename = "lastKind")]
    pub last_kind: String,
    /// Present only for named conversations; absent = untitled, show the id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Flat key:value annotations, verbatim; absent when untagged.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub tags: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsApproval {
    pub id: String,
    /// Verbatim from the wire; `ask.type` is an open set.
    pub ask: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation: Option<Value>,
    #[serde(rename = "raisedTs")]
    pub raised_ts: i64,
    #[serde(rename = "lastPulse")]
    pub last_pulse: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settled: Option<WsSettled>,
    /// A human's own decision to stop tracking this ask (tower's annotation,
    /// never a claim it was answered). Excluded from the outstanding
    /// snapshot once true, same as `settled`.
    #[serde(default)]
    pub dismissed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsSettled {
    pub approved: bool,
    pub by: Value,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsAgentInstance {
    pub world: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(rename = "lastPulse")]
    pub last_pulse: i64,
    /// Absent until the instance's first pulse declares its promise.
    #[serde(rename = "intervalS", default, skip_serializing_if = "Option::is_none")]
    pub interval_s: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsAgentAttachment {
    pub world: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub conv: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "attachedTs")]
    pub attached_ts: i64,
}

/// One wire fact, one packet — flat, `kind` an open set to the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsAgent {
    pub kind: String,
    pub world: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub ts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "intervalS", default, skip_serializing_if = "Option::is_none")]
    pub interval_s: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsMessage {
    pub id: String,
    pub query: String,
    pub turn: String,
    pub role: String,
    /// Absent for a tool_result — it carries no sender (conversation-spec:
    /// a mechanical delivery is not an utterance).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from: Option<Value>,
    pub content: Vec<Value>,
    pub ts: i64,
}

/// The conversation's usage snapshot — facts only; the client prices the
/// dollar and the context percentage. Token totals are cumulative; `model`
/// and `contextTokens` are the latest turn's.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsUsage {
    pub conv: String,
    pub model: String,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    #[serde(rename = "cacheCreationTokens")]
    pub cache_creation_tokens: i64,
    #[serde(rename = "cacheCreation5mTokens")]
    pub cache_creation_5m_tokens: i64,
    #[serde(rename = "cacheCreation1hTokens")]
    pub cache_creation_1h_tokens: i64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: i64,
    pub turns: i64,
    #[serde(rename = "contextTokens")]
    pub context_tokens: i64,
}
