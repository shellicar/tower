// Reconcile: what tower holds for a Claude Code conversation, option by
// option, computed from one recording of a run (store appends with their
// instants, request bodies with the instant each file appeared, the body
// log's index, and the instants each query ended).
//
// Every option commits the same assistant pieces at the same instants
// (proof 24's option H: each piece at its store append, a thinking-only
// piece held until a sibling with the same message.id and other content
// arrives, dropped if none does). The options differ in what they commit on
// the user side (prompts, tool results, reminders, the interrupt marker),
// in what form, and when:
//
//   entry     one tower message per entry the model sees, as Claude Code wrote
//             it, at its store append (proof 24's H, in a tower form).
//   request   the messages as the model received them, per request, when its
//             body is seen and the entries in it are in the store; a later
//             request's re-sent blocks are not committed again (proof 20).
//   run       the messages as the model received them, per run (every
//             user-side entry between two kept replies), when the run's kept
//             reply is in the store, from the body of the request that got
//             that reply. A run with no kept reply yet waits.
//   run+last  as run, but at each query's end a run with no kept reply is
//             committed in the form its latest request sent it (entries no
//             request has carried yet, as written); what a later request
//             adds to it is committed at that request's kept reply.
//   run+entry as run, but at each query's end a run with no kept reply is
//             committed as written (entry form); the rest as run+last.
//   next      as run, but everything committed only when the next query's
//             request appears (the next query's history).
//
// Every option also carries, on a record tower keeps but never shows, every
// entry the model never sees (attachments with no rendered text, system and
// bookkeeping entries, Claude Code's API error notes), each at its store
// append, so the commit rule and form are the only things that vary.
//
// TODO: undecided, each the easiest thing that runs, none a proposal:
//   - The unshown record: a list beside the messages (tower would need a
//     field on a message, which may not exist yet at the entry's append, or
//     a leaf of its own).
//   - ccEntries: each entry's raw fields ride on the message it is part of,
//     minus the model-visible content (a user entry's message.content, an
//     attachment's rendered text), which load() rebuilds from the message's
//     content through spans (proof 20's shape). `seq`, the entry's place in
//     Claude Code's record, rides too, so load() can put entries back in
//     record order.
//   - In the entry form, an attachment with rendered text is a `system`
//     message; a user entry is a `user` message.
//   - turnId: an assistant piece's is its response's message id; a
//     user-side message's is the request file it was committed from (the
//     entry form: the entry's uuid).
//   - Blocks no entry accounts for are kept in the content with no
//     ccEntries item; load() does not rebuild them.

import { attributeMessages, newMessages } from '../semantic/by-body.mts';
import { predict, settingsForModel } from '../semantic/by-fold.mts';
import { type Block, blocksOf, type CcEntry, type FormMessage, isCarrier, type Json, normalise, PAYLOAD_TEXT_TYPES, renderedTexts, type Span } from '../semantic/form.mts';
import { type Accepted, flatTail, mainResponses, offlinePending, select } from '../semantic/select.mts';

export type { Json };

export interface Rec {
  seq: number;
  ms: number;
  entry: Json;
}

export interface Req {
  file: string;
  ms: number;
  body: Json;
}

export interface IndexLine {
  query_source?: string;
  model?: string;
  message_id?: string;
  request_file?: string;
  response_file?: string;
}

export interface Recording {
  model: string;
  entries: Rec[]; // main key, append order
  requests: Req[]; // every request body, in order of appearance
  index: IndexLine[];
  results: number[]; // instants of each query's `result`
}

export interface CcItem {
  seq: number;
  uuid: string;
  entry: Json; // raw, minus model-visible content
  spans: Span[];
  contentString?: boolean;
}

export interface TMsg {
  commitMs: number;
  id: string;
  role: string;
  turnId: string;
  content: Block[];
  cc: CcItem[];
  via: string; // how it was committed (for the report)
}

export interface Holding {
  option: string;
  messages: TMsg[];
  unshown: Rec[];
  // entries the model sees that this option has not committed
  notCommitted: Rec[];
}

export const OPTIONS = ['entry', 'request', 'run', 'run+last', 'run+entry', 'next'] as const;
export type Option = (typeof OPTIONS)[number];

// ---------------------------------------------------------------------------
// Classifying entries.

const isAssistant = (e: Json): boolean => e.type === 'assistant' && e.message !== undefined;
const isApiError = (e: Json): boolean => e.isApiErrorMessage === true && (e.message as Json | undefined)?.model === '<synthetic>';
const blocks = (e: Json): Block[] => blocksOf((e.message as Json | undefined)?.content);
const onlyThinking = (e: Json): boolean => {
  const b = blocks(e);
  return b.length > 0 && b.every((x) => x.type === 'thinking' || x.type === 'redacted_thinking');
};
const msgId = (e: Json): string => String((e.message as Json | undefined)?.id ?? e.uuid);

export type Kind = 'assistant' | 'carrier' | 'unshown';

export function kindOf(e: Json): Kind {
  if (isAssistant(e) && !isApiError(e)) {
    return 'assistant';
  }
  if (isAssistant(e)) {
    return 'unshown';
  }
  return isCarrier(e) ? 'carrier' : 'unshown';
}

// The instant each assistant piece is committed (H), or undefined if it is
// never kept.
export function assistantCommits(rec: Recording): Map<string, number> {
  const out = new Map<string, number>();
  const sibling = new Map<string, number>(); // message.id -> first append of a non-thinking piece
  for (const r of rec.entries) {
    if (kindOf(r.entry) === 'assistant' && !onlyThinking(r.entry)) {
      const id = msgId(r.entry);
      if (!sibling.has(id)) {
        sibling.set(id, r.ms);
      }
    }
  }
  for (const r of rec.entries) {
    if (kindOf(r.entry) !== 'assistant') {
      continue;
    }
    if (!onlyThinking(r.entry)) {
      out.set(String(r.entry.uuid), r.ms);
      continue;
    }
    const s = sibling.get(msgId(r.entry));
    if (s !== undefined) {
      out.set(String(r.entry.uuid), Math.max(s, r.ms));
      continue;
    }
    // Added for the integration proof (.claude/tasks/code-read-trailing-
    // thinking.md): Claude Code keeps a thinking-only reply when the next
    // reply continues it, marked resumedFromIncompleteThinking. Committed
    // with that next reply. Behind a GrowthBook flag that is off by default,
    // so no reconcile recording holds the marker and nothing there changes.
    const at = rec.entries.indexOf(r);
    const next = rec.entries.slice(at + 1).find((x) => kindOf(x.entry) === 'assistant' && msgId(x.entry) !== msgId(r.entry));
    if (next && next.entry.resumedFromIncompleteThinking === true) {
      out.set(String(r.entry.uuid), next.ms);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The main conversation's requests, and what each carried.

export interface MainReq {
  req: Req;
  anchor: string;
  retry: boolean;
  // Everything the request added after its history, attributed to entries
  // (not cut against earlier requests).
  form: FormMessage[];
  uncovered: number;
  // Kept assistant entries whose response this request got.
  replies: string[];
  firstReplyMs: number | undefined;
}

export function mainRequests(rec: Recording, commits: Map<string, number>): MainReq[] {
  const served = rec.requests.filter((r) => String(r.body.model).startsWith(rec.model) && Array.isArray(r.body.messages)).sort((a, b) => a.ms - b.ms);
  const accepted: Accepted[] = [];
  const out: MainReq[] = [];
  served.forEach((r, i) => {
    const nextMs = served[i + 1]?.ms ?? Number.POSITIVE_INFINITY;
    // Entries in the store before the next request: enough to attribute
    // this one (its prompt reaches the store ~80 ms after the file).
    const main = rec.entries.filter((x) => x.ms < nextMs && x.entry.isSidechain !== true).map((x) => x.entry);
    const v = select(r.body as Json & { messages: never[] }, { model: rec.model, main, pending: offlinePending(main, new Set()), accepted });
    if (!v.main) {
      return;
    }
    if (!v.retry) {
      accepted.push({ anchor: v.anchor, tail: flatTail(r.body as never) });
    }
    // The run since the anchor: every entry after the anchor's last piece.
    const responses = mainResponses(main);
    const at = responses.findIndex((x) => x.id === v.anchor);
    const from = at >= 0 ? (responses[at]?.last ?? -1) + 1 : 0;
    const pending = main.slice(from).filter((e) => !isAssistant(e) && isCarrier(e));
    const added = newMessages(r.body as never);
    const a = attributeMessages(added, pending);
    out.push({ req: r, anchor: v.anchor, retry: v.retry, form: a.messages, uncovered: a.uncovered.length, replies: [], firstReplyMs: undefined });
  });
  // Pair kept replies with requests: by the index's message id, else the
  // latest main request before the reply's append (an interrupted request
  // has no index line).
  const byFile = new Map(out.map((m) => [m.req.file, m]));
  for (const r of rec.entries) {
    const at = commits.get(String(r.entry.uuid));
    if (at === undefined) {
      continue;
    }
    const line = rec.index.find((l) => l.message_id === msgId(r.entry));
    let m = line?.request_file ? byFile.get(line.request_file) : undefined;
    if (!m) {
      m = [...out].reverse().find((x) => x.req.ms <= r.ms);
    }
    if (m) {
      m.replies.push(String(r.entry.uuid));
      m.firstReplyMs = Math.min(m.firstReplyMs ?? Number.POSITIVE_INFINITY, at);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building tower messages.

const seqOf = (rec: Recording): Map<string, Rec> => new Map(rec.entries.filter((r) => typeof r.entry.uuid === 'string').map((r) => [String(r.entry.uuid), r]));

// An entry with its model-visible content removed.
export function stripContent(e: Json): Json {
  const out: Json = { ...e };
  if (e.type === 'user' && e.message) {
    const { content: _c, ...m } = e.message as Json;
    out.message = m;
  }
  if (e.type === 'attachment' && Array.isArray(e.rendered)) {
    out.rendered = (e.rendered as Json[]).map(({ content: _c, ...rest }) => rest);
  }
  if (e.type === 'assistant' && e.message) {
    const { content: _c, ...m } = e.message as Json;
    out.message = m;
  }
  return out;
}

function ccItem(r: Rec, spans: Span[]): CcItem {
  const e = r.entry;
  return {
    seq: r.seq,
    uuid: String(e.uuid),
    entry: stripContent(e),
    spans,
    ...(e.type === 'user' && typeof (e.message as Json).content === 'string' ? { contentString: true } : {}),
  };
}

// A carrier entry as written: one message of its own.
export function entryForm(r: Rec, commitMs: number, via: string): TMsg {
  const e = r.entry;
  if (e.type === 'user') {
    const content = blocks(e);
    return { commitMs, id: String(e.uuid), role: 'user', turnId: String(e.uuid), content, cc: [ccItem(r, content.map((_, i) => ({ block: i })))], via };
  }
  const att = e.attachment as Json;
  const texts = PAYLOAD_TEXT_TYPES.has(String(att?.type)) ? [String(att.text)] : (renderedTexts(e) ?? []);
  const content = texts.map((t) => ({ type: 'text', text: t }));
  const spans = PAYLOAD_TEXT_TYPES.has(String(att?.type)) ? [] : content.map((_, i) => ({ block: i }));
  return { commitMs, id: String(e.uuid), role: 'system', turnId: String(e.uuid), content, cc: [ccItem(r, spans)], via };
}

// The parts of a request's form whose entries are not yet committed, as
// messages of their own, in the request's order. A block wholly made of
// such entries is taken whole; a span inside a block (a reminder joined with
// others) is taken as a text block of its own.
export function remainder(form: FormMessage[], committed: Set<string>, bySeq: Map<string, Rec>, commitMs: number, turnId: string, via: string): TMsg[] {
  const out: TMsg[] = [];
  for (const m of form) {
    const taken = m.ccEntries.filter((c) => !committed.has(c.uuid));
    const owners = new Map<number, CcEntry[]>();
    for (const c of m.ccEntries) {
      for (const s of c.spans) {
        owners.set(s.block, [...(owners.get(s.block) ?? []), c]);
      }
    }
    const content: Block[] = [];
    const items = new Map<string, { r: Rec; spans: Span[]; c: CcEntry }>();
    const place = (c: CcEntry, s: Span): void => {
      const r = bySeq.get(c.uuid);
      if (!r) {
        return;
      }
      const it = items.get(c.uuid) ?? { r, spans: [], c };
      it.spans.push(s);
      items.set(c.uuid, it);
    };
    const wholeBlocks = new Map<number, number>(); // original block -> new index
    m.content.forEach((b, bi) => {
      const own = owners.get(bi) ?? [];
      if (own.length === 0) {
        // No entry behind it: first sending only (it rides with the first
        // remainder that contains any of this request's entries).
        if (taken.length === m.ccEntries.length) {
          content.push(b);
        }
        return;
      }
      const fresh = own.filter((c) => !committed.has(c.uuid));
      if (fresh.length === 0) {
        return;
      }
      const partial = own.some((c) => c.spans.some((s) => s.block === bi && s.start !== undefined && !s.inResult));
      if (fresh.length === own.length && !partial) {
        wholeBlocks.set(bi, content.length);
        content.push(b);
        for (const c of fresh) {
          for (const s of c.spans.filter((x) => x.block === bi)) {
            place(c, { ...s, block: content.length - 1 });
          }
        }
        return;
      }
      if (b.type === 'tool_result') {
        // A tool_result with reminders folded in: whole, with its entry.
        content.push(b);
        for (const c of fresh) {
          for (const s of c.spans.filter((x) => x.block === bi)) {
            place(c, { ...s, block: content.length - 1 });
          }
        }
        return;
      }
      // Spans inside a joined text block: each fresh span its own block.
      const spans = fresh.flatMap((c) => c.spans.filter((s) => s.block === bi).map((s) => ({ c, s }))).sort((x, y) => (x.s.start ?? 0) - (y.s.start ?? 0));
      const text = String(b.text ?? '');
      for (const { c, s } of spans) {
        const t = s.start === undefined ? text : text.slice(s.start, s.start + (s.length ?? 0));
        content.push({ type: 'text', text: t });
        place(c, { block: content.length - 1, ...(s.unwrapped ? { unwrapped: true } : {}) });
      }
    });
    if (content.length === 0) {
      continue;
    }
    const cc = [...items.values()].sort((a, b) => a.r.seq - b.r.seq).map((it) => ({ ...ccItem(it.r, it.spans), ...(it.c.contentString ? { contentString: true } : {}) }));
    const idEntry = cc.find((c) => c.entry.type === 'user' && c.entry.isMeta !== true) ?? cc[0];
    out.push({ commitMs, id: idEntry ? idEntry.uuid : `${turnId}:${out.length}`, role: m.role, turnId, content, cc, via });
  }
  return out;
}

function assistantMsg(r: Rec, commitMs: number): TMsg {
  const content = blocks(r.entry);
  return { commitMs, id: String(r.entry.uuid), role: 'assistant', turnId: msgId(r.entry), content, cc: [ccItem(r, content.map((_, i) => ({ block: i })))], via: 'append' };
}

// ---------------------------------------------------------------------------
// The options.

export interface Built {
  all: TMsg[]; // every message the option ever commits, in commit order
  unshown: Rec[];
  mains: MainReq[];
  orderWarnings: string[];
}

export function build(rec: Recording, option: Option): Built {
  const commits = assistantCommits(rec);
  const mains = mainRequests(rec, commits);
  const bySeq = seqOf(rec);
  const out: TMsg[] = [];
  const orderWarnings: string[] = [];
  const committed = new Set<string>();
  const commit = (ms: TMsg[]): void => {
    for (const m of ms) {
      out.push(m);
      for (const c of m.cc) {
        committed.add(c.uuid);
      }
    }
  };
  const carriers = rec.entries.filter((r) => kindOf(r.entry) === 'carrier');
  const unshown = rec.entries.filter((r) => kindOf(r.entry) === 'unshown');

  // Events in time order: store appends (assistant pieces, entry form),
  // request bodies, kept replies, query ends.
  type Ev = { ms: number; order: number; run: () => void };
  const evs: Ev[] = [];
  let order = 0;
  const at = (ms: number, run: () => void): void => {
    evs.push({ ms, order: order++, run });
  };

  for (const r of rec.entries) {
    const c = commits.get(String(r.entry.uuid));
    if (c !== undefined) {
      at(c, () => {
        // A reply's user side goes before the reply (tower's order is the
        // conversation's order).
        flushBefore(c);
        if (due.length > 0 && option !== 'entry' && option !== 'request') {
          const own = mains.find((m) => m.replies.includes(String(r.entry.uuid)));
          if (own && own.form.some((f) => f.ccEntries.some((x) => !committed.has(x.uuid)))) {
            orderWarnings.push(`${String(r.entry.uuid).slice(0, 8)} committed before its run`);
          }
        }
        commit([assistantMsg(r, c)]);
      });
    }
  }
  // User-side commits due at or before a reply's instant happen first.
  const due: { ms: number; fn: () => TMsg[] }[] = [];
  const flushBefore = (ms: number): void => {
    for (const d of due.splice(0).sort((a, b) => a.ms - b.ms)) {
      if (d.ms <= ms) {
        commit(d.fn());
      } else {
        due.push(d);
      }
    }
  };

  const fitsLater = (m: MainReq): number => Math.max(...m.form.flatMap((f) => f.ccEntries.map((c) => bySeq.get(c.uuid)?.ms ?? 0)), 0);

  if (option === 'entry') {
    for (const r of carriers) {
      at(r.ms, () => commit([entryForm(r, r.ms, 'append')]));
    }
  }
  if (option === 'request') {
    for (const m of mains) {
      const ms = Math.max(m.req.ms, fitsLater(m));
      due.push({ ms, fn: () => remainder(m.form, committed, bySeq, ms, m.req.file, 'request') });
      at(ms, () => flushBefore(ms));
    }
  }
  if (option === 'run' || option === 'run+last' || option === 'run+entry' || option === 'next') {
    for (const m of mains) {
      if (m.firstReplyMs === undefined) {
        continue;
      }
      let ms = Math.max(m.firstReplyMs, fitsLater(m));
      if (option === 'next') {
        const nxt = mains.find((x) => x.req.ms > ms);
        ms = nxt ? nxt.req.ms : Number.POSITIVE_INFINITY;
      }
      if (!Number.isFinite(ms)) {
        continue;
      }
      due.push({ ms, fn: () => remainder(m.form, committed, bySeq, ms, m.req.file, option === 'next' ? 'next' : 'run') });
      at(ms, () => flushBefore(ms));
    }
  }
  if (option === 'run+last' || option === 'run+entry') {
    for (const q of rec.results) {
      at(q, () => {
        flushBefore(q);
        const open = carriers.filter((r) => r.ms <= q && !committed.has(String(r.entry.uuid)));
        if (open.length === 0) {
          return;
        }
        if (option === 'run+last') {
          const last = [...mains].reverse().find((m) => m.req.ms <= q && m.form.some((f) => f.ccEntries.some((c) => !committed.has(c.uuid))));
          if (last) {
            commit(remainder(last.form, committed, bySeq, q, last.req.file, 'result, last request'));
          }
        }
        for (const r of open) {
          if (!committed.has(String(r.entry.uuid))) {
            commit([entryForm(r, q, 'result, as written')]);
          }
        }
      });
    }
  }
  evs.sort((a, b) => a.ms - b.ms || a.order - b.order);
  for (const e of evs) {
    e.run();
  }
  flushBefore(Number.POSITIVE_INFINITY);
  // `next` commits assistant pieces with their run, not at append: each
  // run's messages, then its replies, at the run's instant.
  if (option === 'next') {
    const ordered: TMsg[] = [];
    const assistants = new Map(out.filter((m) => m.role === 'assistant').map((m) => [m.id, m]));
    for (const m of mains) {
      const run = out.filter((x) => x.role !== 'assistant' && x.turnId === m.req.file);
      if (run.length === 0) {
        continue;
      }
      ordered.push(...run);
      for (const u of m.replies) {
        const a = assistants.get(u);
        if (a) {
          ordered.push({ ...a, commitMs: run[0]?.commitMs ?? Number.POSITIVE_INFINITY });
        }
      }
    }
    out.length = 0;
    out.push(...ordered);
  }
  return { all: out, unshown, mains, orderWarnings };
}

// What the option holds at an instant.
export function holdingAt(rec: Recording, option: Option, ms: number, built = build(rec, option)): Holding {
  const messages = built.all.filter((m) => m.commitMs <= ms);
  const inTower = new Set(messages.flatMap((m) => m.cc.map((c) => c.uuid)));
  const commits = assistantCommits(rec);
  const notCommitted = rec.entries.filter((r) => r.ms <= ms && !inTower.has(String(r.entry.uuid)) && (kindOf(r.entry) === 'carrier' || (kindOf(r.entry) === 'assistant' && (commits.get(String(r.entry.uuid)) ?? Number.POSITIVE_INFINITY) <= ms)));
  return { option, messages, unshown: built.unshown.filter((r) => r.ms <= ms), notCommitted };
}

// Proof 16's approach B: the form Claude Code's fold would give a run,
// predicted from its entries alone, for comparing with the body's form.
export function foldPrediction(rec: Recording, m: MainReq): FormMessage[] {
  const uuids = new Set(m.form.flatMap((f) => f.ccEntries.map((c) => c.uuid)));
  const pending = rec.entries.filter((r) => uuids.has(String(r.entry.uuid))).map((r) => r.entry);
  return predict(pending, settingsForModel(rec.model)).messages;
}

export function sameForm(a: FormMessage[], b: FormMessage[]): boolean {
  const n = (f: FormMessage[]): string => JSON.stringify(f.map((m) => ({ role: m.role, content: m.content.map((x) => normalise({ role: m.role, content: [x] }).content[0]) })));
  return n(a) === n(b);
}
