// The WS contract (docs/mvp/tower-ws-spec.md) as types. This file and the
// spec are the frontend's only coupling to towerd — never its code.

export type Millis = number;

/** Sender provenance, verbatim from the wire. `kind` is an open set. */
export interface Sender {
  kind: string;
  userId?: string;
  [extra: string]: unknown;
}

/** A `$ref` node — may appear at any position inside content. */
export interface Ref {
  $ref: string;
  size: number;
  hint: string;
}

/** Content blocks are opaque typed objects; render known types, skip unknown. */
export interface ContentBlock {
  type: string;
  [extra: string]: unknown;
}

export interface ConversationMessage {
  id: string;
  query: string;
  turn: string;
  role: string;
  from: Sender;
  content: ContentBlock[];
  ts: Millis;
}

export interface RowState {
  conv: string;
  lastEvent: Millis;
  lastKind: string;
  /** Tower's own annotation; absent = untitled, show the id. */
  title?: string;
  /** Flat key:value annotations, verbatim; absent when untagged. */
  tags?: Record<string, string>;
}

export interface ApprovalState {
  id: string;
  /** Verbatim from the wire; `ask.type` is an open set. */
  ask: { type: string; name?: string; input?: unknown; [extra: string]: unknown };
  correlation?: {
    conversationId?: string;
    queryId?: string;
    turnId?: string;
    toolUseId?: string;
  };
  raisedTs: Millis;
  lastPulse: Millis;
  settled?: { approved: boolean; by: Sender; ts: Millis };
}

export interface AgentInstance {
  world: string;
  instanceId: string;
  host?: string;
  lastPulse: Millis;
  /** The instance's own promise; absent until its first pulse. */
  intervalS?: number;
}

export interface AgentAttachment {
  world: string;
  instanceId: string;
  conv: string;
  cwd?: string;
  attachedTs: Millis;
}

/** One agent wire fact, flat; `kind` is an open set — unknown kinds skipped. */
export interface AgentEvent {
  kind: string;
  world: string;
  instanceId: string;
  ts: Millis;
  conv?: string;
  cwd?: string;
  intervalS?: number;
  host?: string;
}

// towerd → client
export type ServerMsg =
  | { type: 'list'; rows: RowState[]; tagKeys?: Record<string, string> }
  | { type: 'row'; conv: string; lastEvent: Millis; lastKind: string }
  | { type: 'conversation'; id: string; conv: string; messages: ConversationMessage[] }
  | { type: 'closed'; id: string; conv: string }
  | { type: 'title_set'; id: string; conv: string }
  | { type: 'tag_set'; id: string; conv: string }
  | { type: 'approvals'; approvals: ApprovalState[] }
  | ({ type: 'approval' } & ApprovalState)
  | { type: 'agents'; instances: AgentInstance[]; attachments: AgentAttachment[] }
  | ({ type: 'agent' } & AgentEvent)
  | { type: 'answer_result'; id: string; outcome: 'accepted' }
  | { type: 'answer_result'; id: string; outcome: 'rejected'; reason: string }
  | { type: 'answer_result'; id: string; outcome: 'unreachable' }
  | { type: 'say_result'; id: string; outcome: 'accepted'; query: string }
  | { type: 'say_result'; id: string; outcome: 'rejected'; reason: string }
  | { type: 'say_result'; id: string; outcome: 'unreachable' }
  | { type: 'message'; conv: string; message: ConversationMessage }
  | { type: 'streaming'; conv: string; text: string }
  | { type: 'stream_block'; conv: string; blockType: string }
  | { type: 'error'; id: string; reason: string };

// client → towerd
export type ClientMsg =
  | { type: 'open'; id: string; conv: string; after: Millis | null }
  | { type: 'close'; id: string; conv: string }
  | { type: 'say'; id: string; conv: string; text: string; tip: string | null }
  | { type: 'set_title'; id: string; conv: string; title: string }
  | { type: 'set_tag'; id: string; conv: string; key: string; value: string }
  | { type: 'answer'; id: string; approval: string; approved: boolean };

export function isRef(value: unknown): value is Ref {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Ref).$ref === 'string'
  );
}
