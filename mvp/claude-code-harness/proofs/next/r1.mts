// Proof 24: R1, how soon each option commits each entry after Claude Code
// writes it to its transcript. Offline, over proof 23's runs, which watched
// the transcript file (5 ms poll) and the store side by side.
//
// Options (when each conversation entry of the ended query is committed):
//   write   the store append that carries it (eager flush)
//   result  the SDK's result message for the query
//   hybrid  the store append, except an assistant entry whose blocks are all
//           thinking: held until an entry of the same message.id with a
//           block that isn't thinking is appended (then committed), or the
//           query's result (then left out: Claude Code never sends it). API
//           error entries are known at their append never to be sent.
//   next    the next query's request file
//
//   node proofs/next/r1.mts <proof-23 runs dir>

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from './history.mts';

const CELLS = new Set(['normal', 'thinking-only', 'thinking-only-limit', 'retry', 'first-byte:interrupt', 'thinking:interrupt', 'after-thinking:interrupt', 'mid-text:interrupt', 'tool-input:interrupt', 'tool-exec:interrupt']);

function lines(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

const onlyThinking = (content: unknown): boolean => Array.isArray(content) && content.length > 0 && (content as Json[]).every((b) => b.type === 'thinking' || b.type === 'redacted_thinking');

interface Row {
  model: string;
  cell: string;
  entry: string;
  write: number; // store append minus transcript line, ms
  result: number;
  hybrid: number | null; // null: never committed (left out)
  next: number | null;
}

function main(): void {
  const [runsDir] = process.argv.slice(2);
  if (!runsDir) {
    process.stderr.write('usage: node proofs/next/r1.mts <proof-23 runs dir>\n');
    process.exit(2);
  }
  const summaries = readdirSync(runsDir)
    .filter((f) => f.endsWith('.summary.json'))
    .flatMap((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as Json[])
    .filter((s) => CELLS.has(String(s.cell)));
  const rows: Row[] = [];
  for (const s of summaries) {
    const plan = JSON.parse(readFileSync(join(String(s.main), 'commit-plan.json'), 'utf8')) as Json;
    const ev = lines(join(String(plan.rawDir), 'commit-events.jsonl'));
    const send1 = ev.find((e) => e.src === 'proof' && e.kind === 'send' && e.step === 1);
    const send2 = ev.find((e) => e.src === 'proof' && e.kind === 'send' && e.step === 2);
    if (!send1 || !send2) {
      continue;
    }
    const inStep = (e: Json): boolean => Number(e.ms) > Number(send1.ms) && Number(e.ms) < Number(send2.ms);
    const result = ev.find((e) => e.src === 'sdk' && e.kind === 'result' && inStep(e));
    if (!result) {
      continue;
    }
    const next = ev.find((e) => e.src === 'bodies' && e.kind === 'request' && Number(e.ms) > Number(send2.ms) && String(e.model).startsWith(String(s.model)) && (e.thread !== null || Number(e.tools) > 0));
    const lineAt = new Map<string, { ms: number; entry: Json }>();
    for (const e of ev.filter((x) => x.src === 'transcript' && x.kind === 'line' && inStep(x))) {
      const en = e.entry as Json;
      if (typeof en.uuid === 'string' && (en.type === 'user' || en.type === 'assistant')) {
        lineAt.set(en.uuid, { ms: Number(e.ms), entry: en });
      }
    }
    const appendAt = new Map<string, number>();
    const appends = ev.filter((x) => x.src === 'store' && x.kind === 'append' && inStep(x));
    for (const a of appends) {
      for (const en of a.entries as Json[]) {
        if (typeof en.uuid === 'string' && !appendAt.has(en.uuid)) {
          appendAt.set(en.uuid, Number(a.ms));
        }
      }
    }
    for (const [uuid, { ms, entry }] of lineAt) {
      const w = appendAt.get(uuid);
      if (w === undefined) {
        continue;
      }
      let hybrid: number | null = w - ms;
      if (entry.type === 'assistant' && onlyThinking((entry.content as Json[] | undefined)?.map((b) => ({ type: b.type }))) && entry.isApiErrorMessage !== true) {
        // Held until a sibling with a non-thinking block is appended.
        const sibling = appends.find((a) => (a.entries as Json[]).some((x) => x.type === 'assistant' && x.msgId === entry.msgId && !onlyThinking((x.content as Json[] | undefined)?.map((b) => ({ type: b.type })))));
        hybrid = sibling ? Math.max(Number(sibling.ms), w) - ms : null;
      }
      const brief = `${String(entry.type)}${entry.isApiErrorMessage ? ' api-error' : ''}${entry.isAbortedMidStream ? ' partial' : ''} ${(entry.content as Json[] | undefined)?.map((b) => b.type).join('+') ?? ''}`;
      rows.push({ model: String(s.model), cell: String(s.cell), entry: brief, write: w - ms, result: Number(result.ms) - ms, hybrid, next: next ? Number(next.ms) - ms : null });
    }
  }
  // Summary per cell and entry kind: median and max per option.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.cell} | ${r.entry.replace(/\(.*$/, '')}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const stat = (v: number[]): string => {
    if (v.length === 0) {
      return '-';
    }
    const s = [...v].sort((a, b) => a - b);
    return `${s[Math.floor(s.length / 2)]?.toFixed(1)} / ${s[s.length - 1]?.toFixed(1)}`;
  };
  process.stdout.write('cell | entry | n | write (median / max ms after transcript line) | result | hybrid (left out) | next\n');
  for (const [k, g] of [...groups].sort()) {
    const h = g.filter((r) => r.hybrid !== null).map((r) => r.hybrid as number);
    process.stdout.write(`${k} | ${g.length} | ${stat(g.map((r) => r.write))} | ${stat(g.map((r) => r.result))} | ${stat(h)} (${g.length - h.length}) | ${stat(g.filter((r) => r.next !== null).map((r) => r.next as number))}\n`);
  }
}

main();
