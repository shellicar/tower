// concerns/view.svelte.ts — the view concern (docs/mvp/frontend-architecture.md).
// It owns the shell's local state: tabs, each tab's filter/group config, the
// open-set per tab, and whether the approvals view is showing. None of it
// touches the wire — its inputs are user action and localStorage. It decides
// WHICH conversations are open and drives the conversation concern (setOpen);
// it never reads that concern's content.

import type { Conversations } from './conversation.svelte';

/** The rail's view configuration — per tab. */
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

export class View {
  tabs = $state<Tab[]>(readTabs());
  active = $state<number>(readActiveTab());
  /** Whether the approvals view is showing — pure view state. */
  approvalsOpen = $state(false);

  readonly #conversations: Conversations;

  constructor(conversations: Conversations) {
    this.#conversations = conversations;
    // Open the active tab's conversations at boot; the conversation concern
    // re-opens them once the socket connects (its onConnect).
    conversations.setOpen(this.tab.convs);
  }

  /** The active tab; tabs always number at least one. */
  get tab(): Tab {
    return this.tabs[Math.min(this.active, this.tabs.length - 1)];
  }

  /** The active tab's config — what the rail reads and mutates. */
  get view(): ViewConfig {
    return this.tab.view;
  }

  addTab(): void {
    this.tabs.push({ name: `view ${this.tabs.length + 1}`, view: defaultView(), convs: [] });
    this.active = this.tabs.length - 1;
    this.#conversations.setOpen(this.tab.convs);
    this.saveView();
  }

  closeTab(i: number): void {
    if (this.tabs.length <= 1) return;
    this.tabs.splice(i, 1);
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.#conversations.setOpen(this.tab.convs);
    this.saveView();
  }

  renameTab(i: number, name: string): void {
    if (name.trim()) this.tabs[i].name = name.trim();
    this.saveView();
  }

  switchTab(i: number): void {
    this.active = i;
    // Only the active tab's conversations stay open — background tabs are cold
    // (holding every conversation's content warm was CPU and RAM on invisible
    // panels). Switching back re-fetches: half a second against a gigabyte.
    this.#conversations.setOpen(this.tab.convs);
    this.saveView();
  }

  openConversation(conv: string): void {
    if (!this.tab.convs.includes(conv)) {
      this.tab.convs.push(conv);
      this.saveView();
    }
    this.#conversations.open(conv);
  }

  closeConversation(conv: string): void {
    this.tab.convs = this.tab.convs.filter((c) => c !== conv);
    this.saveView();
    this.#conversations.close(conv);
  }

  saveView(): void {
    try {
      localStorage.setItem('tower.tabs', JSON.stringify(this.tabs));
      localStorage.setItem('tower.activeTab', String(this.active));
    } catch {
      // Storage full or blocked: persistence degrades, viewing does not.
    }
  }
}

/** Tabs from storage, migrating the pre-tab keys (tower.view, tower.open) into
 *  tab one so nothing is lost on upgrade. Always at least one tab. */
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
