// The tower store: one WebSocket, the protocol folded into $state
// (docs/mvp/tower-ws-spec.md). Rows are unconditional — staleness works with
// nothing open; open gates content only. Reconnect = fresh connection: new
// list, re-open what was being read with `after` so history travels once.

import type {
  AgentAttachment,
  AgentInstance,
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

/** The client's KNOWLEDGE of a conversation's query state — and unknown is
 *  a real state, rendered as such: towerd stores no query state, so a fresh
 *  connect knows nothing until evidence arrives (a say_result, streaming
 *  activity, a `query` closure). The render is a courtesy; the premise
 *  check is the enforcement. */
export type QueryState = 'unknown' | 'idle' | 'live';

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
  /** What this client knows about query liveness. */
  queryState: QueryState;
  /** The query THIS client started, while live — what cancel targets. */
  liveQuery: string | null;
  /** The say in flight: accepted but not yet committed — rendered greyed,
   *  superseded by its committed message, returned to the editor if the
   *  query closes without committing it. */
  pendingSay: string | null;
  /** A revoked say handed back to the editor; the panel consumes it. */
  restoreSay: string | null;
}

const freshOpen = (conv: string): OpenConversation => ({
  conv,
  messages: [],
  streaming: [],
  lastSay: null,
  loaded: false,
  queryState: 'unknown',
  liveQuery: null,
  pendingSay: null,
  restoreSay: null,
});

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
  /** Instance liveness facts, keyed world/instanceId. Facts only — the
   *  verdict (alive/stranded) is derived where rendered, against the
   *  renderer's clock. */
  agentInstances = $state<Map<string, AgentInstance>>(new Map());
  /** Live attachments, keyed world/instanceId/conv — racing servicers are
   *  representable. `detached` removes; absence is released. */
  agentAttachments = $state<Map<string, AgentAttachment>>(new Map());
  /** key → colour, from the list snapshot — the shared colour language. */
  tagKeys = $state<Record<string, string>>({});
  tabs = $state<Tab[]>(readTabs());
  active = $state<number>(readActiveTab());
  /** Whether the approvals view is showing — pure view state. */
  approvalsOpen = $state(false);
  /** The store's clock, for time-derived states (approval void). Ticks
   *  coarsely; second-precision belongs to the components that display it. */
  now = $state(Date.now());
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
  #ticking = false;
  /** requestId → conv, same routing for cancel_result. */
  #pendingCancels = new Map<string, string>();
  #retryMs = 500;

  /** Rows by lastEvent descending — the staleness order is the product. */
  get ordered(): RowState[] {
    return [...this.rows.values()].sort((a, b) => b.lastEvent - a.lastEvent);
  }

  /** conv → its live attachments (usually one; racing servicers show all). */
  get attachmentsByConv(): Map<string, AgentAttachment[]> {
    const map = new Map<string, AgentAttachment[]>();
    for (const a of this.agentAttachments.values()) {
      const list = map.get(a.conv);
      if (list) list.push(a);
      else map.set(a.conv, [a]);
    }
    return map;
  }

  /** Existence is a union: conversations that are only an attachment —
   *  served, ready to receive, no messages yet. Potential conversations;
   *  they vanish when the attachment does. */
  get attachedOnly(): AgentAttachment[] {
    return [...this.attachmentsByConv.entries()]
      .filter(([conv]) => !this.rows.has(conv))
      .map(([, list]) => list[0]);
  }

  /** The freshest pulse serving this conv, with its promise — the facts a
   *  renderer judges against its own clock (~3×intervalS = stranded). */
  liveness(conv: string): { lastPulse: Millis; intervalS?: number } | null {
    let best: AgentInstance | null = null;
    for (const a of this.attachmentsByConv.get(conv) ?? []) {
      const inst = this.agentInstances.get(`${a.world}/${a.instanceId}`);
      if (inst && (!best || inst.lastPulse > best.lastPulse)) best = inst;
    }
    return best ? { lastPulse: best.lastPulse, intervalS: best.intervalS } : null;
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
    this.tabs.splice(i, 1);
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.#reconcileOpen();
    this.saveView();
  }

  renameTab(i: number, name: string) {
    if (name.trim()) this.tabs[i].name = name.trim();
    this.saveView();
  }

  switchTab(i: number) {
    this.active = i;
    this.#reconcileOpen();
    this.saveView();
  }

  /** Only the ACTIVE tab's conversations stay open — background tabs are
   *  cold. Warm tabs held every conversation's full content in memory and
   *  re-folded every streaming delta from all of them; with a fleet that
   *  streams constantly, that was CPU and RAM spent on invisible panels.
   *  Switching back re-fetches — half a second against a gigabyte. */
  #reconcileOpen() {
    for (const conv of [...this.open.keys()]) {
      if (!this.tab.convs.includes(conv)) {
        this.open.delete(conv);
        this.#send({ type: 'close', id: this.#id(), conv });
      }
    }
    for (const conv of this.tab.convs) {
      if (!this.open.has(conv)) {
        this.open.set(conv, freshOpen(conv));
        this.#send({ type: 'open', id: this.#id(), conv, after: null });
      }
    }
    this.open = new Map(this.open);
  }

  #dropIfOrphaned(conv: string) {
    if (this.tab.convs.includes(conv)) return;
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

  /** Void is this client's derivation: the pulse is ~15s while pending, so
   *  ~3 missed pulses reads as "the holder died". A void ask is evidence,
   *  not a demand — it leaves the actionable surfaces and waits, dimmed,
   *  to be dismissed. */
  isVoid(a: ApprovalState): boolean {
    return this.now - a.lastPulse > 45_000;
  }

  /** The asks actually waiting on a human: pending AND alive. */
  get liveApprovals(): ApprovalState[] {
    return this.pendingApprovals.filter((a) => !this.isVoid(a));
  }

  /** Drop an ask from this client's view — local, not an answer: nobody
   *  settles an abandoned ask. If its holder ever pulses again, the next
   *  approval event resurrects it, which is exactly right. */
  dismiss(approval: string) {
    this.approvals.delete(approval);
    this.approvals = new Map(this.approvals);
  }

  /** Conversations with a live pending ask, for the rail's marker. */
  get pendingByConv(): Set<string> {
    const set = new Set<string>();
    for (const a of this.liveApprovals) {
      if (a.correlation?.conversationId) set.add(a.correlation.conversationId);
    }
    return set;
  }

  connect() {
    // The derivation clock starts with the app, connection or not.
    if (!this.#ticking) {
      this.#ticking = true;
      setInterval(() => (this.now = Date.now()), 2_000);
    }
    // A refresh keeps what was being read: the tabs survive in localStorage,
    // and reconnect's re-open path does the rest — for the ACTIVE tab only;
    // background tabs are cold and re-fetch on switch.
    if (!this.#restored) {
      this.#restored = true;
      for (const conv of this.tab.convs) {
        this.open.set(conv, freshOpen(conv));
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
      // Query state resets to unknown: a fresh connection has no evidence.
      for (const [conv, oc] of this.open) {
        oc.loaded = false;
        oc.queryState = 'unknown';
        oc.liveQuery = null;
        this.#send({ type: 'open', id: this.#id(), conv, after: highWater(oc) });
      }
      this.open = new Map(this.open);
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
      this.open.set(conv, freshOpen(conv));
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
   *  belongs to the sender; null claims the conversation is empty. The text
   *  rides as the pending say — greyed until committed, returned to the
   *  editor if the query closes without committing it. */
  say(conv: string, text: string) {
    const oc = this.open.get(conv);
    if (!oc) return;
    const tip = oc.messages.length > 0 ? oc.messages[oc.messages.length - 1].id : null;
    const id = this.#id();
    this.#pendingSays.set(id, conv);
    oc.lastSay = null;
    oc.pendingSay = text;
    this.open = new Map(this.open);
    this.#send({ type: 'say', id, conv, text, tip });
  }

  /** Cancel the query this client started — stop, never rollback. The reply
   *  is acceptance only; the outcome arrives as the query's closure. */
  cancel(conv: string) {
    const oc = this.open.get(conv);
    if (!oc?.liveQuery) return;
    const id = this.#id();
    this.#pendingCancels.set(id, conv);
    this.#send({ type: 'cancel', id, conv, query: oc.liveQuery });
  }

  /** The panel consumed the revoked say. */
  consumeRestore(conv: string) {
    const oc = this.open.get(conv);
    if (!oc) return;
    oc.restoreSay = null;
    this.open = new Map(this.open);
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
        // The committed say supersedes the pending one.
        if (
          oc.pendingSay !== null &&
          msg.message.role === 'user' &&
          msg.message.query === oc.liveQuery
        ) {
          oc.pendingSay = null;
        }
        this.open = new Map(this.open);
        break;
      }
      case 'streaming': {
        const oc = this.open.get(msg.conv);
        if (!oc) break;
        // Streaming is evidence a query is live — maybe not ours (liveQuery
        // stays null), but a say now would be refused stale.
        oc.queryState = 'live';
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
        if (msg.outcome === 'accepted') {
          // Ours, live: the pending say stays greyed until its commit.
          oc.lastSay = null;
          oc.liveQuery = msg.query;
          oc.queryState = 'live';
        } else {
          // Refused: hand the words back to the editor — nothing is lost.
          oc.lastSay =
            msg.outcome === 'rejected'
              ? `rejected: ${msg.reason}` // shown, never branched on
              : 'unreachable — nothing is serving this conversation';
          if (oc.pendingSay !== null) {
            oc.restoreSay = oc.pendingSay;
            oc.pendingSay = null;
          }
        }
        this.open = new Map(this.open);
        break;
      }
      case 'query': {
        // The committal closure: known-idle now, whoever's query it was. A
        // pending say the query never committed is revoked — back to the
        // editor, tip unmoved.
        const oc = this.open.get(msg.conv);
        if (!oc) break;
        oc.queryState = 'idle';
        if (oc.liveQuery === msg.queryId) oc.liveQuery = null;
        if (oc.pendingSay !== null) {
          oc.restoreSay = oc.pendingSay;
          oc.pendingSay = null;
        }
        oc.streaming = [];
        this.open = new Map(this.open);
        break;
      }
      case 'cancel_result': {
        const conv = this.#pendingCancels.get(msg.id);
        this.#pendingCancels.delete(msg.id);
        const oc = conv ? this.open.get(conv) : undefined;
        if (!oc) break;
        // Acceptance only — the outcome is the closure. Refusals shown.
        if (msg.outcome === 'rejected') oc.lastSay = `cancel rejected: ${msg.reason}`;
        else if (msg.outcome === 'unreachable') {
          // Nothing is serving this conversation: no closure will ever
          // arrive, so holding the lock would strand the input. The words
          // come home; the state is honestly unknown again.
          oc.lastSay = 'cancel unreachable — nothing is serving this conversation';
          oc.liveQuery = null;
          oc.queryState = 'unknown';
          if (oc.pendingSay !== null) {
            oc.restoreSay = oc.pendingSay;
            oc.pendingSay = null;
          }
        }
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
      case 'agents': {
        // The servicing snapshot replaces both maps — once per connection.
        this.agentInstances = new Map(
          msg.instances.map((i) => [`${i.world}/${i.instanceId}`, i]),
        );
        this.agentAttachments = new Map(
          msg.attachments.map((a) => [`${a.world}/${a.instanceId}/${a.conv}`, a]),
        );
        break;
      }
      case 'agent': {
        // One wire fact, one packet. `kind` is an open set: unknown kinds
        // are skipped, never fatal.
        const ikey = `${msg.world}/${msg.instanceId}`;
        if (msg.kind === 'ready' || msg.kind === 'pulse') {
          const held = this.agentInstances.get(ikey);
          this.agentInstances.set(ikey, {
            world: msg.world,
            instanceId: msg.instanceId,
            host: msg.host ?? held?.host,
            lastPulse: Math.max(msg.ts, held?.lastPulse ?? 0),
            intervalS: msg.intervalS ?? held?.intervalS,
          });
          this.agentInstances = new Map(this.agentInstances);
        } else if (msg.kind === 'attached' && msg.conv) {
          this.agentAttachments.set(`${ikey}/${msg.conv}`, {
            world: msg.world,
            instanceId: msg.instanceId,
            conv: msg.conv,
            cwd: msg.cwd,
            attachedTs: msg.ts,
          });
          this.agentAttachments = new Map(this.agentAttachments);
        } else if (msg.kind === 'detached' && msg.conv) {
          this.agentAttachments.delete(`${ikey}/${msg.conv}`);
          this.agentAttachments = new Map(this.agentAttachments);
        }
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
