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

/** One stretch of the in-flight stream: the marker said what it is, the
 *  chunks accumulate into it. blockType is an open set — styled, never
 *  branched on beyond styling. */
export interface StreamSegment {
  blockType: string;
  text: string;
}

export interface OpenConversation {
  conv: string;
  /** ts-ordered, deduped by message id. */
  messages: ConversationMessage[];
  /** The in-flight stream as typed segments; cleared when the committed
   *  message lands. Chunks before any marker fold into a `text` segment. */
  streaming: StreamSegment[];
  /** Outcome of the last say, shown until the next one. */
  lastSay: string | null;
  loaded: boolean;
}

/** The rail's view configuration — per profile, like the open set. */
export interface ViewConfig {
  /** key -> selected values; OR within a key, AND across keys. */
  filters: Record<string, string[]>;
  /** Section the rail by this key; '' = flat. */
  groupKey: string;
  /** Keys whose values decorate rows (value only; colour carries the key). */
  alwaysShow: string[];
  /** When grouping, drop rows that lack the group key entirely. */
  hideUntagged: boolean;
}

/** A tab is a whole working view: its own view config AND its own open
 *  conversations — switch tabs, switch worlds. Per profile. */
export interface Tab {
  name: string;
  view: ViewConfig;
  convs: string[];
}

const defaultView = (): ViewConfig => ({
  filters: {},
  groupKey: '',
  alwaysShow: [],
  hideUntagged: false,
});

class Tower {
  rows = $state<Map<string, RowState>>(new Map());
  open = $state<Map<string, OpenConversation>>(new Map());
  approvals = $state<Map<string, ApprovalState>>(new Map());
  /** key → colour, from the list snapshot — the shared colour language. */
  tagKeys = $state<Record<string, string>>({});
  tabs = $state<Tab[]>(readTabs());
  active = $state<number>(readActiveTab());
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

  /** The active tab; tabs always number at least one. */
  get tab(): Tab {
    return this.tabs[Math.min(this.active, this.tabs.length - 1)];
  }

  /** The active tab's view config — what the rail reads and mutates. */
  get view(): ViewConfig {
    return this.tab.view;
  }

  addTab() {
    this.tabs.push({ name: `view ${this.tabs.length + 1}`, view: defaultView(), convs: [] });
    this.active = this.tabs.length - 1;
    this.saveView();
  }

  closeTab(i: number) {
    if (this.tabs.length <= 1) return;
    const removed = this.tabs[i];
    this.tabs.splice(i, 1);
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    // Conversations open in no remaining tab stop flowing.
    for (const conv of removed.convs) this.#dropIfOrphaned(conv);
    this.saveView();
  }

  renameTab(i: number, name: string) {
    if (name.trim()) this.tabs[i].name = name.trim();
    this.saveView();
  }

  switchTab(i: number) {
    this.active = i;
    this.saveView();
  }

  #dropIfOrphaned(conv: string) {
    if (this.tabs.some((t) => t.convs.includes(conv))) return;
    this.open.delete(conv);
    this.open = new Map(this.open);
    this.#send({ type: 'close', id: this.#id(), conv });
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
    // A refresh keeps what was being read: every tab's open set survives in
    // localStorage, and reconnect's own re-open path does the rest. Content
    // flows for all tabs' conversations — switching tabs is instant.
    if (!this.#restored) {
      this.#restored = true;
      for (const conv of new Set(this.tabs.flatMap((t) => t.convs))) {
        this.open.set(conv, {
          conv,
          messages: [],
          streaming: [],
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
    if (!this.tab.convs.includes(conv)) {
      this.tab.convs.push(conv);
      this.saveView();
    }
    if (!this.open.has(conv)) {
      this.open.set(conv, { conv, messages: [], streaming: [], lastSay: null, loaded: false });
      this.open = new Map(this.open);
    }
    this.#send({ type: 'open', id: this.#id(), conv, after: null });
  }

  closeConversation(conv: string) {
    this.tab.convs = this.tab.convs.filter((c) => c !== conv);
    this.saveView();
    this.#dropIfOrphaned(conv);
  }

  /** Tags follow the titles discipline: the tagging client updates its own
   *  row; everyone else sees it on next connect. Empty value clears the key. */
  setTag(conv: string, key: string, value: string) {
    this.#send({ type: 'set_tag', id: this.#id(), conv, key, value });
    const row = this.rows.get(conv);
    if (row) {
      const tags = { ...(row.tags ?? {}) };
      if (value === '') delete tags[key];
      else tags[key] = value;
      row.tags = tags;
      this.rows = new Map(this.rows);
    }
    // A brand-new key gets its real colour on next connect; a placeholder
    // keeps it renderable meanwhile.
    if (value !== '' && !this.tagKeys[key]) {
      this.tagKeys = { ...this.tagKeys, [key]: '#888888' };
    }
  }

  saveView() {
    try {
      localStorage.setItem('tower.tabs', JSON.stringify(this.tabs));
      localStorage.setItem('tower.activeTab', String(this.active));
    } catch {
      // Storage full or blocked: persistence degrades, viewing does not.
    }
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
        if (msg.tagKeys) this.tagKeys = msg.tagKeys;
        break;
      }
      case 'row': {
        // Upsert by conv: an unknown conv IS a new conversation being born.
        // `row` never carries annotations; the ones we hold survive the upsert.
        const held = this.rows.get(msg.conv);
        this.rows.set(msg.conv, {
          conv: msg.conv,
          lastEvent: msg.lastEvent,
          lastKind: msg.lastKind,
          title: held?.title,
          tags: held?.tags,
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
        oc.streaming = [];
        this.open = new Map(this.open);
        break;
      }
      case 'streaming': {
        const oc = this.open.get(msg.conv);
        if (!oc) break;
        // Append to the current segment; chunks arriving before any marker
        // are text — the mid-turn join renders honestly until corrected.
        const last = oc.streaming[oc.streaming.length - 1];
        if (last) last.text += msg.text;
        else oc.streaming.push({ blockType: 'text', text: msg.text });
        this.open = new Map(this.open);
        break;
      }
      case 'stream_block': {
        const oc = this.open.get(msg.conv);
        if (!oc) break;
        // The stream changed character: open a new segment.
        oc.streaming.push({ blockType: msg.blockType, text: '' });
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
      case 'tag_set':
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

/** Tabs from storage, migrating the pre-tab keys (tower.view, tower.open)
 *  into tab one so nothing is lost on upgrade. Always at least one tab. */
function readTabs(): Tab[] {
  try {
    const parsed = JSON.parse(localStorage.getItem('tower.tabs') ?? 'null');
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((t) => ({
        name: typeof t.name === 'string' ? t.name : 'view',
        view: {
          filters: t.view?.filters ?? {},
          groupKey: t.view?.groupKey ?? '',
          alwaysShow: t.view?.alwaysShow ?? [],
          hideUntagged: t.view?.hideUntagged ?? false,
        },
        convs: Array.isArray(t.convs) ? t.convs.filter((c: unknown) => typeof c === 'string') : [],
      }));
    }
  } catch {
    // fall through to migration
  }
  // Migration: the single pre-tab view + open set become tab one.
  let view = defaultView();
  let convs: string[] = [];
  try {
    const v = JSON.parse(localStorage.getItem('tower.view') ?? 'null');
    if (v) {
      view = {
        filters: v.filters ?? {},
        groupKey: v.groupKey ?? '',
        alwaysShow: v.alwaysShow ?? [],
        hideUntagged: v.hideUntagged ?? false,
      };
    }
    const o = JSON.parse(localStorage.getItem('tower.open') ?? '[]');
    if (Array.isArray(o)) convs = o.filter((c) => typeof c === 'string');
  } catch {
    // defaults stand
  }
  return [{ name: 'main', view, convs }];
}

function readActiveTab(): number {
  const n = Number(localStorage.getItem('tower.activeTab') ?? '0');
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export const tower = new Tower();
