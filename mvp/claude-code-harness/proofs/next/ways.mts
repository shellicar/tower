// Proof 24: the ways a participant could commit, at a query's end, what
// Claude Code builds its next query on. Each way is a function from what the
// participant can see (store appends, SDK messages, hooks, the body log) to
// a holding (entries or blocks) and the instant it can commit.
//
// None of these is a proposal. Choices inside a way that are not from the
// brief are marked TODO: undecided.

import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { Blk, Json } from './history.mts';
import { blockOf, entryBlocks } from './history.mts';

// ---------------------------------------------------------------------------
// The fold: which written entries Claude Code leaves out of the next query.
// Claude Code's internals, not documented; see FOLD_RULES.

export interface FoldResult {
  kept: Json[];
  dropped: { uuid: string; rule: string }[];
}

function isAssistant(e: Json): boolean {
  return e.type === 'assistant' && (e.message as Json | undefined) !== undefined;
}

function blocksOf(e: Json): Json[] {
  const c = (e.message as Json | undefined)?.content;
  if (typeof c === 'string') {
    return [{ type: 'text', text: c }];
  }
  return Array.isArray(c) ? (c as Json[]) : [];
}

// Claude Code 2.1.282, read from the JS in its binary (byte offsets into
// the extracted source; minified names):
//   F1  LS()/Ij() at 134658400: an assistant entry with isApiErrorMessage
//       and message.model "<synthetic>" is skipped by normalizeMessagesForAPI
//       (Pw, 141481584). Every API error entry is built with that model
//       (F6t, 141456723), the output-limit one included (139807046).
//   F2  h5t at 141577105: an assistant entry whose blocks are all thinking is
//       dropped unless another entry with the same message.id has a block
//       that isn't thinking (N7o). Not applied to the last entry while
//       Claude Code resumes incomplete thinking after an output-limit hit.
// Both at send time: the entries stay in the transcript and in memory.
export const FOLD_RULES: Record<string, string> = {
  F1: 'An API error entry (isApiErrorMessage, model "<synthetic>") is not sent.',
  F2: 'An assistant entry whose blocks are all thinking is not sent, unless another entry with the same message.id has a block that is not thinking.',
};

// TODO: undecided. Only the two rules that proof 23's endings exercise;
// Claude Code's normaliser has more (ensureToolResultPairing, trailing
// thinking on a last assistant message, empty content, foreign-model
// thinking), which no ending here reaches.
export function fold(entries: Json[]): FoldResult {
  const dropped: { uuid: string; rule: string }[] = [];
  const byMsg = new Map<string, Json[]>();
  for (const e of entries) {
    if (isAssistant(e)) {
      const id = String((e.message as Json).id ?? e.uuid);
      const list = byMsg.get(id) ?? [];
      list.push(e);
      byMsg.set(id, list);
    }
  }
  const drop = new Set<string>();
  for (const e of entries) {
    if (e.isApiErrorMessage === true && (e.message as Json | undefined)?.model === '<synthetic>') {
      drop.add(String(e.uuid));
      dropped.push({ uuid: String(e.uuid), rule: 'F1' });
    }
  }
  for (const [, list] of byMsg) {
    const live = list.filter((e) => !drop.has(String(e.uuid)));
    if (live.length === 0) {
      continue;
    }
    const blocks = live.flatMap(blocksOf);
    if (blocks.length > 0 && blocks.every((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
      for (const e of live) {
        drop.add(String(e.uuid));
        dropped.push({ uuid: String(e.uuid), rule: 'F2' });
      }
    }
  }
  return { kept: relink(entries, drop), dropped };
}

// Dropping an entry breaks its child's parentUuid, and a resume then loads
// only the tail (proof 8). The child is pointed at the dropped entry's
// parent. TODO: undecided; relinking is the easiest way to keep the chain.
export function relink(entries: Json[], drop: Set<string>): Json[] {
  const parentOf = new Map<string, unknown>();
  for (const e of entries) {
    if (typeof e.uuid === 'string') {
      parentOf.set(e.uuid, e.parentUuid);
    }
  }
  const up = (p: unknown): unknown => {
    let cur = p;
    while (typeof cur === 'string' && drop.has(cur)) {
      cur = parentOf.get(cur);
    }
    return cur;
  };
  return entries.filter((e) => !(typeof e.uuid === 'string' && drop.has(e.uuid))).map((e) => (typeof e.parentUuid === 'string' && drop.has(e.parentUuid) ? { ...e, parentUuid: up(e.parentUuid) ?? null } : e));
}

// ---------------------------------------------------------------------------
// The SDK's own reader over a store: getSessionMessages({ sessionStore }).
// Documented (alpha).

export class MemoryStore implements SessionStore {
  readonly entries: Json[];
  constructor(entries: Json[]) {
    this.entries = entries;
  }
  async append(_key: SessionKey, _entries: SessionStoreEntry[]): Promise<void> {}
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return key.subpath ? null : (this.entries as SessionStoreEntry[]);
  }
}

export async function sdkReader(sessionId: string, entries: Json[]): Promise<{ blocks: Blk[]; uuids: string[] }> {
  const msgs = await getSessionMessages(sessionId, { sessionStore: new MemoryStore(entries) });
  const blocks: Blk[] = [];
  const uuids: string[] = [];
  for (const m of msgs) {
    const msg = m.message as Json;
    uuids.push(m.uuid);
    const role = String(msg?.role ?? m.type);
    const c = msg?.content;
    const list = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? (c as Json[]) : [];
    for (const b of list) {
      const blk = blockOf(role, b, m.uuid, false);
      if (blk) {
        blocks.push(blk);
      }
    }
  }
  return { blocks, uuids };
}

// ---------------------------------------------------------------------------
// SDK events: what the participant sent, plus the SDK's main-thread
// assistant and user messages.

export function sdkEventBlocks(steps: { prompt: string; messages: Json[] }[]): Blk[] {
  const out: Blk[] = [];
  for (const s of steps) {
    out.push(...entryBlocks([{ type: 'user', uuid: 'sent', message: { role: 'user', content: s.prompt } }]));
    for (const m of s.messages) {
      if ((m.type !== 'assistant' && m.type !== 'user') || (m.parent_tool_use_id ?? null) !== null || m.isReplay === true) {
        continue;
      }
      out.push(...entryBlocks([{ type: m.type, uuid: String(m.uuid), message: m.message }]));
    }
  }
  return out;
}
