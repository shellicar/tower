// Approach A: the form from the request body.
//
// Claude Code writes each request body under OTEL_LOG_RAW_API_BODIES
// (undocumented). The messages after the request's last assistant message are
// the ones this request adds; each of their blocks is tied back to the entry
// that produced it:
//   - a tool_result block: the user entry holding that tool_use_id;
//   - a text block equal to a pending user entry's text (the prompt, an isMeta
//     notice): that entry;
//   - otherwise, text found in the block: each pending attachment's `rendered`
//     text, taken in the order it appears in the block, first unused entry in
//     record order on a tie.
// Entries not found stay pending for the next request. Text in a block that no
// entry accounts for is reported, not attributed.

import { unwrap } from './by-fold.mts';
import { type ApiMessage, type Block, blocksOf, type CcEntry, type FormMessage, isCarrier, type Json, normalise, renderedTexts, type Span, stripCacheControl, textOf } from './form.mts';

export interface Uncovered {
  message: number;
  block: number;
  text: string;
}

export interface Attribution {
  messages: FormMessage[];
  // Blocks, or parts of blocks, no pending entry accounts for.
  uncovered: Uncovered[];
  // Pending entries this request didn't carry (kept pending).
  unplaced: Json[];
  // Entries whose text was found only after trimming or not verbatim.
  notes: string[];
}

// Everything after the last assistant message: what this request adds.
export function newMessages(body: { messages: ApiMessage[] }): { role: string; content: Block[] }[] {
  const all = body.messages.map(normalise);
  let last = -1;
  all.forEach((m, i) => {
    if (m.role === 'assistant') {
      last = i;
    }
  });
  return all.slice(last + 1);
}

function userText(e: Json): string | undefined {
  const content = (e.message as Json | undefined)?.content;
  const blocks = blocksOf(content);
  if (blocks.length === 0 || blocks.some((b) => b.type !== 'text')) {
    return undefined;
  }
  return blocks.map(textOf).join('');
}

const SEPARATOR = /^\s*$/;

export function attribute(body: { messages: ApiMessage[] }, pending: Json[]): Attribution {
  return attributeMessages(newMessages(body), pending);
}

// The same over messages already cut to what a request adds (proof 20: a
// request can re-send the previous request's added messages when the
// response between them is dropped from the history; select.mts cuts those).
export function attributeMessages(added: { role: string; content: Block[] }[], pending: Json[]): Attribution {
  const used = new Set<Json>();
  const out: Attribution = { messages: [], uncovered: [], unplaced: [], notes: [] };
  const candidates = pending.filter(isCarrier);
  added.forEach((msg, mi) => {
    const parts = new Map<Json, Span[]>();
    const add = (e: Json, s: Span): void => {
      used.add(e);
      parts.set(e, [...(parts.get(e) ?? []), s]);
    };
    msg.content.forEach((b, bi) => {
      if (b.type === 'tool_result') {
        const e = candidates.find((c) => !used.has(c) && c.type === 'user' && blocksOf((c.message as Json).content).some((x) => x.type === 'tool_result' && x.tool_use_id === b.tool_use_id));
        if (!e) {
          out.uncovered.push({ message: mi, block: bi, text: `tool_result ${String(b.tool_use_id)}` });
          return;
        }
        const own = blocksOf((e.message as Json).content).find((x) => x.type === 'tool_result' && x.tool_use_id === b.tool_use_id) as Block;
        if (JSON.stringify(stripCacheControl(own)) === JSON.stringify(b)) {
          add(e, { block: bi });
          return;
        }
        // Proof 20, problem 4: reminders Claude Code folded into the
        // tool_result's content (models without system turns; code a5t/vUe):
        //   string content: the entry's own content trimmed, then each
        //     reminder trimmed, joined by a blank line;
        //   array content, fold on: the same inside the last text part;
        //   array content, fold off: the last text part gains a newline and
        //     each reminder follows as a text part of its own, untrimmed.
        // The entry's own content is one span (the last own part, sliced);
        // each reminder a span inside its part.
        const sent = b.content;
        const ownParts = typeof own.content === 'string' || own.content === undefined ? undefined : blocksOf(own.content);
        const sentParts = typeof sent === 'string' || sent === undefined ? undefined : blocksOf(sent);
        const reminders = (part: number | undefined, text: string, from: number, trimmed: boolean): number => {
          const found = findInside(text, from, candidates, (c) => used.has(c) || c === e, trimmed);
          let cursor = from;
          for (const f of found) {
            const gap = text.slice(cursor, f.start);
            if (!SEPARATOR.test(gap)) {
              out.uncovered.push({ message: mi, block: bi, text: `inside tool_result: ${gap}` });
            }
            add(f.e, { block: bi, inResult: true, ...(part === undefined ? {} : { part }), start: f.start, length: f.length });
            cursor = f.start + f.length;
          }
          if (text.slice(cursor).trim() !== '') {
            out.uncovered.push({ message: mi, block: bi, text: `inside tool_result: ${text.slice(cursor)}` });
          }
          return found.length;
        };
        if (ownParts === undefined && sentParts === undefined) {
          const inText = String(sent ?? '');
          const ownText = String(own.content ?? '').trim();
          if (!inText.startsWith(ownText)) {
            add(e, { block: bi });
            out.uncovered.push({ message: mi, block: bi, text: `tool_result ${String(b.tool_use_id)}: content differs from its entry's` });
            return;
          }
          add(e, { block: bi, inResult: true, start: 0, length: ownText.length });
          reminders(undefined, inText, ownText.length, true);
          return;
        }
        const ownList = ownParts ?? [{ type: 'text', text: String(own.content ?? '') }];
        const sentList = sentParts ?? [{ type: 'text', text: String(sent ?? '') }];
        const last = ownList.length - 1;
        const sameBefore = ownList.slice(0, last).every((x, i) => sentList[i] !== undefined && JSON.stringify(stripCacheControl(x)) === JSON.stringify(stripCacheControl(sentList[i] as Block)));
        const ownLast = ownList[last] as Block | undefined;
        const sentLast = sentList[last] as Block | undefined;
        if (!sameBefore || !ownLast || !sentLast || ownLast.type !== 'text' || sentLast.type !== 'text') {
          add(e, { block: bi });
          out.uncovered.push({ message: mi, block: bi, text: `tool_result ${String(b.tool_use_id)}: content differs from its entry's` });
          return;
        }
        const ownText = textOf(ownLast);
        const sentText = textOf(sentLast);
        if (sentText === ownText || sentText === `${ownText}\n`) {
          // Fold off: reminders are the parts after it.
          add(e, { block: bi, inResult: true, part: last, start: 0, length: ownText.length });
          for (let k = last + 1; k < sentList.length; k += 1) {
            const t = textOf(sentList[k] as Block);
            if (reminders(k, t, 0, false) === 0 && t.trim() !== '') {
              out.uncovered.pop();
              reminders(k, t, 0, true);
            }
          }
          return;
        }
        if (sentText.startsWith(ownText.trim())) {
          // Fold on: reminders inside the last own part.
          add(e, { block: bi, inResult: true, part: last, start: 0, length: ownText.trim().length });
          reminders(last, sentText, ownText.trim().length, true);
          for (let k = last + 1; k < sentList.length; k += 1) {
            reminders(k, textOf(sentList[k] as Block), 0, true);
          }
          return;
        }
        add(e, { block: bi });
        out.uncovered.push({ message: mi, block: bi, text: `tool_result ${String(b.tool_use_id)}: content differs from its entry's` });
        return;
      }
      if (b.type === 'tool_addition' || b.type === 'tool_removal') {
        // Built from a deferred_tools_delta entry's surfacedNames (code Pw,
        // omo; research note in proof 20).
        const name = String(((b.tool as Json | undefined)?.name ?? '') as string);
        const field = b.type === 'tool_addition' ? ['surfacedNames', 'replacedNames'] : ['removedNames'];
        const e = candidates.find((c) => c.type === 'attachment' && (c.attachment as Json).type === 'deferred_tools_delta' && field.some((f) => Array.isArray((c.attachment as Json)[f]) && ((c.attachment as Json)[f] as unknown[]).includes(name)));
        if (e) {
          add(e, { block: bi });
        } else {
          out.uncovered.push({ message: mi, block: bi, text: `${b.type} block ${name}` });
        }
        return;
      }
      if (b.type !== 'text') {
        // An image or document block: the user entry that holds an equal block.
        const key = JSON.stringify(b);
        const e = candidates.find((c) => !used.has(c) && c.type === 'user' && blocksOf((c.message as Json).content).some((x) => JSON.stringify(x) === key));
        if (e) {
          add(e, { block: bi });
        } else {
          out.uncovered.push({ message: mi, block: bi, text: `${b.type} block` });
        }
        return;
      }
      const text = textOf(b);
      const whole = candidates.find((c) => !used.has(c) && c.type === 'user' && userText(c) === text);
      if (whole) {
        add(whole, { block: bi });
        return;
      }
      // One of several text blocks of a user entry (a prompt sent as blocks).
      const part = candidates.find((c) => {
        if (c.type !== 'user' || (used.has(c) && !parts.has(c))) {
          return false;
        }
        const own = blocksOf((c.message as Json).content).filter((x) => x.type === 'text').map(textOf);
        const taken = (parts.get(c) ?? []).length;
        return own.length > 1 && own[taken] === text;
      });
      if (part) {
        add(part, { block: bi });
        return;
      }
      // Reminders inside the block, in the order they appear.
      const spans = findInside(text, 0, candidates, (c) => used.has(c), false);
      let cursor = 0;
      for (const s of spans) {
        const gap = text.slice(cursor, s.start);
        if (!SEPARATOR.test(gap)) {
          out.uncovered.push({ message: mi, block: bi, text: gap });
        }
        const whole = s.start === 0 && s.length === text.length;
        const flag = s.unwrapped ? { unwrapped: true } : {};
        add(s.e, whole ? { block: bi, ...flag } : { block: bi, start: s.start, length: s.length, ...flag });
        cursor = s.start + s.length;
      }
      const tail = text.slice(cursor);
      if (spans.length === 0 || !SEPARATOR.test(tail)) {
        if (spans.length === 0 || tail.trim() !== '') {
          out.uncovered.push({ message: mi, block: bi, text: spans.length === 0 ? text : tail });
        } else {
          out.notes.push(`message ${mi} block ${bi}: trailing ${JSON.stringify(tail)} after the last entry's text`);
        }
      } else if (tail !== '') {
        out.notes.push(`message ${mi} block ${bi}: trailing ${JSON.stringify(tail)} after the last entry's text`);
      }
    });
    // Record order, which is what load() needs to put them back.
    const ccEntries: CcEntry[] = candidates
      .filter((c) => parts.has(c))
      .map((c) => ({
        uuid: String(c.uuid),
        type: c.type === 'attachment' ? 'attachment' : 'user',
        ...(c.type === 'attachment' ? { attachment: c.attachment as Json } : {}),
        ...(c.isMeta === true ? { isMeta: true } : {}),
        ...(c.type === 'user' && c.origin !== undefined ? { origin: c.origin as Json } : {}),
      ...(c.type === 'user' && typeof (c.message as Json).content === 'string' ? { contentString: true } : {}),
        spans: parts.get(c) as Span[],
      }));
    out.messages.push({ role: msg.role === 'system' ? 'system' : 'user', content: msg.content, ccEntries });
  });
  out.unplaced = candidates.filter((c) => !used.has(c));
  // Not attributable at block grain: a reminder Claude Code folded into a
  // tool_result's own content (models without system turns).
  const inside = added.flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : blocksOf(b.content).map(textOf).join('\n'))));
  for (const c of out.unplaced) {
    const texts = renderedTexts(c) ?? [];
    if (texts.length > 0 && texts.every((t) => inside.some((x) => x.includes(t)))) {
      out.notes.push(`${String((c.attachment as Json | undefined)?.type)} ${String(c.uuid).slice(0, 8)}: its text is inside a tool_result block's content`);
    }
  }
  return out;
}

// Entries' texts found in `text` from `pos` on, in the order they appear,
// each entry once. `trimmed`: look for each text trimmed (a fold into a
// tool_result trims every reminder).
function findInside(text: string, pos0: number, candidates: Json[], skip: (c: Json) => boolean, trimmed: boolean): { e: Json; start: number; length: number; unwrapped?: boolean }[] {
  let pos = pos0;
  const spans: { e: Json; start: number; length: number; unwrapped?: boolean }[] = [];
  for (;;) {
    let best: { e: Json; start: number; length: number; unwrapped?: boolean } | undefined;
    for (const c of candidates) {
      if (skip(c) || spans.some((s) => s.e === c)) {
        continue;
      }
      const raw = c.type === 'attachment' ? (renderedTexts(c) ?? []) : [userText(c) ?? ''];
      for (const t0 of raw) {
        const t = trimmed ? t0.trim() : t0;
        if (t === '') {
          continue;
        }
        const at = text.indexOf(t, pos);
        if (at >= 0 && (best === undefined || at < best.start)) {
          best = { e: c, start: at, length: t.length };
        }
        // Sent without its <system-reminder> wrapper (other models'
        // system messages, a human-turn queued_command): found only by
        // knowing Claude Code strips it.
        const bare = unwrap(t);
        const atBare = bare !== t ? text.indexOf(bare, pos) : -1;
        if (atBare >= 0 && (best === undefined || atBare < best.start)) {
          best = { e: c, start: atBare, length: bare.length, unwrapped: true };
        }
      }
    }
    if (!best) {
      break;
    }
    spans.push(best);
    pos = best.start + best.length;
  }
  return spans;
}
