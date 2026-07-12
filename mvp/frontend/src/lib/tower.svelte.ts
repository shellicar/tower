// The tower store: one WebSocket, the protocol folded into $state
// (docs/mvp/tower-ws-spec.md). Rows are unconditional — staleness works with
// nothing open; open gates content only. Reconnect = fresh connection: new
// list, re-open what was being read with `after` so history travels once.

import type {
  ApprovalState,
  ClientMsg,
  ConversationMessage,
  Millis,
  RowState,
  ServerMsg,
} from './types';

export interface OpenConversation {
  conv: string;
  /** ts-ordered, deduped by message id. */
  messages: ConversationMessage[];
  /** The in-flight assistant text; cleared when its committed message lands. */
  streaming: string;
  /** Outcome of the last say, shown until the next one. */
  lastSay: string | null;
  loaded: boolean;
}

class Tower {
  rows = $state<Map<string, RowState>>(new Map());
  open = $state<Map<string, OpenConversation>>(new Map());
  approvals = $state<Map<string, ApprovalState>>(new Map());
  /** Whether the approvals view is showing — pure view state. */
  approvalsOpen = $state(false);
  /** Transient outcome of the last answer per approval id, for display. */
  answerNotes = $state<Map<string, string>>(new Map());
  connected = $state(false);

  #ws: WebSocket | null = null;
  #nextId = 1;
  #restored = false;
  /** requestId → conv, so say_result (which carries no conv) finds its home. */
  #pendingSays = new Map<string, string>();
  /** requestId → approval id, same routing for answer_result. */
  #pendingAnswers = new Map<string, string>();
  #retryMs = 500;

  /** Rows by lastEvent descending — the staleness order is the product. */
  get ordered(): RowState[] {
    return [...this.rows.values()].sort((a, b) => b.lastEvent - a.lastEvent);
  }

  /** Pending asks, oldest first — a waiting Claude burns wall-clock. */
  get pendingApprovals(): ApprovalState[] {
    return [...this.approvals.values()]
      .filter((a) => !a.settled)
      .sort((a, b) => a.raisedTs - b.raisedTs);
  }

  /** Conversations with a pending ask, for the rail's marker. */
  get pendingByConv(): Set<string> {
    const set = new Set<string>();
    for (const a of this.pendingApprovals) {
      if (a.correlation?.conversationId) set.add(a.correlation.conversationId);
    }
    return set;
  }

  connect() {
    // A refresh keeps what was being read: the open set survives in
    // localStorage, and reconnect's own re-open path does the rest.
    if (!this.#restored) {
      this.#restored = true;
      for (const conv of readOpenSet()) {
        this.open.set(conv, {
          conv,
          messages: [],
          streaming: '',
          lastSay: null,
          loaded: false,
        });
      }
      this.open = new Map(this.open);
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.#ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.#retryMs = 500;
      // Re-open everything that was being read, with the high-water mark.
      for (const [conv, oc] of this.open) {
        oc.loaded = false;
        this.#send({ type: 'open', id: this.#id(), conv, after: highWater(oc) });
      }
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return; // tolerance: unparseable frames are skipped, never fatal
      }
      this.#apply(msg);
    };
    ws.onclose = () => {
      this.connected = false;
      this.#ws = null;
      setTimeout(() => this.connect(), this.#retryMs);
      this.#retryMs = Math.min(this.#retryMs * 2, 10_000);
    };
  }

  openConversation(conv: string) {
    if (!this.open.has(conv)) {
      this.open.set(conv, { conv, messages: [], streaming: '', lastSay: null, loaded: false });
      this.open = new Map(this.open);
      writeOpenSet(this.open);
    }
    this.#send({ type: 'open', id: this.#id(), conv, after: null });
  }

  closeConversation(conv: string) {
    this.open.delete(conv);
    this.open = new Map(this.open);
    writeOpenSet(this.open);
    this.#send({ type: 'close', id: this.#id(), conv });
  }

  /** Titles don't propagate live — refresh is the propagation — so the
   *  renaming client updates its own row from its own action. An empty
   *  title clears the name. */
  setTitle(conv: string, title: string) {
    this.#send({ type: 'set_title', id: this.#id(), conv, title });
    const row = this.rows.get(conv);
    if (row) {
      if (title === '') delete row.title;
      else row.title = title;
      this.rows = new Map(this.rows);
    }
  }

  /** Answer a pending approval. First valid answer wins; losing the race
   *  comes back as `already_settled` and is shown, not treated as an error. */
  answer(approval: string, approved: boolean) {
    const id = this.#id();
    this.#pendingAnswers.set(id, approval);
    this.answerNotes.delete(approval);
    this.answerNotes = new Map(this.answerNotes);
    this.#send({ type: 'answer', id, approval, approved });
  }

  /** The tip is this client's view of the latest message id — the premise
   *  belongs to the sender; null claims the conversation is empty. */
  say(conv: string, text: string) {
    const oc = this.open.get(conv);
    if (!oc) return;
    const tip = oc.messages.length > 0 ? oc.messages[oc.messages.length - 1].id : null;
    const id = this.#id();
    this.#pendingSays.set(id, conv);
    oc.lastSay = null;
    this.#send({ type: 'say', id, conv, text, tip });
  }

  #apply(msg: ServerMsg) {
    switch (msg.type) {
      case 'list': {
        // The full snapshot replaces the map — sent once per connection.
        this.rows = new Map(msg.rows.map((r) => [r.conv, r]));
        break;
      }
      case 'row': {
        // Upsert by conv: an unknown conv IS a new conversation being born.
        // `row` never carries a title; the one we hold survives the upsert.
        this.rows.set(msg.conv, {
          conv: msg.conv,
          lastEvent: msg.lastEvent,
          lastKind: msg.lastKind,
          title: this.rows.get(msg.conv)?.title,
        });
        this.rows = new Map(this.rows);
        break;
      }
      case 'conversation': {
        const oc = this.open.get(msg.conv);
        if (!oc) break;
        for (const m of msg.messages) insertMessage(oc, m);
        oc.loaded = true;
        this.open = new Map(this.open);
        break;
      }
      case 'message': {
        const oc = this.open.get(msg.conv);
        if (!oc) break;
        insertMessage(oc, msg.message);
        // A committed message supersedes the streaming that preceded it.
        oc.streaming = '';
        this.open = new Map(this.open);
        break;
      }
      case 'streaming': {
        const oc = this.open.get(msg.conv);
        if (!oc) break;
        oc.streaming += msg.text;
        this.open = new Map(this.open);
        break;
      }
      case 'say_result': {
        const conv = this.#pendingSays.get(msg.id);
        this.#pendingSays.delete(msg.id);
        const oc = conv ? this.open.get(conv) : undefined;
        if (!oc) break;
        oc.lastSay =
          msg.outcome === 'accepted'
            ? null // the answer arrives on the content flow; nothing to show
            : msg.outcome === 'rejected'
              ? `rejected: ${msg.reason}` // shown, never branched on
              : 'unreachable — nothing is serving this conversation';
        this.open = new Map(this.open);
        break;
      }
      case 'approvals': {
        // The outstanding snapshot replaces the map — once per connection.
        this.approvals = new Map(msg.approvals.map((a) => [a.id, a]));
        break;
      }
      case 'approval': {
        // Upsert by id: an unknown id is a new ask being born.
        const { type: _type, ...state } = msg;
        this.approvals.set(state.id, state);
        this.approvals = new Map(this.approvals);
        break;
      }
      case 'answer_result': {
        const approval = this.#pendingAnswers.get(msg.id);
        this.#pendingAnswers.delete(msg.id);
        if (!approval) break;
        const note =
          msg.outcome === 'accepted'
            ? null // the settlement arrives as an approval event
            : msg.outcome === 'rejected'
              ? `rejected: ${msg.reason}` // shown, never branched on
              : 'unreachable — the holder is gone';
        if (note) {
          this.answerNotes.set(approval, note);
          this.answerNotes = new Map(this.answerNotes);
        }
        break;
      }
      case 'closed':
      case 'title_set':
      case 'error':
        break; // acknowledgements; errors surface nothing actionable in v1
      default:
        break; // tolerance: unknown types skipped without error
    }
  }

  #send(msg: ClientMsg) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  #id(): string {
    return `r${this.#nextId++}`;
  }
}

/** Insert in ts order, dedupe by id (boundary overlap is expected: a message
 *  may arrive both in the catch-up and live). Same id = replace (revisions
 *  keep the id; last write wins). */
function insertMessage(oc: OpenConversation, m: ConversationMessage) {
  const existing = oc.messages.findIndex((x) => x.id === m.id);
  if (existing >= 0) {
    oc.messages[existing] = m;
    return;
  }
  let i = oc.messages.length;
  while (i > 0 && oc.messages[i - 1].ts > m.ts) i--;
  oc.messages.splice(i, 0, m);
}

function highWater(oc: OpenConversation): Millis | null {
  return oc.messages.length > 0 ? oc.messages[oc.messages.length - 1].ts : null;
}

// The open set, in opening order. Local view state, not conversation state —
// exactly what a client's own storage is for.
const OPEN_KEY = 'tower.open';

function readOpenSet(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeOpenSet(open: Map<string, OpenConversation>) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open.keys()]));
  } catch {
    // Storage full or blocked: persistence degrades, reading does not.
  }
}

export const tower = new Tower();
