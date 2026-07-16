//! The browser boundary: ClientMsg/ServerMsg per docs/mvp/tower-ws-spec.md,
//! and the per-socket session loop. One task per socket; a dropped socket
//! ends everything, reconnect = fresh session.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

use wire::{
    AnswerOutcome, ApprovalId, CancelOutcome, ConversationId, QueryId, SayCommand, SayOutcome,
};

use crate::broker::{Broker, Clock};
use crate::gateway;
use crate::views::{
    AgentAttachmentState, AgentFact, AgentInstanceState, ApprovalState, ConversationMessage,
    RowState, UsageState, ViewEvent, ViewQuery, ViewsHandle,
};

// ---------------------------------------------------------------------------
// The contract (normative in tower-ws-spec.md; serde mirrors the zod)

#[derive(Debug, Deserialize)]
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
        attachments: Vec<serde_json::Value>,
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
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerMsg {
    #[serde(rename = "list")]
    List {
        rows: Vec<WsRow>,
        /// key → colour: the shared colour language, once per connection.
        #[serde(
            rename = "tagKeys",
            skip_serializing_if = "std::collections::HashMap::is_empty"
        )]
        tag_keys: std::collections::HashMap<String, String>,
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
        outcome: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "say_result")]
    SayResult {
        id: String,
        outcome: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        query: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "cancel_result")]
    CancelResult {
        id: String,
        outcome: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(rename = "error")]
    Error { id: String, reason: String },
}

#[derive(Debug, Serialize)]
pub struct WsRow {
    pub conv: String,
    #[serde(rename = "lastEvent")]
    pub last_event: i64,
    #[serde(rename = "lastKind")]
    pub last_kind: String,
    /// Present only for named conversations; absent = untitled, show the id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Flat key:value annotations, verbatim; absent when untagged.
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub tags: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct WsApproval {
    pub id: String,
    /// Verbatim from the wire; `ask.type` is an open set.
    pub ask: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation: Option<Value>,
    #[serde(rename = "raisedTs")]
    pub raised_ts: i64,
    #[serde(rename = "lastPulse")]
    pub last_pulse: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settled: Option<WsSettled>,
}

#[derive(Debug, Serialize)]
pub struct WsSettled {
    pub approved: bool,
    pub by: Value,
    pub ts: i64,
}

impl From<ApprovalState> for WsApproval {
    fn from(a: ApprovalState) -> Self {
        WsApproval {
            id: a.id.0,
            ask: a.ask,
            correlation: a.correlation,
            raised_ts: a.raised_ts,
            last_pulse: a.last_pulse,
            settled: a.settled.map(|s| WsSettled {
                approved: s.approved,
                by: s.by,
                ts: s.ts,
            }),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct WsAgentInstance {
    pub world: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(rename = "lastPulse")]
    pub last_pulse: i64,
    /// Absent until the instance's first pulse declares its promise.
    #[serde(rename = "intervalS", skip_serializing_if = "Option::is_none")]
    pub interval_s: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct WsAgentAttachment {
    pub world: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub conv: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "attachedTs")]
    pub attached_ts: i64,
}

/// One wire fact, one packet — flat, `kind` an open set to the client.
#[derive(Debug, Serialize)]
pub struct WsAgent {
    pub kind: &'static str,
    pub world: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub ts: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conv: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(rename = "intervalS", skip_serializing_if = "Option::is_none")]
    pub interval_s: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

impl From<AgentFact> for WsAgent {
    fn from(f: AgentFact) -> Self {
        let base = |kind, world: wire::WorldId, instance: wire::InstanceId, ts| WsAgent {
            kind,
            world: world.0,
            instance_id: instance.0,
            ts,
            conv: None,
            cwd: None,
            interval_s: None,
            host: None,
        };
        match f {
            AgentFact::Ready {
                world,
                instance,
                ts,
                host,
            } => WsAgent {
                host,
                ..base("ready", world, instance, ts)
            },
            AgentFact::Pulse {
                world,
                instance,
                ts,
                interval_s,
            } => WsAgent {
                interval_s: Some(interval_s),
                ..base("pulse", world, instance, ts)
            },
            AgentFact::Attached {
                world,
                instance,
                ts,
                conv,
                cwd,
            } => WsAgent {
                conv: Some(conv.0),
                cwd,
                ..base("attached", world, instance, ts)
            },
            AgentFact::Detached {
                world,
                instance,
                ts,
                conv,
            } => WsAgent {
                conv: Some(conv.0),
                ..base("detached", world, instance, ts)
            },
        }
    }
}

impl From<AgentInstanceState> for WsAgentInstance {
    fn from(i: AgentInstanceState) -> Self {
        WsAgentInstance {
            world: i.world.0,
            instance_id: i.instance.0,
            host: i.host,
            last_pulse: i.last_pulse,
            interval_s: i.interval_s,
        }
    }
}

impl From<AgentAttachmentState> for WsAgentAttachment {
    fn from(a: AgentAttachmentState) -> Self {
        WsAgentAttachment {
            world: a.world.0,
            instance_id: a.instance.0,
            conv: a.conv.0,
            cwd: a.cwd,
            attached_ts: a.attached_ts,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct WsMessage {
    pub id: String,
    pub query: String,
    pub turn: String,
    pub role: String,
    pub from: Value,
    pub content: Vec<Value>,
    pub ts: i64,
}

/// The conversation's usage snapshot — facts only; the client prices the
/// dollar and the context percentage. Token totals are cumulative; `model`
/// and `contextTokens` are the latest turn's.
#[derive(Debug, Serialize)]
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

impl From<UsageState> for WsUsage {
    fn from(u: UsageState) -> Self {
        WsUsage {
            conv: u.conv.0,
            model: u.model,
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_creation_tokens: u.cache_creation_tokens,
            cache_creation_5m_tokens: u.cache_creation_5m_tokens,
            cache_creation_1h_tokens: u.cache_creation_1h_tokens,
            cache_read_tokens: u.cache_read_tokens,
            turns: u.turns,
            context_tokens: u.context_tokens,
        }
    }
}

impl From<RowState> for WsRow {
    fn from(r: RowState) -> Self {
        WsRow {
            conv: r.conv.0,
            last_event: r.last_event,
            last_kind: r.last_kind,
            title: r.title,
            tags: r.tags.into_iter().collect(),
        }
    }
}

impl From<ConversationMessage> for WsMessage {
    fn from(m: ConversationMessage) -> Self {
        WsMessage {
            id: m.id.0,
            query: m.query.0,
            turn: m.turn.0,
            role: m.role,
            from: m.from,
            content: m.content,
            ts: m.ts,
        }
    }
}

// ---------------------------------------------------------------------------
// The session fold: (state, input) → outputs. Pure of I/O so it is testable
// without a socket; run_session below is the async shell that owns the pipes.

pub struct Session {
    /// A HashSet, not an Option: any number open at once (multi-open is the
    /// product — "why can't I have 10 conversations up?").
    watching: HashSet<ConversationId>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Session {
            watching: HashSet::new(),
        }
    }

    /// A view event → the frames this session forwards. `row` always
    /// (unconditional — staleness is the product); content only when open.
    pub fn on_view_event(&self, event: ViewEvent) -> Option<ServerMsg> {
        match event {
            ViewEvent::Row(r) => Some(ServerMsg::Row {
                conv: r.conv.0,
                last_event: r.last_event,
                last_kind: r.last_kind,
            }),
            ViewEvent::Message { conv, message } if self.watching.contains(&conv) => {
                Some(ServerMsg::Message {
                    conv: conv.0,
                    message: message.into(),
                })
            }
            ViewEvent::Streaming { conv, text } if self.watching.contains(&conv) => {
                Some(ServerMsg::Streaming { conv: conv.0, text })
            }
            ViewEvent::StreamBlock { conv, block_type } if self.watching.contains(&conv) => {
                Some(ServerMsg::StreamBlock {
                    conv: conv.0,
                    block_type,
                })
            }
            // Approvals are awareness, like rows: unconditional.
            ViewEvent::Approval(state) => Some(ServerMsg::Approval(state.into())),
            // Agent facts too: one wire fact, one packet, never gated.
            ViewEvent::Agent(fact) => Some(ServerMsg::Agent(fact.into())),
            ViewEvent::QueryClosed {
                conv,
                query,
                reason,
            } if self.watching.contains(&conv) => Some(ServerMsg::Query {
                conv: conv.0,
                query_id: query.0,
                reason,
            }),
            // Usage is folded content, gated by open like `Message`.
            ViewEvent::Usage(state) if self.watching.contains(&state.conv) => {
                Some(ServerMsg::Usage(state.into()))
            }
            _ => None,
        }
    }

    pub fn open(&mut self, conv: &str) {
        self.watching.insert(ConversationId(conv.to_string()));
    }

    /// Closing something not open is not an error; the response is the same.
    pub fn close(&mut self, conv: &str) {
        self.watching.remove(&ConversationId(conv.to_string()));
    }
}

/// One client request → one response frame. Unknown/malformed requests are
/// still answered: `error` with reason `unsupported`/`malformed` — compliance
/// is answering, here as on the wire.
pub async fn handle_client_text<B: Broker, C: Clock>(
    session: &mut Session,
    views: &ViewsHandle,
    broker: &B,
    clock: &C,
    text: &str,
) -> Vec<ServerMsg> {
    let value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            return vec![ServerMsg::Error {
                id: request_id(text),
                reason: "malformed".into(),
            }];
        }
    };
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let msg: ClientMsg = match serde_json::from_value(value) {
        Ok(m) => m,
        Err(_) => {
            return vec![ServerMsg::Error {
                id,
                reason: "unsupported".into(),
            }];
        }
    };

    match msg {
        ClientMsg::Open { id, conv, after } => {
            session.open(&conv);
            let (tx, rx) = oneshot::channel();
            let query = ViewQuery::Conversation {
                conv: ConversationId(conv.clone()),
                after,
                reply: tx,
            };
            if views.queries.send(query).await.is_err() {
                return vec![ServerMsg::Error {
                    id,
                    reason: "views unavailable".into(),
                }];
            }
            let messages = match rx.await {
                Ok(messages) => messages,
                Err(_) => {
                    return vec![ServerMsg::Error {
                        id,
                        reason: "views unavailable".into(),
                    }];
                }
            };
            // The catch-up first, then the usage snapshot (absent until the
            // first turn). Both are open-gated content and open just began,
            // so both belong to this reply.
            let mut frames = vec![ServerMsg::Conversation {
                id,
                conv: conv.clone(),
                messages: messages.into_iter().map(Into::into).collect(),
            }];
            let (tx, rx) = oneshot::channel();
            if views
                .queries
                .send(ViewQuery::Usage {
                    conv: ConversationId(conv),
                    reply: tx,
                })
                .await
                .is_ok()
                && let Ok(Some(state)) = rx.await
            {
                frames.push(ServerMsg::Usage(state.into()));
            }
            frames
        }
        ClientMsg::Close { id, conv } => {
            session.close(&conv);
            vec![ServerMsg::Closed { id, conv }]
        }
        ClientMsg::Cancel { id, conv, query } => {
            vec![
                match gateway::cancel(broker, clock, &ConversationId(conv), &QueryId(query)).await {
                    CancelOutcome::Accepted => ServerMsg::CancelResult {
                        id,
                        outcome: "accepted",
                        reason: None,
                    },
                    CancelOutcome::Rejected { reason } => ServerMsg::CancelResult {
                        id,
                        outcome: "rejected",
                        reason: Some(reason),
                    },
                    CancelOutcome::Unreachable => ServerMsg::CancelResult {
                        id,
                        outcome: "unreachable",
                        reason: None,
                    },
                },
            ]
        }
        ClientMsg::Answer {
            id,
            approval,
            approved,
        } => vec![
            match gateway::answer(broker, clock, &ApprovalId(approval), approved).await {
                AnswerOutcome::Accepted => ServerMsg::AnswerResult {
                    id,
                    outcome: "accepted",
                    reason: None,
                },
                AnswerOutcome::Rejected { reason } => ServerMsg::AnswerResult {
                    id,
                    outcome: "rejected",
                    reason: Some(reason),
                },
                AnswerOutcome::Unreachable => ServerMsg::AnswerResult {
                    id,
                    outcome: "unreachable",
                    reason: None,
                },
            },
        ],
        ClientMsg::SetTag {
            id,
            conv,
            key,
            value,
        } => {
            let (tx, rx) = oneshot::channel();
            let query = ViewQuery::SetTag {
                conv: ConversationId(conv.clone()),
                key,
                value,
                reply: tx,
            };
            if views.queries.send(query).await.is_err() || rx.await.is_err() {
                return vec![ServerMsg::Error {
                    id,
                    reason: "views unavailable".into(),
                }];
            }
            vec![ServerMsg::TagSet { id, conv }]
        }
        ClientMsg::SetTitle { id, conv, title } => {
            let (tx, rx) = oneshot::channel();
            let query = ViewQuery::SetTitle {
                conv: ConversationId(conv.clone()),
                title,
                reply: tx,
            };
            if views.queries.send(query).await.is_err() || rx.await.is_err() {
                return vec![ServerMsg::Error {
                    id,
                    reason: "views unavailable".into(),
                }];
            }
            vec![ServerMsg::TitleSet { id, conv }]
        }
        ClientMsg::Say {
            id,
            conv,
            text,
            tip,
            attachments,
        } => {
            let cmd = SayCommand {
                conv: ConversationId(conv),
                text,
                tip: tip.map(wire::MessageId),
                attachments,
            };
            vec![match gateway::say(broker, clock, cmd).await {
                SayOutcome::Accepted { query } => ServerMsg::SayResult {
                    id,
                    outcome: "accepted",
                    query: Some(query.0),
                    reason: None,
                },
                SayOutcome::Rejected { reason } => ServerMsg::SayResult {
                    id,
                    outcome: "rejected",
                    query: None,
                    reason: Some(reason),
                },
                SayOutcome::Unreachable => ServerMsg::SayResult {
                    id,
                    outcome: "unreachable",
                    query: None,
                    reason: None,
                },
            }]
        }
    }
}

/// Best effort at echoing an id out of unparseable text, so even a malformed
/// request gets an answer the client can match.
fn request_id(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// The socket loop. Subscribe before snapshot (duplicate-apply is harmless;
/// a missed event is not), then `list` once, then events and requests
/// interleave until the socket drops.
pub async fn run_session<B: Broker, C: Clock>(
    socket: axum::extract::ws::WebSocket,
    views: ViewsHandle,
    broker: B,
    clock: C,
) {
    use axum::extract::ws::Message as WsFrame;
    use futures::StreamExt;

    let mut events = views.events.subscribe();

    let (mut sink, mut stream) = socket.split();
    let mut session = Session::new();

    // The list snapshot, once, unasked.
    let (tx, rx) = oneshot::channel();
    if views
        .queries
        .send(ViewQuery::List { reply: tx })
        .await
        .is_err()
    {
        return;
    }
    let Ok((rows, tag_keys)) = rx.await else {
        return;
    };
    let list = ServerMsg::List {
        rows: rows.into_iter().map(Into::into).collect(),
        tag_keys: tag_keys.into_iter().collect(),
    };
    if send(&mut sink, &list).await.is_err() {
        return;
    }

    // The outstanding approvals snapshot, once, right after `list`.
    let (tx, rx) = oneshot::channel();
    if views
        .queries
        .send(ViewQuery::Approvals { reply: tx })
        .await
        .is_err()
    {
        return;
    }
    let Ok(approvals) = rx.await else { return };
    let snapshot = ServerMsg::Approvals {
        approvals: approvals.into_iter().map(Into::into).collect(),
    };
    if send(&mut sink, &snapshot).await.is_err() {
        return;
    }

    // The servicing snapshot, once, right after `approvals`. Facts only;
    // the verdict (alive/released/stranded) is the client's derivation.
    let (tx, rx) = oneshot::channel();
    if views
        .queries
        .send(ViewQuery::Agents { reply: tx })
        .await
        .is_err()
    {
        return;
    }
    let Ok((instances, attachments)) = rx.await else {
        return;
    };
    let snapshot = ServerMsg::Agents {
        instances: instances.into_iter().map(Into::into).collect(),
        attachments: attachments.into_iter().map(Into::into).collect(),
    };
    if send(&mut sink, &snapshot).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if let Some(frame) = session.on_view_event(event)
                            && send(&mut sink, &frame).await.is_err()
                        {
                            return;
                        }
                    }
                    // Lagged: this session missed row events. The honest
                    // recovery is the client's own (reconnect = fresh list);
                    // dropping the socket triggers exactly that.
                    Err(broadcast::error::RecvError::Lagged(_)) => return,
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
            frame = stream.next() => {
                match frame {
                    Some(Ok(WsFrame::Text(text))) => {
                        let responses =
                            handle_client_text(&mut session, &views, &broker, &clock, &text).await;
                        for response in &responses {
                            if send(&mut sink, response).await.is_err() {
                                return;
                            }
                        }
                    }
                    Some(Ok(WsFrame::Close(_))) | None => return,
                    Some(Ok(_)) => {} // ping/pong/binary: nothing to answer
                    Some(Err(_)) => return,
                }
            }
        }
    }
}

async fn send<S>(sink: &mut S, msg: &ServerMsg) -> Result<(), ()>
where
    S: futures::Sink<axum::extract::ws::Message> + Unpin,
{
    use futures::SinkExt;
    let text = serde_json::to_string(msg).map_err(|_| ())?;
    sink.send(axum::extract::ws::Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::{MessageId, QueryId, TurnId};

    fn message(conv: &str) -> ViewEvent {
        ViewEvent::Message {
            conv: ConversationId(conv.into()),
            message: ConversationMessage {
                id: MessageId("m1".into()),
                query: QueryId("q1".into()),
                turn: TurnId("t1".into()),
                role: "user".into(),
                from: serde_json::json!({ "kind": "human" }),
                content: vec![serde_json::json!({ "type": "text", "text": "hi" })],
                ts: 1,
            },
        }
    }

    #[test]
    fn rows_are_unconditional_content_is_gated() {
        let mut session = Session::new();
        let row = ViewEvent::Row(crate::views::RowChanged {
            conv: ConversationId("c1".into()),
            last_event: 1,
            last_kind: "message".into(),
        });

        // Nothing open: row forwards, content does not.
        assert!(session.on_view_event(row.clone()).is_some());
        assert!(session.on_view_event(message("c1")).is_none());

        // Open gates content only.
        session.open("c1");
        assert!(session.on_view_event(message("c1")).is_some());
        assert!(session.on_view_event(message("c2")).is_none());

        // Close affects reading, never awareness.
        session.close("c1");
        assert!(session.on_view_event(message("c1")).is_none());
        assert!(session.on_view_event(row).is_some());
    }

    #[test]
    fn server_frames_serialise_to_the_spec_shapes() {
        let frame = ServerMsg::SayResult {
            id: "r3".into(),
            outcome: "rejected",
            query: None,
            reason: Some("stale".into()),
        };
        let v: Value = serde_json::from_str(&serde_json::to_string(&frame).unwrap()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "say_result", "id": "r3", "outcome": "rejected", "reason": "stale"
            })
        );

        let frame = ServerMsg::Row {
            conv: "c1".into(),
            last_event: 5,
            last_kind: "delta".into(),
        };
        let v: Value = serde_json::from_str(&serde_json::to_string(&frame).unwrap()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "row", "conv": "c1", "lastEvent": 5, "lastKind": "delta"
            })
        );
    }

    #[test]
    fn usage_frame_serialises_to_the_spec_shape() {
        let frame = ServerMsg::Usage(WsUsage {
            conv: "c1".into(),
            model: "claude-sonnet-4-5".into(),
            input_tokens: 9700,
            output_tokens: 418700,
            cache_creation_tokens: 2_100_000,
            cache_creation_5m_tokens: 100_000,
            cache_creation_1h_tokens: 2_000_000,
            cache_read_tokens: 66_300_000,
            turns: 174,
            context_tokens: 740_500,
        });
        let v: Value = serde_json::from_str(&serde_json::to_string(&frame).unwrap()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "usage", "conv": "c1", "model": "claude-sonnet-4-5",
                "inputTokens": 9700, "outputTokens": 418700,
                "cacheCreationTokens": 2_100_000, "cacheCreation5mTokens": 100_000,
                "cacheCreation1hTokens": 2_000_000, "cacheReadTokens": 66_300_000,
                "turns": 174, "contextTokens": 740_500
            })
        );
    }

    #[test]
    fn client_open_parses_with_null_after() {
        let msg: ClientMsg =
            serde_json::from_str(r#"{"type":"open","id":"r1","conv":"c1","after":null}"#).unwrap();
        assert!(matches!(msg, ClientMsg::Open { after: None, .. }));
    }
}
