// Proof 20, problem 1: which logged request bodies are the main
// conversation's, decided when the request file appears (not after the
// response), without relying on the `thread` field being there.
//
// History match (the brief's candidate): a request is the main conversation's
// when
//   1. its history is the main conversation's: every assistant message in the
//      body is, in order, one of the main conversation's own responses (from
//      its assistant entries, compared by text and tool_use ids; thinking text
//      is redacted in the body). A response that is only thinking may be
//      missing: Claude Code drops it from the history it sends (seen in proof
//      6's max-tokens-hit run). When the body is a thread `continue`
//      (flag-gated, Sonnet and Haiku), it sends only what follows its anchor,
//      named by id: the anchor must be a main response.
//   2. what it adds after that history is anchored in the main conversation's
//      pending entries: at least one block is, whole, a pending main user
//      entry's own content (a prompt, a tool_result, an isMeta user message);
//      once there is a main history, a pending main user entry's text inside
//      a block is enough. Reminders alone are not an anchor: every thread
//      gets them.
//
// What a request adds is what follows its last assistant message, less what
// an earlier main request with the same last assistant message already sent:
// when the response between two requests is dropped from the history (a
// thinking-only response) or never came (an abort before the first byte),
// the later request re-sends the earlier one's added blocks (merged into one
// user message; a text block followed by another gains a trailing newline,
// R12; new reminders can land ahead of them, R6). Proof 16 counted a re-sent
// copy as a block with no entry behind it.
//
// A request whose history and added messages equal an earlier main request's
// is another attempt at it (a retry).
//
// A subagent's request has its own history (its first request has no
// assistant message, and its prompt is a sidechain entry, never a pending main
// one). compact and agent_summary send a history but add a prompt that is no
// entry. The title request embeds the prompt inside a larger text block.
//
// TODO: undecided (proof mechanism, not a proposal): which selector a
// participant would use. This module also computes, for comparison, the
// `diagnostics.previous_message_id` chain and proof 16's selector (model and
// `thread`).

import { type Attribution, attributeMessages, newMessages } from './by-body.mts';
import { type ApiMessage, type Block, blocksOf, isCarrier, type Json, normalise } from './form.mts';

// An assistant message as comparable text: text blocks and tool_use ids, in
// order. Thinking is left out: the body carries it redacted.
export function assistantKey(content: unknown): string {
  return JSON.stringify(
    blocksOf(content)
      .filter((b) => b.type === 'text' || b.type === 'tool_use' || b.type === 'server_tool_use')
      .map((b) => (b.type === 'text' ? ['t', String(b.text)] : ['u', String(b.id)])),
  );
}

const THINKING_ONLY = '[]';

export interface MainResponse {
  id: string;
  key: string;
  // Index, in the main entries, of the response's first and last piece.
  first: number;
  last: number;
}

// The main conversation's responses, in order, from its assistant entries
// (one entry per content block; the pieces of one response share message.id).
export function mainResponses(main: Json[]): MainResponse[] {
  const byId = new Map<string, { first: number; last: number; blocks: Block[] }>();
  const order: string[] = [];
  main.forEach((e, i) => {
    if (e.type !== 'assistant') {
      return;
    }
    const msg = e.message as Json;
    // Claude Code's own assistant entries (an API error, "No response
    // requested.") are not responses.
    if (e.isApiErrorMessage === true || msg.model === '<synthetic>') {
      return;
    }
    // Pieces join on message.id; an entry without one (a load() that didn't
    // carry it) stands alone, as Claude Code sends it.
    const id = typeof msg.id === 'string' ? msg.id : `(no id) ${String(e.uuid)}`;
    const got = byId.get(id);
    if (got) {
      got.last = i;
      got.blocks.push(...blocksOf(msg.content));
    } else {
      order.push(id);
      byId.set(id, { first: i, last: i, blocks: [...blocksOf(msg.content)] });
    }
  });
  return order.map((id) => {
    const r = byId.get(id) as { first: number; last: number; blocks: Block[] };
    return { id, key: assistantKey(r.blocks), first: r.first, last: r.last };
  });
}

export function bodyAssistants(body: { messages: ApiMessage[] }): string[] {
  return body.messages.filter((m) => m.role === 'assistant').map((m) => assistantKey(m.content));
}

// What follows the last assistant message, one item per block.
export interface Flat {
  role: string;
  block: Block;
}

export function flatTail(body: { messages: ApiMessage[] }): Flat[] {
  return newMessages(body).flatMap((m) => normalise(m as ApiMessage).content.map((block) => ({ role: m.role, block })));
}

export function regroup(flats: Flat[]): { role: string; content: Block[] }[] {
  const out: { role: string; content: Block[] }[] = [];
  for (const f of flats) {
    const last = out[out.length - 1];
    if (last && last.role === f.role) {
      last.content.push(f.block);
    } else {
      out.push({ role: f.role, content: [f.block] });
    }
  }
  return out;
}

const same = (a: Flat, b: Flat): boolean => a.role === b.role && JSON.stringify(a.block) === JSON.stringify(b.block);
// The earlier sending of a block, re-sent after a dropped response: equal, or
// a text block that has since gained a trailing newline (R12).
const resent = (now: Flat, before: Flat): boolean => same(now, before) || (now.role === before.role && now.block.type === 'text' && before.block.type === 'text' && now.block.text === `${String(before.block.text)}\n`);

export interface Accepted {
  // The anchor response's id, or "start:<index of the segment's first entry>"
  // for a request with no history (a first request, or the first after a
  // compaction).
  anchor: string;
  tail: Flat[];
}

export interface Verdict {
  main: boolean;
  retry: boolean;
  reason: string;
  // The body's last assistant message (or the thread anchor) as a main
  // response id, or "start:<n>" when it has no history.
  anchor: string;
  // Blocks at the start of what follows the anchor that an earlier main
  // request with the same anchor already sent.
  resent: number;
  added: { role: string; content: Block[] }[];
  attribution?: Attribution;
  // diagnostics.previous_message_id as the body carries it (undefined: no
  // diagnostics field).
  prevId: string | null | undefined;
  // What the previous_message_id chain alone would say: it names the main
  // conversation's latest response, or null before the first.
  prevIdSays: boolean | undefined;
  // Proof 16's selector: the model asked for, with a `thread`.
  proof16Says: boolean;
}

export interface SelectContext {
  model: string;
  // The main conversation's entries so far (the session store's main key),
  // in record order.
  main: Json[];
  // Pending main entries a request may carry, given the window of main
  // entries (indexes into `main`) after its anchor and before the next
  // response with anything but thinking. A live run passes what hasn't been
  // placed yet and can ignore the window.
  pending: (from: number, to: number) => Json[];
  // Requests already taken as main, in order.
  accepted: Accepted[];
}

// Match the body's assistant messages against the main responses, allowing
// thinking-only responses to be missing. Returns the anchor, or a reason.
function historyAnchor(keys: string[], responses: MainResponse[]): number | string {
  let i = 0;
  let anchor = -1;
  for (let j = 0; j < keys.length; j += 1) {
    while (i < responses.length && responses[i]?.key !== keys[j] && responses[i]?.key === THINKING_ONLY) {
      i += 1;
    }
    if (i >= responses.length) {
      return `assistant message ${j} is past the main conversation's ${responses.length} response(s)`;
    }
    if (responses[i]?.key !== keys[j]) {
      return `assistant message ${j} is not the main conversation's response ${i}`;
    }
    anchor = i;
    i += 1;
  }
  return anchor;
}

// The main entries split at compaction boundaries: after a compaction the
// history Claude Code sends starts again from the summary.
function segments(main: Json[]): { start: number; entries: Json[] }[] {
  const out: { start: number; entries: Json[] }[] = [];
  let start = 0;
  main.forEach((e, i) => {
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      out.push({ start, entries: main.slice(start, i) });
      start = i + 1;
    }
  });
  out.push({ start, entries: main.slice(start) });
  return out;
}

export function select(body: Json & { messages: ApiMessage[] }, ctx: SelectContext): Verdict {
  const all = mainResponses(ctx.main);
  const diag = body.diagnostics as Json | undefined | null;
  const prevId = diag === undefined || diag === null ? undefined : (diag.previous_message_id as string | null);
  const thread = body.thread as Json | undefined;
  const proof16Says = body.model === ctx.model && thread !== undefined;
  const prevIdSays = prevIdSaysFor(prevId, all, ctx.accepted.length);
  const keys = bodyAssistants(body);
  let last: Verdict = { resent: 0, added: [], prevId, prevIdSays, proof16Says, main: false, retry: false, reason: 'no main history', anchor: '' };
  // The segment the history belongs to, latest first. A body with no history
  // fits every segment: the one whose entries anchor what it adds wins.
  for (const seg of segments(ctx.main).reverse()) {
    const responses = mainResponses(seg.entries);
    let at: number;
    let why: string;
    if (thread?.type === 'continue') {
      at = responses.findIndex((r) => r.id === thread.previous_message_id);
      why = 'thread anchor is a main response';
      if (at < 0) {
        last = { ...last, reason: "continues a thread whose anchor is not one of the main conversation's responses" };
        continue;
      }
    } else {
      const a = historyAnchor(keys, responses);
      why = 'history is the main conversation';
      if (typeof a === 'string') {
        last = { ...last, reason: a };
        continue;
      }
      at = a;
    }
    const v = judge(body, ctx, seg, responses, at, why, { prevId, prevIdSays, proof16Says });
    if (v.main) {
      return v;
    }
    last = v;
  }
  return last;
}

function judge(body: Json & { messages: ApiMessage[] }, ctx: SelectContext, seg: { start: number; entries: Json[] }, responses: MainResponse[], at: number, why: string, ids: Pick<Verdict, 'prevId' | 'prevIdSays' | 'proof16Says'>): Verdict {
  const anchor = at >= 0 ? (responses[at] as MainResponse).id : `start:${seg.start}`;
  const base = { anchor, ...ids };
  const tail = flatTail(body);
  const before = [...ctx.accepted].reverse().find((x) => x.anchor === anchor);
  if (before && tail.length === before.tail.length && tail.every((f, i) => same(f, before.tail[i] as Flat))) {
    return { ...base, main: true, retry: true, reason: 'same history and added messages as a request already taken: another attempt', resent: tail.length, added: [] };
  }
  // The earlier request's added blocks, re-sent: found in order among this
  // request's (new reminders can land ahead of them, R6), and cut.
  let skip = 0;
  let kept = tail;
  if (before && before.tail.length < tail.length) {
    const keep: Flat[] = [];
    let j = 0;
    for (const f of tail) {
      if (j < before.tail.length && resent(f, before.tail[j] as Flat)) {
        j += 1;
      } else {
        keep.push(f);
      }
    }
    if (j === before.tail.length) {
      skip = j;
      kept = keep;
    }
  }
  const added = regroup(kept);
  const from = seg.start + (at >= 0 ? (responses[at] as MainResponse).last + 1 : 0);
  const next = responses.slice(at + 1).find((r) => r.key !== THINKING_ONLY);
  const to = next ? seg.start + next.first : ctx.main.length;
  const pending = ctx.pending(from, to).filter(isCarrier);
  const attribution = attributeMessages(added, pending);
  // With no history to go on (a first request), only a whole block counts:
  // the title request embeds the prompt inside its own text. With a main
  // history, a user entry's text inside a block counts too (Claude Code
  // wraps a task-notification when it sends it).
  const anchored = attribution.messages.some((m) => m.ccEntries.some((c) => c.type === 'user' && c.spans.some((sp) => sp.start === undefined || at >= 0)));
  if (!anchored) {
    return { ...base, main: false, retry: false, reason: 'nothing it adds is, whole, a pending main user entry', resent: skip, added, attribution };
  }
  return { ...base, main: true, retry: false, reason: `${why}; adds a pending main user entry${skip ? ` (after ${skip} re-sent block(s))` : ''}`, resent: skip, added, attribution };
}

// The previous_message_id chain on its own (Claude Code's dxe: the last
// assistant message in what it sends with an API id): main when it names a
// main response, or is null before any main request.
function prevIdSaysFor(prevId: string | null | undefined, responses: MainResponse[], acceptedSoFar: number): boolean | undefined {
  if (prevId === undefined) {
    return undefined;
  }
  if (prevId === null) {
    return acceptedSoFar === 0;
  }
  return responses.some((r) => r.id === prevId);
}

// Offline: the window's main entries, less the ones already placed.
export function offlinePending(main: Json[], placed: Set<string>): SelectContext['pending'] {
  return (from, to) => main.slice(from, to).filter((e) => e.type !== 'assistant' && !placed.has(String(e.uuid)));
}
