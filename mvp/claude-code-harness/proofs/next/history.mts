// Proof 24: what Claude Code builds its next query on, as blocks, and what a
// way of committing holds, as blocks, so the two can be compared.
//
// Comparison choices (not decisions; TODO: undecided, each the easiest that
// answers the brief's "compare the history"):
//   - Only the conversation is compared: user text, thinking, text, tool_use
//     and tool_result blocks. System-role messages and <system-reminder>
//     blocks are left out: which reminders go where is proofs 16 and 20's
//     question, and the cache test covers them.
//   - Thinking is compared by signature (the body log replaces thinking text
//     with <REDACTED>).
//   - Message boundaries are compared separately from blocks: Claude Code
//     merges consecutive user entries into one API message at send time
//     (proof 16, R2) and adds a trailing newline to a text block that
//     another joins (R12). A trailing-newline-only difference is reported
//     as such, not as different content.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Json = Record<string, unknown>;

export interface Blk {
  role: string;
  type: string;
  key: string; // content identity, trailing newlines of text trimmed
  exact: string; // content identity, byte for byte
  show: string; // short human form
  from?: string; // entry uuid or message index it came from
}

const REMINDER = /^\s*<system-reminder>/;
const REMINDER_SPAN = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/g;

function contentList(content: unknown): Json[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? (content as Json[]) : [];
}

function resultText(content: unknown, stripReminders: boolean): string {
  let parts: string[];
  if (typeof content === 'string') {
    parts = [content];
  } else if (Array.isArray(content)) {
    parts = (content as Json[]).map((b) => (b.type === 'text' ? String(b.text) : JSON.stringify(b)));
  } else {
    parts = [JSON.stringify(content ?? null)];
  }
  let s = parts.join('\n');
  if (stripReminders) {
    s = s.replace(REMINDER_SPAN, '');
  }
  return s;
}

function trimNl(s: string): string {
  return s.replace(/\n+$/, '');
}

export function blockOf(role: string, b: Json, from: string, stripReminders: boolean): Blk | undefined {
  const t = String(b.type);
  if (t === 'text') {
    const text = String(b.text ?? '');
    if (stripReminders && REMINDER.test(text)) {
      return undefined;
    }
    return { role, type: t, key: `${role}:text:${trimNl(text)}`, exact: `${role}:text:${text}`, show: `${role} text(${text.length}ch ${JSON.stringify(text.slice(0, 40))})`, from };
  }
  if (t === 'thinking') {
    const sig = String(b.signature ?? '');
    return { role, type: t, key: `${role}:thinking:${sig}`, exact: `${role}:thinking:${sig}`, show: `${role} thinking(${sig.slice(0, 10)})`, from };
  }
  if (t === 'redacted_thinking') {
    const d = String(b.data ?? '');
    return { role, type: t, key: `${role}:redacted:${d}`, exact: `${role}:redacted:${d}`, show: `${role} redacted_thinking`, from };
  }
  if (t === 'tool_use') {
    const k = `${role}:tool_use:${String(b.id)}:${String(b.name)}:${JSON.stringify(b.input ?? null)}`;
    return { role, type: t, key: k, exact: k, show: `${role} tool_use(${String(b.name)} ${String(b.id).slice(-6)})`, from };
  }
  if (t === 'tool_result') {
    const text = resultText(b.content, stripReminders);
    const base = `${role}:tool_result:${String(b.tool_use_id)}:${b.is_error === true}:`;
    return { role, type: t, key: base + trimNl(text), exact: base + text, show: `${role} tool_result(${String(b.tool_use_id).slice(-6)} ${b.is_error ? 'error ' : ''}${JSON.stringify(text.slice(0, 40))})`, from };
  }
  const k = `${role}:${t}:${JSON.stringify(b).slice(0, 200)}`;
  return { role, type: t, key: k, exact: k, show: `${role} ${t}`, from };
}

// ---------------------------------------------------------------------------
// The next query: its history, rebuilt from the body log.

interface IndexLine {
  query_source?: string;
  model?: string;
  message_id?: string;
  request_file?: string;
  response_file?: string;
}

export function readIndex(bodiesDir: string): IndexLine[] {
  const p = join(bodiesDir, 'index.jsonl');
  if (!existsSync(p)) {
    return [];
  }
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as IndexLine);
}

export interface ApiMessage {
  role: string;
  content: unknown;
}

// A `continue` request carries only what follows the previous response: the
// server holds the rest. Its history is the previous request's history, the
// previous response's content, then its own messages.
export function fullHistory(bodiesDir: string, requestFile: string, depth = 0): { messages: ApiMessage[]; chain: string[] } {
  const body = JSON.parse(readFileSync(join(bodiesDir, requestFile), 'utf8')) as Json;
  const own = (body.messages as ApiMessage[]) ?? [];
  const thread = body.thread as Json | undefined;
  if (!thread || thread.type !== 'continue' || depth > 50) {
    return { messages: own, chain: [`${requestFile}(${thread ? String(thread.type) : 'no thread'})`] };
  }
  const prevId = String(thread.previous_message_id);
  const line = readIndex(bodiesDir).find((l) => l.message_id === prevId);
  if (!line?.request_file || !line.response_file) {
    throw new Error(`continue from ${prevId}: no index line with its request and response`);
  }
  const prev = fullHistory(bodiesDir, line.request_file, depth + 1);
  const resp = JSON.parse(readFileSync(join(bodiesDir, line.response_file), 'utf8')) as Json;
  return { messages: [...prev.messages, { role: 'assistant', content: resp.content }, ...own], chain: [...prev.chain, `${requestFile}(continue)`] };
}

// The next query's conversation as blocks, with the new prompt (and what
// follows it) cut off. Returns undefined if the prompt is not found.
export function nextQueryBlocks(messages: ApiMessage[], prompt: string): { before: Blk[]; messageShape: string[]; after: Blk[] } | undefined {
  const all: Blk[] = [];
  const shape: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'system') {
      return;
    }
    const bs = contentList(m.content)
      .map((b) => blockOf(m.role, b, `msg${i}`, true))
      .filter((b): b is Blk => b !== undefined);
    if (bs.length > 0) {
      shape.push(`${m.role}[${bs.length}]`);
    }
    all.push(...bs);
  });
  let cut = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    const b = all[i];
    if (b && b.role === 'user' && b.type === 'text' && b.key === `user:text:${trimNl(prompt)}`) {
      cut = i;
      break;
    }
  }
  if (cut < 0) {
    return undefined;
  }
  return { before: all.slice(0, cut), messageShape: shape, after: all.slice(cut) };
}

// ---------------------------------------------------------------------------
// Entries (store/transcript) as blocks, one entry at a time, in order.

export function entryBlocks(entries: Json[]): Blk[] {
  const out: Blk[] = [];
  for (const e of entries) {
    if (e.type !== 'user' && e.type !== 'assistant') {
      continue;
    }
    const m = e.message as Json | undefined;
    if (!m) {
      continue;
    }
    const role = String(m.role ?? e.type);
    for (const b of contentList(m.content)) {
      const blk = blockOf(role, b, String(e.uuid), false);
      if (blk) {
        out.push(blk);
      }
    }
  }
  return out;
}

export interface Compare {
  equal: boolean; // same blocks, trailing newlines aside
  exact: boolean; // byte for byte
  missing: string[]; // in the next query, not held
  extra: string[]; // held, not in the next query
  firstDiff: number;
}

export function compareBlocks(held: Blk[], truth: Blk[]): Compare {
  const n = Math.max(held.length, truth.length);
  let firstDiff = -1;
  for (let i = 0; i < n; i++) {
    if (held[i]?.key !== truth[i]?.key) {
      firstDiff = i;
      break;
    }
  }
  const equal = firstDiff < 0;
  const exact = equal && held.every((b, i) => b.exact === truth[i]?.exact);
  const truthKeys = new Map<string, number>();
  for (const b of truth) {
    truthKeys.set(b.key, (truthKeys.get(b.key) ?? 0) + 1);
  }
  const heldKeys = new Map<string, number>();
  for (const b of held) {
    heldKeys.set(b.key, (heldKeys.get(b.key) ?? 0) + 1);
  }
  const extra = held.filter((b) => {
    const c = truthKeys.get(b.key) ?? 0;
    if (c > 0) {
      truthKeys.set(b.key, c - 1);
      return false;
    }
    return true;
  });
  const missing = truth.filter((b) => {
    const c = heldKeys.get(b.key) ?? 0;
    if (c > 0) {
      heldKeys.set(b.key, c - 1);
      return false;
    }
    return true;
  });
  return { equal, exact, missing: missing.map((b) => b.show), extra: extra.map((b) => b.show), firstDiff };
}
