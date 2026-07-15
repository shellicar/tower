// concerns/conversation.svelte.ts — the open conversations' owned store
// (docs/mvp/frontend-architecture.md). It owns a map of open conversations and
// their content, folds its OWN slices of the wire (its convs' messages,
// streaming, query closures, and header facts), and drives say/cancel as
// id-correlated requests through the transport. The view concern decides WHICH
// conversations are open (tabs) and calls setOpen; this concern owns their
// content, never tabs.
//
// Every fold is an immutable REPLACEMENT — new map, new state object — because
// a keyed render never re-reads a mutated plain object, and (the incident this
// architecture answers) a $state write mutated across an await can freeze the
// flush. Assign, never mutate in place; the #update helper enforces it.

import type { Transport } from '../core/transport';
import type { AttachmentRef, ConversationMessage, Millis, ServerMsg } from '../types';

/** One stretch of the in-flight stream: the marker said what it is, the chunks
 *  accumulate into it. blockType is an open set — styled, never branched on. */
export interface StreamSegment {
  blockType: string;
  text: string;
}

/** The client's KNOWLEDGE of a conversation's query state — unknown is a real
 *  state: this concern folds no server query state, it learns from its own
 *  connection's evidence, and a fresh connect knows nothing. */
export type QueryState = 'unknown' | 'idle' | 'live';

export interface ConversationState {
  conv: string;
  /** ts-ordered, deduped by message id. */
  messages: ConversationMessage[];
  /** The in-flight stream as typed segments; cleared when the committed
   *  message lands. */
  streaming: StreamSegment[];
  loaded: boolean;
  queryState: QueryState;
  /** The query THIS client started, while live — what cancel targets. */
  liveQuery: string | null;
  /** The say in flight: accepted but not committed — greyed, superseded by its
   *  committed message, returned to the editor if the query closes first. */
  pendingSay: string | null;
  pendingAttachments: AttachmentRef[];
  /** A revoked say handed back to the editor; the panel consumes it. */
  restoreSay: string | null;
  restoreAttachments: AttachmentRef[];
  /** Outcome of the last say, shown until the next. */
  lastSay: string | null;
  // Header facts, this concern's own slice of the row stream (title reflects
  // on the next `list`, matching the wire's "refresh is the propagation" for
  // annotations; a shared annotations store is the cheap consolidation if a
  // live in-client rename is ever wanted).
  title: string | undefined;
  lastKind: string | null;
  lastEvent: Millis | null;
}

const fresh = (conv: string): ConversationState => ({
  conv,
  messages: [],
  streaming: [],
  loaded: false,
  queryState: 'unknown',
  liveQuery: null,
  pendingSay: null,
  pendingAttachments: [],
  restoreSay: null,
  restoreAttachments: [],
  lastSay: null,
  title: undefined,
  lastKind: null,
  lastEvent: null,
});

/** Insert in ts order, dedupe by id (boundary overlap is expected). Same id =
 *  replace (revisions keep the id; last write wins). Returns a NEW array. */
function insertMessage(
  messages: ConversationMessage[],
  m: ConversationMessage,
): ConversationMessage[] {
  const existing = messages.findIndex((x) => x.id === m.id);
  if (existing >= 0) {
    const copy = [...messages];
    copy[existing] = m;
    return copy;
  }
  let i = messages.length;
  while (i > 0 && messages[i - 1].ts > m.ts) i--;
  return [...messages.slice(0, i), m, ...messages.slice(i)];
}

export class Conversations {
  #open = $state<Map<string, ConversationState>>(new Map());
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
    transport.subscribe((event) => this.#fold(event));
    // Reconnect keeps what was being read: re-open every conversation with its
    // high-water mark so history travels once (ws-spec). Query state resets to
    // unknown — a fresh connection has no evidence.
    transport.onConnect(() => {
      for (const conv of [...this.#open.keys()]) {
        const oc = this.#open.get(conv)!;
        const after = oc.messages.length > 0 ? oc.messages[oc.messages.length - 1].ts : null;
        this.#update(conv, (o) => ({ ...o, loaded: false, queryState: 'unknown', liveQuery: null }));
        this.#transport.send({ type: 'open', id: this.#transport.id(), conv, after });
      }
    });
  }

  /** The state a panel renders, or undefined if not open. */
  get(conv: string): ConversationState | undefined {
    return this.#open.get(conv);
  }

  // ---- open-set, driven by the view concern (which owns tabs) ----

  open(conv: string): void {
    if (this.#open.has(conv)) return;
    const next = new Map(this.#open);
    next.set(conv, fresh(conv));
    this.#open = next;
    this.#transport.send({ type: 'open', id: this.#transport.id(), conv, after: null });
  }

  close(conv: string): void {
    if (!this.#open.has(conv)) return;
    const next = new Map(this.#open);
    next.delete(conv);
    this.#open = next;
    this.#transport.send({ type: 'close', id: this.#transport.id(), conv });
  }

  /** Match the open set to the active tab's conversations — close what's gone,
   *  open what's new. Only the active tab stays open; background tabs are cold. */
  setOpen(convs: string[]): void {
    for (const conv of [...this.#open.keys()]) if (!convs.includes(conv)) this.close(conv);
    for (const conv of convs) this.open(conv);
  }

  // ---- speaking: id-correlated requests; optimism reconciled by the wire ----

  async say(conv: string, text: string, attachments: AttachmentRef[] = []): Promise<void> {
    const oc = this.#open.get(conv);
    if (!oc) return;
    // The premise is the sender's view of the tip; null claims empty.
    const tip = oc.messages.length > 0 ? oc.messages[oc.messages.length - 1].id : null;
    // Optimistic: greyed pending say, assigned before the await.
    this.#update(conv, (o) => ({ ...o, lastSay: null, pendingSay: text, pendingAttachments: attachments }));
    const id = this.#transport.id();
    const res = await this.#transport.request({
      type: 'say',
      id,
      conv,
      text,
      tip,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (res.type !== 'say_result') return;
    if (res.outcome === 'accepted') {
      this.#update(conv, (o) => ({ ...o, lastSay: null, liveQuery: res.query, queryState: 'live' }));
    } else {
      const note =
        res.outcome === 'rejected'
          ? `rejected: ${res.reason}`
          : 'unreachable — nothing is serving this conversation';
      this.#update(conv, (o) => this.#restorePending({ ...o, lastSay: note }));
    }
  }

  async cancel(conv: string): Promise<void> {
    const oc = this.#open.get(conv);
    if (!oc?.liveQuery) return;
    const id = this.#transport.id();
    const res = await this.#transport.request({ type: 'cancel', id, conv, query: oc.liveQuery });
    if (res.type !== 'cancel_result') return;
    if (res.outcome === 'rejected') {
      this.#update(conv, (o) => ({ ...o, lastSay: `cancel rejected: ${res.reason}` }));
    } else if (res.outcome === 'unreachable') {
      // No closure will ever arrive, so free the input: words home, state unknown.
      this.#update(conv, (o) =>
        this.#restorePending({
          ...o,
          lastSay: 'cancel unreachable — nothing is serving this conversation',
          liveQuery: null,
          queryState: 'unknown',
        }),
      );
    }
  }

  /** The panel consumed the revoked say and its attachments. */
  consumeRestore(conv: string): void {
    this.#update(conv, (o) => ({ ...o, restoreSay: null, restoreAttachments: [] }));
  }

  #fold(event: ServerMsg): void {
    switch (event.type) {
      case 'list':
        for (const r of event.rows) {
          if (this.#open.has(r.conv)) {
            this.#update(r.conv, (o) => ({
              ...o,
              title: r.title,
              lastKind: r.lastKind,
              lastEvent: r.lastEvent,
            }));
          }
        }
        break;
      case 'row':
        if (this.#open.has(event.conv)) {
          this.#update(event.conv, (o) => ({
            ...o,
            lastKind: event.lastKind,
            lastEvent: event.lastEvent,
          }));
        }
        break;
      case 'conversation':
        if (this.#open.has(event.conv)) {
          this.#update(event.conv, (o) => {
            let messages = o.messages;
            for (const m of event.messages) messages = insertMessage(messages, m);
            return { ...o, messages, loaded: true };
          });
        }
        break;
      case 'message':
        if (this.#open.has(event.conv)) {
          this.#update(event.conv, (o) => {
            const next: ConversationState = {
              ...o,
              messages: insertMessage(o.messages, event.message),
              streaming: [], // a committed message supersedes the stream
            };
            // The committed say supersedes the pending one, files included.
            if (
              o.pendingSay !== null &&
              event.message.role === 'user' &&
              event.message.query === o.liveQuery
            ) {
              next.pendingSay = null;
              next.pendingAttachments = [];
            }
            return next;
          });
        }
        break;
      case 'streaming':
        if (this.#open.has(event.conv)) {
          this.#update(event.conv, (o) => {
            // Streaming is evidence a query is live (maybe not ours). Append to
            // the current segment immutably — new array, new segment.
            const last = o.streaming[o.streaming.length - 1];
            const streaming = last
              ? [...o.streaming.slice(0, -1), { ...last, text: last.text + event.text }]
              : [{ blockType: 'text', text: event.text }];
            return { ...o, queryState: 'live', streaming };
          });
        }
        break;
      case 'stream_block':
        if (this.#open.has(event.conv)) {
          this.#update(event.conv, (o) => ({
            ...o,
            streaming: [...o.streaming, { blockType: event.blockType, text: '' }],
          }));
        }
        break;
      case 'query':
        if (this.#open.has(event.conv)) {
          this.#update(event.conv, (o) => {
            let next: ConversationState = { ...o, queryState: 'idle', streaming: [] };
            if (o.liveQuery === event.queryId) next.liveQuery = null;
            // A non-completion closure is feedback the reader needs.
            if (event.reason !== 'completed') next.lastSay = `query ${event.reason}`;
            next = this.#restorePending(next);
            return next;
          });
        }
        break;
      default:
        break; // not this concern's
    }
  }

  /** The pending say comes home: words to the editor, files to the chips. One
   *  path for every failure shape — rejection, unreachable, revoked closure.
   *  Returns a NEW state; never mutates. */
  #restorePending(oc: ConversationState): ConversationState {
    return {
      ...oc,
      restoreSay: oc.pendingSay ?? oc.restoreSay,
      pendingSay: null,
      restoreAttachments:
        oc.pendingAttachments.length > 0
          ? [...oc.restoreAttachments, ...oc.pendingAttachments]
          : oc.restoreAttachments,
      pendingAttachments: [],
    };
  }

  /** Immutable single-conversation update: new map, new state object. The one
   *  door through which this concern's state changes, so the discipline lives
   *  in one place instead of every fold. */
  #update(conv: string, patch: (oc: ConversationState) => ConversationState): void {
    const oc = this.#open.get(conv);
    if (!oc) return;
    const next = new Map(this.#open);
    next.set(conv, patch(oc));
    this.#open = next;
  }
}
