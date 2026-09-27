// Reconcile: tower's messages against the messages Claude Code's next query
// sends (L, the probe's request in the same process), reminders, system
// messages and boundaries included (proof 24's history test left them out).
//
// Both sides are brought to one currency: each message as its role and the
// entries behind its blocks, in order. The request's messages are
// attributed to entries with proof 20's attribution; tower's carry their
// entries. Then:
//   exact       same messages, same entries in each, same bytes
//   bytes       same messages and entries; some text differs only by
//               trailing newlines (Claude Code adds "\n" to a text block
//               another joins, R12)
//   grouping    the same entries in the same order and roles, split into
//               messages differently (consecutive same-role messages)
//   placement   an entry sits elsewhere relative to the others (a reminder
//               on the other side of a prompt, inside or outside a tool
//               result)
//   missing / extra  entries on one side only
// A comparison reports every kind it finds, worst first.

import { attributeMessages } from '../semantic/by-body.mts';
import { type Block, blocksOf, isCarrier, type Json, normalise, spanText, type Span } from '../semantic/form.mts';
import { blockOf, fullHistory } from '../next/history.mts';
import type { Recording, TMsg } from './holding.mts';
import { assistantCommits, kindOf } from './holding.mts';

export interface Unit {
  role: string;
  items: { uuid: string | null; text: string }[];
}

function textOfSpan(content: Block[], s: Span): string {
  const b = content[s.block] as Block | undefined;
  if (!b) {
    return '';
  }
  if (s.inResult && b.type === 'tool_result') {
    return `tool_result ${String(b.tool_use_id)} ${b.is_error === true ? 'error ' : ''}${spanText(content, s)}`;
  }
  if (b.type === 'text') {
    return spanText(content, s);
  }
  if (b.type === 'tool_result') {
    // A tool result as its own content's text, so a whole block and a span
    // inside it (reminders folded in) compare on the same terms.
    const c = b.content;
    return `tool_result ${String(b.tool_use_id)} ${b.is_error === true ? 'error ' : ''}${typeof c === 'string' ? c : blocksOf(c).map((x) => (x.type === 'text' ? String(x.text) : JSON.stringify(x))).join('\n')}`;
  }
  // Non-text blocks: identity by their JSON, cache_control aside.
  const { cache_control: _c, ...rest } = b;
  return JSON.stringify(rest);
}

const blockKey = (role: string, b: Block): string => blockOf(role, b as Json, '', false)?.key ?? JSON.stringify(b);

// The request's messages as units.
export function requestUnits(rec: Recording, messages: { role: string; content: unknown }[]): { units: Unit[]; unattributed: number } {
  const carriers = rec.entries.filter((r) => kindOf(r.entry) === 'carrier').map((r) => r.entry);
  const commits = assistantCommits(rec);
  const kept = rec.entries.filter((r) => commits.has(String(r.entry.uuid)));
  const used = new Set<string>();
  const usedA = new Set<string>();
  const units: Unit[] = [];
  let unattributed = 0;
  let run: { role: string; content: Block[] }[] = [];
  const flushRun = (): void => {
    if (run.length === 0) {
      return;
    }
    const pending = carriers.filter((c) => !used.has(String(c.uuid)));
    const a = attributeMessages(run, pending);
    a.messages.forEach((m) => {
      const items: { uuid: string | null; text: string; pos: number; sub: number }[] = [];
      for (const c of m.ccEntries) {
        used.add(c.uuid);
        for (const s of c.spans) {
          items.push({ uuid: c.uuid, text: textOfSpan(m.content, s), pos: s.block, sub: s.start ?? 0 });
        }
      }
      const covered = new Set(m.ccEntries.flatMap((c) => c.spans.map((s) => s.block)));
      m.content.forEach((b, bi) => {
        if (!covered.has(bi)) {
          unattributed += 1;
          items.push({ uuid: null, text: textOfSpan(m.content, { block: bi }), pos: bi, sub: 0 });
        }
      });
      items.sort((x, y) => x.pos - y.pos || x.sub - y.sub);
      units.push({ role: m.role, items: items.map(({ uuid, text }) => ({ uuid, text })) });
    });
    run = [];
  };
  for (const raw of messages) {
    const m = normalise(raw as never);
    if (m.role !== 'assistant') {
      run.push(m);
      continue;
    }
    flushRun();
    const items = m.content.map((b) => {
      const k = blockKey('assistant', b);
      const e = kept.find((r) => !usedA.has(String(r.entry.uuid)) && blocksOf((r.entry.message as Json).content).some((x) => blockKey('assistant', x) === k));
      if (e) {
        usedA.add(String(e.entry.uuid));
        return { uuid: String(e.entry.uuid), text: k };
      }
      unattributed += 1;
      return { uuid: null, text: k };
    });
    units.push({ role: 'assistant', items });
  }
  flushRun();
  return { units, unattributed };
}

// Tower's messages as units: assistant pieces of one response joined.
export function towerUnits(messages: TMsg[]): Unit[] {
  const units: Unit[] = [];
  let lastTurn: string | undefined;
  for (const m of messages) {
    if (m.role === 'assistant') {
      const items = m.content.map((b) => ({ uuid: m.id, text: blockKey('assistant', b) }));
      const last = units[units.length - 1];
      if (last && last.role === 'assistant' && lastTurn === m.turnId) {
        last.items.push(...items);
      } else {
        units.push({ role: 'assistant', items });
      }
      lastTurn = m.turnId;
      continue;
    }
    lastTurn = undefined;
    const items: { uuid: string | null; text: string; pos: number; sub: number }[] = [];
    const covered = new Set<number>();
    for (const c of m.cc) {
      for (const s of c.spans) {
        covered.add(s.block);
        items.push({ uuid: c.uuid, text: textOfSpan(m.content, s), pos: s.block, sub: s.start ?? 0 });
      }
    }
    m.content.forEach((b, bi) => {
      if (!covered.has(bi)) {
        items.push({ uuid: null, text: textOfSpan(m.content, { block: bi }), pos: bi, sub: 0 });
      }
    });
    items.sort((x, y) => x.pos - y.pos || x.sub - y.sub);
    units.push({ role: m.role, items: items.map(({ uuid, text }) => ({ uuid, text })) });
  }
  return units;
}

export interface Verdict {
  kinds: string[]; // worst first: missing, extra, placement, grouping, bytes; or ['exact']
  missing: string[];
  extra: string[];
  placement: string[];
  bytes: string[];
  shape: { request: string; tower: string };
}

const sig = (u: Unit): string => `${u.role}[${u.items.map((i) => (i.uuid ?? '-').slice(0, 8)).join(',')}]`;
const mergeSameRole = (us: Unit[]): Unit[] => {
  const out: Unit[] = [];
  for (const u of us) {
    const last = out[out.length - 1];
    if (last && last.role === u.role) {
      last.items.push(...u.items);
    } else {
      out.push({ role: u.role, items: [...u.items] });
    }
  }
  return out;
};

export function compareUnits(request: Unit[], tower: Unit[], describe: (uuid: string) => string): Verdict {
  const rIds = request.flatMap((u) => u.items.map((i) => i.uuid)).filter((x): x is string => x !== null);
  const tIds = tower.flatMap((u) => u.items.map((i) => i.uuid)).filter((x): x is string => x !== null);
  const rSet = new Set(rIds);
  const tSet = new Set(tIds);
  const missing = [...rSet].filter((x) => !tSet.has(x)).map(describe);
  const extra = [...tSet].filter((x) => !rSet.has(x)).map(describe);
  // Order and roles over the entries both hold.
  const both = (us: Unit[]): Unit[] => us.map((u) => ({ role: u.role, items: u.items.filter((i) => i.uuid !== null && rSet.has(i.uuid) && tSet.has(i.uuid)) })).filter((u) => u.items.length > 0);
  const rb = both(request);
  const tb = both(tower);
  const flat = (us: Unit[]): string[] => us.flatMap((u) => u.items.map((i) => `${u.role}:${i.uuid}`));
  const rf = flat(rb);
  const tf = flat(tb);
  // Collapse repeated uuids (an entry with several spans in one place).
  const dedupe = (xs: string[]): string[] => xs.filter((x, i) => x !== xs[i - 1]);
  const placement: string[] = [];
  if (JSON.stringify(dedupe(rf)) !== JSON.stringify(dedupe(tf))) {
    const a = dedupe(rf);
    const b = dedupe(tf);
    let i = 0;
    while (i < a.length && a[i] === b[i]) {
      i++;
    }
    const show = (x: string | undefined): string => (x ? `${x.split(':')[0]} ${describe(x.slice(x.indexOf(':') + 1))}` : 'end');
    placement.push(`first difference at entry ${i}: request has ${show(a[i])}, tower has ${show(b[i])}`);
  }
  const grouping = placement.length === 0 && JSON.stringify(mergeSameRole(rb).map(sig)) === JSON.stringify(mergeSameRole(tb).map(sig)) && JSON.stringify(rb.map(sig)) !== JSON.stringify(tb.map(sig));
  const bytes: string[] = [];
  const texts = (us: Unit[]): Map<string, string> => {
    const m = new Map<string, string>();
    for (const u of us) {
      for (const i of u.items) {
        if (i.uuid !== null) {
          m.set(i.uuid, (m.get(i.uuid) ?? '') + i.text);
        }
      }
    }
    return m;
  };
  const rt = texts(request);
  const tt = texts(tower);
  let nlOnly = 0;
  for (const [u, t] of rt) {
    const o = tt.get(u);
    if (o === undefined || o === t) {
      continue;
    }
    if (o.replace(/\n+$/, '') === t.replace(/\n+$/, '')) {
      nlOnly += 1;
    } else {
      bytes.push(`${describe(u)}: request ${JSON.stringify(t.slice(0, 60))} tower ${JSON.stringify(o.slice(0, 60))}`);
    }
  }
  const kinds: string[] = [];
  if (missing.length > 0) {
    kinds.push('missing');
  }
  if (extra.length > 0) {
    kinds.push('extra');
  }
  if (placement.length > 0) {
    kinds.push('placement');
  }
  if (grouping) {
    kinds.push('grouping');
  }
  if (bytes.length > 0) {
    kinds.push('content');
  }
  if (nlOnly > 0) {
    kinds.push('newline');
  }
  const shapeOf = (us: Unit[]): string => us.map((u) => `${u.role[0]}${u.items.length}`).join(' ');
  return { kinds: kinds.length > 0 ? kinds : ['exact'], missing, extra, placement, bytes, shape: { request: shapeOf(request), tower: shapeOf(tower) } };
}

export function describeEntry(rec: Recording): (uuid: string) => string {
  const by = new Map(rec.entries.map((r) => [String(r.entry.uuid), r.entry]));
  return (uuid) => {
    const e = by.get(uuid);
    if (!e) {
      return uuid.slice(0, 8);
    }
    if (e.type === 'attachment') {
      return `${String((e.attachment as Json).type)}`;
    }
    if (e.type === 'user') {
      const c = (e.message as Json).content;
      const t = typeof c === 'string' ? c : blocksOf(c).map((b) => (b.type === 'text' ? String(b.text) : b.type)).join('|');
      return `user ${JSON.stringify(t.slice(0, 30))}`;
    }
    return `${String(e.type)} ${blocksOf((e.message as Json | undefined)?.content).map((b) => b.type).join(',')}`;
  };
}

// The probe's request: the first main request carrying the probe text,
// with its whole history (a `continue` request's rebuilt from the chain).
export function probeHistory(bodiesDir: string, rec: Recording, probe: string): { file: string; messages: { role: string; content: unknown }[] } | undefined {
  const served = rec.requests.filter((r) => String(r.body.model).startsWith(rec.model) && r.body.thinking !== undefined && Array.isArray(r.body.messages));
  for (const r of served) {
    if (JSON.stringify(r.body.messages).includes(probe)) {
      return { file: r.file, messages: fullHistory(bodiesDir, r.file).messages as never };
    }
  }
  return undefined;
}

// Tower's messages that the probe's request should hold: everything but the
// probe's own reply (and anything after it).
export function towerBeforeProbeReply(messages: TMsg[], probeRequestMs: number, rec: Recording): TMsg[] {
  const after = new Set(rec.entries.filter((r) => r.ms > probeRequestMs && kindOf(r.entry) === 'assistant').map((r) => String(r.entry.uuid)));
  return messages.filter((m) => !(m.role === 'assistant' && after.has(m.id)));
}

export { isCarrier };
