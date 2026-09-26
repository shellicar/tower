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
import { type ApiMessage, type Block, blocksOf, type CcEntry, type FormMessage, isCarrier, type Json, normalise, renderedTexts, type Span, textOf } from './form.mts';

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
        if (e) {
          add(e, { block: bi });
        } else {
          out.uncovered.push({ message: mi, block: bi, text: `tool_result ${String(b.tool_use_id)}` });
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
      let pos = 0;
      const spans: { e: Json; start: number; length: number; unwrapped?: boolean }[] = [];
      for (;;) {
        let best: { e: Json; start: number; length: number; unwrapped?: boolean } | undefined;
        for (const c of candidates) {
          if (used.has(c) || spans.some((s) => s.e === c)) {
            continue;
          }
          const texts = c.type === 'attachment' ? (renderedTexts(c) ?? []) : [userText(c) ?? ''];
          for (const t of texts) {
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
