// concerns/view.svelte.ts — the view concern (docs/mvp/frontend-architecture.md).
// It owns the shell's tabs, each tab's filter/group config, its open-set, and
// whether the approvals view is showing.
//
// Promoted onto the wire (settled with the SC 19 Jul, building on the 12 Jul
// "tower owns the management structure, clients only render it" decision):
// `tabs` (names + open sets) is now shared, durable fleet state, folded from
// the server's `layout` snapshot/broadcast and pushed with `set_layout` — the
// same optimistic-write-then-reconcile shape `Rail.setTitle` already uses.
// `active` (which tab is in front) and each tab's `ViewConfig`
// (filters/grouping) stay LOCAL, deliberately: which window you're looking
// at, and how you've sliced it, are facts about the viewer, not the shared
// workspace (the same split the SC drew for browser profiles on 12 Jul). A
// tab's `ViewConfig` is kept by matching on name across a `layout` fold, the
// same "held annotation survives the upsert" pattern the rail uses for titles.

import type { Conversations } from './conversation.svelte';
import type { Transport } from '../core/transport.svelte';
import type { ServerMsg, WireTab } from '../types';

/** The rail's view configuration — per tab, local only. */
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

/** A tab is a whole working view: its own config AND its own open set. */
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

const defaultTabs = (): Tab[] => [{ name: 'main', view: defaultView(), convs: [] }];

export class View {
  tabs = $state<Tab[]>(defaultTabs());
  active = $state<number>(readActiveTab());
  /** Whether the approvals view is showing — pure view state, local only. */
  approvalsOpen = $state(false);
  /** Whether the unread/stale-conversations view is showing — same footing. */
  unreadOpen = $state(false);

  readonly #conversations: Conversations;
  readonly #transport: Transport;
  /** True until the first `layout` frame lands — gates the one-time
   *  localStorage migration below, so a real (even empty) server layout is
   *  never overwritten by stale browser data on a later reconnect. */
  #migrated = false;

  constructor(conversations: Conversations, transport: Transport) {
    this.#conversations = conversations;
    this.#transport = transport;
    transport.subscribe((event) => this.#fold(event));
    // Re-open the active tab's conversations on every (re)connect — the
    // `layout` snapshot that follows on connect will correct this to the
    // shared set anyway; this covers the gap before it arrives.
    transport.onConnect(() => this.#conversations.setOpen(this.tab.convs));
  }

  #fold(event: ServerMsg): void {
    if (event.type !== 'layout') return;
    if (event.tabs.length === 0) {
      // Nothing on the server yet: one-time migration of this browser's old
      // localStorage tabs, so an existing Svelte user doesn't lose theirs
      // the moment layout moves server-side. Only on the very first frame —
      // a later empty layout (everyone closed every tab down to one, cleared
      // it) must not resurrect stale local data.
      if (!this.#migrated) {
        this.#migrated = true;
        const legacy = readLegacyLocalTabs();
        if (legacy) {
          this.tabs = legacy;
          this.#sendLayout();
          return;
        }
      }
      return;
    }
    this.#migrated = true;
    const held = new Map(this.tabs.map((t) => [t.name, t.view]));
    this.tabs = event.tabs.map((t) => ({
      name: t.name,
      view: held.get(t.name) ?? readViewConfig(t.name),
      convs: t.convs,
    }));
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    saveActiveTab(this.active);
    // The snapshot can replace the active tab's convs with ones never opened
    // in this session (a fresh connection's `onConnect` open ran against the
    // still-default empty tab, before this snapshot arrived) — without this,
    // App.svelte's `conversations.get(c) !== undefined` filter hides every
    // conv until something else happens to call setOpen (e.g. a tab switch).
    this.#conversations.setOpen(this.tab.convs);
  }

  /** The active tab; tabs always number at least one. */
  get tab(): Tab {
    return this.tabs[Math.min(this.active, this.tabs.length - 1)];
  }

  /** The active tab's config — what the rail reads and mutates. */
  get view(): ViewConfig {
    return this.tab.view;
  }

  /** Persists the active tab's `ViewConfig` (filters/grouping) — local only,
   *  keyed by tab name so it survives a `layout` fold (which replaces `tabs`
   *  wholesale but this concern re-attaches held config by name). RowList
   *  calls this after every filter/group edit. */
  saveView(): void {
    try {
      localStorage.setItem(`tower.viewConfig.${this.tab.name}`, JSON.stringify(this.tab.view));
    } catch {
      // Storage full or blocked: persistence degrades, viewing does not.
    }
  }

  #sendLayout(): void {
    const tabs: WireTab[] = this.tabs.map((t) => ({ name: t.name, convs: t.convs }));
    this.#transport.send({ type: 'set_layout', id: this.#transport.id(), tabs });
  }

  addTab(): void {
    this.tabs.push({ name: `view ${this.tabs.length + 1}`, view: defaultView(), convs: [] });
    this.active = this.tabs.length - 1;
    this.#conversations.setOpen(this.tab.convs);
    this.#sendLayout();
    saveActiveTab(this.active);
  }

  closeTab(i: number): void {
    if (this.tabs.length <= 1) return;
    this.tabs.splice(i, 1);
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.#conversations.setOpen(this.tab.convs);
    this.#sendLayout();
    saveActiveTab(this.active);
  }

  renameTab(i: number, name: string): void {
    if (name.trim()) this.tabs[i].name = name.trim();
    this.#sendLayout();
  }

  switchTab(i: number): void {
    this.active = i;
    // Only the active tab's conversations stay open — background tabs are cold
    // (holding every conversation's content warm was CPU and RAM on invisible
    // panels). Switching back re-fetches: half a second against a gigabyte.
    this.#conversations.setOpen(this.tab.convs);
    saveActiveTab(this.active);
  }

  openConversation(conv: string): void {
    if (!this.tab.convs.includes(conv)) {
      this.tab.convs.push(conv);
      this.#sendLayout();
    }
    this.#conversations.open(conv);
  }

  closeConversation(conv: string): void {
    this.tab.convs = this.tab.convs.filter((c) => c !== conv);
    this.#sendLayout();
    this.#conversations.close(conv);
  }
}

/** The pre-migration `tower.tabs` shape, read once to seed the server the
 *  first time this browser connects to a fleet with no layout yet. */
function readLegacyLocalTabs(): Tab[] | null {
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
    // no legacy data, or it's unreadable — nothing to migrate
  }
  return null;
}

function saveActiveTab(i: number): void {
  try {
    localStorage.setItem('tower.activeTab', String(i));
  } catch {
    // Storage full or blocked: persistence degrades, viewing does not.
  }
}

function readActiveTab(): number {
  const n = Number(localStorage.getItem('tower.activeTab') ?? '0');
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** A tab's persisted `ViewConfig`, by name; defaults when never saved (a tab
 *  new to this browser, e.g. one another client created). */
function readViewConfig(name: string): ViewConfig {
  try {
    const v = JSON.parse(localStorage.getItem(`tower.viewConfig.${name}`) ?? 'null');
    if (v) {
      return {
        filters: v.filters ?? {},
        groupKey: v.groupKey ?? '',
        alwaysShow: v.alwaysShow ?? [],
        hideUntagged: v.hideUntagged ?? false,
      };
    }
  } catch {
    // fall through to default
  }
  return defaultView();
}
