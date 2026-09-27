// Reconcile: an option's holding as tower's changes.message bodies, and
// load() from those bodies back into Claude Code's entries.
//
// load() rebuilds each entry from the message it rides on: a user entry's
// content and an attachment's rendered text from the message's content
// through the entry's spans (proof 20's rebuild), an assistant piece's
// content from its message. Entries the model never sees come from the
// unshown record, as they were. All are put back in record order (`seq`)
// and chained: an entry whose parent tower doesn't have is chained to the
// entry before it (proof 24's relinking, TODO: undecided).

import { blocksOf, type Block, type Json, spanText, type Span } from '../semantic/form.mts';
import type { CcItem, Holding, Rec, TMsg } from './holding.mts';

export interface TowerBody extends Json {
  ts: string;
  id: string;
  queryId: string;
  turnId: string;
  role: string;
  content: Block[];
  ccEntries: CcItem[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

// TODO: undecided (carried from proofs 14 and 20): `from` human on a message
// holding a prompt, agent on assistant pieces, absent otherwise; queryId not
// tracked here.
export function toBodies(messages: TMsg[]): TowerBody[] {
  return messages.map((m) => {
    const prompt = m.role === 'user' && m.cc.some((c) => c.entry.type === 'user' && c.entry.isMeta !== true && m.content.some((b) => b.type === 'text'));
    return {
      ts: iso(m.commitMs),
      instanceId: 'reconcile',
      id: m.id,
      queryId: 'reconcile',
      turnId: m.turnId,
      role: m.role,
      ...(m.role === 'assistant' ? { from: { kind: 'agent' } } : prompt ? { from: { kind: 'human' } } : {}),
      content: m.content,
      ccEntries: m.cc,
    };
  });
}

// The spec's required fields (conversation.md), as proof 20 checked them.
export function checkBody(b: Json): string[] {
  const errors: string[] = [];
  for (const f of ['id', 'queryId', 'turnId', 'role']) {
    if (typeof b[f] !== 'string') {
      errors.push(`${f}: not a string`);
    }
  }
  if (!Array.isArray(b.content) || !(b.content as Json[]).every((x) => typeof x?.type === 'string')) {
    errors.push('content: not blocks');
  }
  return errors;
}

const wrap = (t: string): string => `<system-reminder>\n${t}\n</system-reminder>`;

function spanTexts(content: Block[], spans: Span[]): string[] {
  return spans.filter((s) => s.inResult || content[s.block]?.type === 'text').map((s) => (s.unwrapped ? wrap(spanText(content, s)) : spanText(content, s)));
}

function rebuildUser(body: TowerBody, c: CcItem): Json {
  const blocks = c.spans.map((s) => {
    const b = body.content[s.block] as Block;
    if (s.inResult) {
      const own = spanText(body.content, s);
      if (typeof b.content === 'string') {
        return { ...b, content: own };
      }
      const parts = blocksOf(b.content).slice(0, (s.part ?? 0) + 1);
      parts[s.part ?? 0] = { ...(parts[s.part ?? 0] as Block), text: own };
      return { ...b, content: parts };
    }
    if (s.start === undefined) {
      return b;
    }
    return { type: 'text', text: spanText(body.content, s) };
  });
  const content = c.contentString && blocks.length === 1 && blocks[0]?.type === 'text' ? String(blocks[0].text) : blocks;
  const e = c.entry;
  return { ...e, message: { ...(e.message as Json), content } };
}

function rebuildAttachment(body: TowerBody, c: CcItem): Json {
  const e = c.entry;
  const texts = spanTexts(body.content, c.spans);
  if (!Array.isArray(e.rendered)) {
    return e;
  }
  const r = e.rendered as Json[];
  if (texts.length !== r.length) {
    // Shape mismatch: one rendered item per text found.
    return { ...e, rendered: texts.map((t) => ({ content: t })) };
  }
  return { ...e, rendered: r.map((x, i) => ({ ...x, content: texts[i] })) };
}

export function load(bodies: TowerBody[], unshown: Rec[]): { entries: Json[]; lastChain: string | undefined } {
  const items: { seq: number; entry: Json }[] = [];
  for (const b of bodies) {
    for (const c of b.ccEntries ?? []) {
      let e: Json;
      if (c.entry.type === 'assistant') {
        e = { ...c.entry, message: { ...(c.entry.message as Json), content: b.content } };
      } else if (c.entry.type === 'user') {
        e = rebuildUser(b, c);
      } else {
        e = rebuildAttachment(b, c);
      }
      items.push({ seq: c.seq, entry: e });
    }
  }
  for (const r of unshown) {
    items.push({ seq: r.seq, entry: r.entry });
  }
  items.sort((a, b) => a.seq - b.seq);
  const present = new Set(items.map((i) => i.entry.uuid).filter((u): u is string => typeof u === 'string'));
  let prev: string | undefined;
  const entries = items.map(({ entry }) => {
    let e = entry;
    if (typeof e.parentUuid === 'string' && !present.has(e.parentUuid)) {
      e = { ...e, parentUuid: prev ?? null };
    }
    if (typeof e.uuid === 'string') {
      prev = e.uuid;
    }
    return e;
  });
  let lastChain: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Json;
    if (typeof e.uuid === 'string' && e.type !== 'system' && e.type !== 'progress') {
      lastChain = e.uuid;
      break;
    }
  }
  return { entries, lastChain };
}

// How far load() gives back what Claude Code wrote: each rebuilt entry
// against the raw one (the model-visible fields: content, rendered).
export function roundTrip(h: Holding, raw: Map<string, Json>): { same: number; differ: string[] } {
  const { entries } = load(toBodies(h.messages), h.unshown);
  let same = 0;
  const differ: string[] = [];
  for (const e of entries) {
    const r = raw.get(String(e.uuid));
    if (!r || typeof e.uuid !== 'string') {
      continue;
    }
    const pick = (x: Json): unknown => [(x.message as Json | undefined)?.content, x.rendered];
    if (JSON.stringify(pick(e)) === JSON.stringify(pick(r))) {
      same += 1;
    } else {
      differ.push(`${String(e.type)}${e.type === 'attachment' ? `:${String((e.attachment as Json).type)}` : ''} ${String(e.uuid).slice(0, 8)}: ${JSON.stringify(pick(e)).slice(0, 100)} vs ${JSON.stringify(pick(r)).slice(0, 100)}`);
    }
  }
  return { same, differ };
}
