// Proof 23: measurements across every cell of the given rounds, from the
// index files run.mts writes (each with the .summary.json analyse.mts wrote
// next to it). Deciding models (Sonnet, Opus, Fable) and Haiku are reported
// apart.
//
//   A  when a reply's entries reach the transcript: against the SDK's
//      per-block assistant message (block complete) and message_stop
//   B  the gap between a thinking block's signature_delta and the next
//      block's start, as the SDK delivered them
//   C  what still streamed after interrupt(), and when its writes landed
//   D  each signal's timing against the prompt's transcript line and the
//      first reply transcript line (summary signals, ms)
//   E  after an SDK abort: writes to the transcript after the stop, and
//      which of them the store got
//   F  counts of hooks and SDK signals over every run (main and resumes)
//
//   node proofs/commit/aggregate.mts <index.json> [...]

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
interface Ev extends Json {
  ms: number;
  src: string;
  kind: string;
}

const readJsonl = (p: string): Ev[] =>
  existsSync(p)
    ? (readFileSync(p, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l)) as Ev[])
    : [];

const DECIDING = ['sonnet', 'opus', 'fable'];
const group = (model: string): string => (DECIDING.some((d) => model.includes(d)) ? 'Sonnet+Opus+Fable' : 'Haiku');

function stats(v: number[]): string {
  if (v.length === 0) {
    return 'n=0';
  }
  const s = [...v].sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
  return `n=${s.length} min ${(s[0] as number).toFixed(1)} median ${(med as number).toFixed(1)} max ${(s[s.length - 1] as number).toFixed(1)}`;
}

interface Cell {
  model: string;
  cell: string;
  method: string | null;
  main: string;
  resumes: string[];
  summary: Json;
}

const cells: Cell[] = [];
for (const idx of process.argv.slice(2)) {
  const rows = JSON.parse(readFileSync(idx, 'utf8')) as Json[];
  const sums = JSON.parse(readFileSync(idx.replace(/\.json$/, '.summary.json'), 'utf8')) as Json[];
  for (const r of rows) {
    if (!r.main) {
      continue;
    }
    const s = sums.find((x) => x.main === r.main) ?? {};
    cells.push({ model: String(r.model), cell: String(r.cell), method: (s.method as string | null) ?? null, main: String(r.main), resumes: Object.values((r.resumes ?? {}) as Record<string, string>), summary: s });
  }
}
const out: string[] = [`# Proof 23 aggregate over ${process.argv.slice(2).join(', ')}`, ''];

// A
out.push('## A. When a reply\'s entries reach the transcript (ms, first reply line minus the signal)', '');
for (const g of ['Sonnet+Opus+Fable', 'Haiku']) {
  const blk: number[] = [];
  const stop: number[] = [];
  for (const c of cells.filter((x) => group(x.model) === g)) {
    const sig = c.summary.signals as Record<string, number | null> | undefined;
    const line = sig?.['first reply line in transcript'];
    if (sig && typeof line === 'number') {
      if (typeof sig['first SDK assistant block'] === 'number') {
        blk.push(line - sig['first SDK assistant block']);
      }
      if (typeof sig.message_stop === 'number') {
        stop.push(line - sig.message_stop);
      }
    }
  }
  out.push(`${g}: after the first block completed (SDK assistant message): ${stats(blk)}`);
  out.push(`${g}: after message_stop: ${stats(stop)}`, '');
}

// B
out.push('## B. signature_delta to the next block\'s start (ms, main thread, every step of every main run)', '');
const gaps = new Map<string, number[]>();
for (const c of cells) {
  let sig: number | undefined;
  for (const e of readJsonl(join(c.main, 'commit-events.jsonl'))) {
    if (e.src !== 'sdk' || (e.parent ?? null) !== null) {
      continue;
    }
    if (e.kind === 'stream:content_block_delta' && e.delta === 'signature_delta') {
      sig = e.ms;
    }
    if (e.kind === 'stream:content_block_start' && (e.block === 'text' || e.block === 'tool_use') && sig !== undefined) {
      gaps.set(c.model, [...(gaps.get(c.model) ?? []), e.ms - sig]);
      sig = undefined;
    }
  }
}
for (const [m, v] of gaps) {
  out.push(`${m}: ${stats(v)}; over 50 ms: ${v.filter((x) => x > 50).length}`);
}
out.push('');

// C
out.push('## C. After interrupt(): stream events still delivered, and the first write (ms after the stop)', '');
for (const c of cells.filter((x) => x.method === 'interrupt')) {
  const ev = readJsonl(join(c.main, 'commit-events.jsonl'));
  const stop = ev.find((e) => e.src === 'proof' && e.kind === 'stop');
  const next = ev.find((e) => e.src === 'proof' && e.kind === 'send' && e.step === 2)?.ms ?? Infinity;
  if (!stop) {
    out.push(`${c.model} ${c.cell}: no stop issued (${c.main})`);
    continue;
  }
  const after = ev.filter((e) => e.ms > stop.ms && e.ms < next && e.src === 'sdk' && e.kind.startsWith('stream:') && (e.parent ?? null) === null);
  const deltas = after.filter((e) => e.kind === 'stream:content_block_delta');
  const write = ev.find((e) => e.ms > stop.ms && e.src === 'transcript' && e.kind === 'line' && (e.entry as Json).uuid);
  const last = after[after.length - 1];
  out.push(`${c.model} ${c.cell} ${c.main.slice(-38)}: ${after.length} stream events after the stop (${deltas.length} deltas, ${deltas.reduce((n, e) => n + Number(e.len ?? 0), 0)} chars, last +${last ? (last.ms - stop.ms).toFixed(1) : '0'}); first write +${write ? (write.ms - stop.ms).toFixed(1) : '-'}`);
}
out.push('');

// D
out.push('## D. Signals against Claude Code\'s own writes (ms; negative = before the write)', '');
const PROMPT_SIGNALS = ['UserPromptSubmit hook', 'prompt entry in store', 'request file (mtime)', 'request file (seen)', 'message_start', 'first reply line in transcript'];
const REPLY_SIGNALS = ['first SDK assistant block', 'message_stop', 'response file', 'index.jsonl line', 'first reply entry in store', 'MessageDisplay final', 'Stop hook', 'result', 'stop issued'];
for (const g of ['Sonnet+Opus+Fable', 'Haiku']) {
  const pr = new Map<string, number[]>();
  const rp = new Map<string, number[]>();
  const ri = new Map<string, number[]>();
  for (const c of cells.filter((x) => group(x.model) === g)) {
    const sig = (c.summary.signals ?? {}) as Record<string, number | null>;
    const p = c.summary.promptRef as number | null;
    const r = c.summary.replyRef as number | null;
    for (const k of PROMPT_SIGNALS) {
      if (typeof p === 'number' && typeof sig[k] === 'number') {
        pr.set(k, [...(pr.get(k) ?? []), (sig[k] as number) - p]);
      }
    }
    const into = c.method === 'interrupt' ? ri : rp;
    for (const k of REPLY_SIGNALS) {
      if (typeof r === 'number' && typeof sig[k] === 'number') {
        into.set(k, [...(into.get(k) ?? []), (sig[k] as number) - r]);
      }
    }
  }
  out.push(`### ${g}`, '', 'against the prompt\'s transcript line:');
  for (const [k, v] of pr) {
    out.push(`  ${k.padEnd(32)} ${stats(v)}`);
  }
  out.push('against the first reply transcript line, cells not stopped by interrupt():');
  for (const [k, v] of rp) {
    out.push(`  ${k.padEnd(32)} ${stats(v)}`);
  }
  out.push('against the first reply transcript line, interrupt() cells:');
  for (const [k, v] of ri) {
    out.push(`  ${k.padEnd(32)} ${stats(v)}`);
  }
  out.push('');
}

// E
out.push('## E. After an SDK abort: transcript writes and store appends (ms after the stop), entries the store missed, and whether the reply finished before SIGTERM', '');
for (const c of cells.filter((x) => x.method === 'abort')) {
  const ev = readJsonl(join(c.main, 'commit-events.jsonl'));
  const stop = ev.find((e) => e.src === 'proof' && e.kind === 'stop');
  if (!stop) {
    out.push(`${c.model} ${c.cell}: no stop issued (${c.main})`);
    continue;
  }
  const writes = ev.filter((e) => e.ms > stop.ms && e.src === 'transcript' && e.kind === 'line' && (e.entry as Json).uuid);
  const appends = ev.filter((e) => e.ms > stop.ms && e.src === 'store' && e.kind === 'append');
  const replyEnd = writes.find((e) => (e.entry as Json).type === 'assistant' && (e.entry as Json).stop_reason);
  out.push(`${c.model} ${c.cell} ${c.main.slice(-38)}: writes [${writes.map((e) => (e.ms - stop.ms).toFixed(0)).join(', ')}] appends [${appends.map((e) => (e.ms - stop.ms).toFixed(0)).join(', ')}] store missed ${String(c.summary.missingFromStore)}; reply written ${replyEnd ? `at +${(replyEnd.ms - stop.ms).toFixed(0)} (${(replyEnd.ms - stop.ms) < 2000 ? 'before' : 'after'} the 2.000 s SIGTERM)` : 'never'}`);
}
out.push('');

// F
out.push('## F. Signal counts over every run (main and resumes)', '');
const counts = new Map<string, number>();
for (const c of cells) {
  for (const dir of [c.main, ...c.resumes]) {
    for (const e of readJsonl(join(dir, 'commit-events.jsonl'))) {
      const key = e.src === 'hook' ? `hook ${e.kind}` : e.src === 'sdk' && (e.kind.startsWith('system:') || e.kind === 'result') ? `sdk ${e.kind}${e.kind === 'result' ? ` ${String(e.subtype)}` : ''}` : undefined;
      if (key && e.kind !== 'system:thinking_tokens' && e.kind !== 'system:status') {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
}
for (const [k, v] of [...counts].sort()) {
  out.push(`  ${k}: ${v}`);
}
out.push(`  sdk system:session_state_changed: ${counts.get('sdk system:session_state_changed') ?? 0}`);
process.stdout.write(`${out.join('\n')}\n`);
