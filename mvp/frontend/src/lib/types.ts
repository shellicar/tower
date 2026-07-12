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
}

// towerd → client
export type ServerMsg =
  | { type: 'list'; rows: RowState[] }
  | { type: 'row'; conv: string; lastEvent: Millis; lastKind: string }
  | { type: 'conversation'; id: string; conv: string; messages: ConversationMessage[] }
  | { type: 'closed'; id: string; conv: string }
  | { type: 'say_result'; id: string; outcome: 'accepted'; query: string }
  | { type: 'say_result'; id: string; outcome: 'rejected'; reason: string }
  | { type: 'say_result'; id: string; outcome: 'unreachable' }
  | { type: 'message'; conv: string; message: ConversationMessage }
  | { type: 'streaming'; conv: string; text: string }
  | { type: 'error'; id: string; reason: string };

// client → towerd
export type ClientMsg =
  | { type: 'open'; id: string; conv: string; after: Millis | null }
  | { type: 'close'; id: string; conv: string }
  | { type: 'say'; id: string; conv: string; text: string; tip: string | null };

export function isRef(value: unknown): value is Ref {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Ref).$ref === 'string'
  );
}
