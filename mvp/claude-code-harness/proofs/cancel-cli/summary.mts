// One compact summary per cancel-cli run, for checking repetitions against
// each other: what was written after the stop, how Claude Code ended, what a
// resume wrote before anything was sent, what the send wrote before the new
// prompt (and what each entry's parent is), and the messages of the first
// main-thread request after the stop.
//
//   node proofs/cancel-cli/summary.mts <run dir> [<run dir> ...]

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { contentBrief, type Json } from '../cancel/lib.mts';

type Ev = Json & { wall: number; src: string; kind: string };

function brief(content: unknown, n = 60): string {
  const c = contentBrief(content);
  if (!Array.isArray(c)) {
    return '';
  }
  return (c as Json[])
    .map((b) => {
      if (b.type === 'text' || b.type === 'string') {
        return JSON.stringify(String(b.text ?? '').slice(0, n));
      }
      if (b.type === 'tool_use') {
        return `tool_use(${b.name})`;
      }
      if (b.type === 'tool_result') {
        return `tool_result(err=${b.is_error ?? false},${String(b.content).slice(0, n)})`;
      }
      return String(b.type);
    })
    .join('+');
}

function label(e: Json | undefined): string {
  if (!e) {
    return '(not seen written in this run)';
  }
  const kind = [e.type, e.subtype, e.attachment].filter(Boolean).join('/');
  const flags = ['isApiErrorMessage', 'isAbortedMidStream', 'isMeta', 'isSidechain'].filter((k) => e[k] === true).join(',');
  const model = e.model === '<synthetic>' ? ' <synthetic>' : '';
  return `${kind}${model}${flags ? `[${flags}]` : ''} ${e.content ? brief(e.content) : ''}`.trim();
}

export function summarise(dir: string): string {
  const out: string[] = [];
  const events = readFileSync(join(dir, 'cancel-events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Ev);
  const byUuid = new Map<string, Json>();
  for (const e of events) {
    const en = e.entry as Json | undefined;
    if (e.src === 'transcript' && en && typeof en.uuid === 'string') {
      byUuid.set(en.uuid, en);
    }
  }
  const pids = new Map<number, number>();
  for (const e of events) {
    if (e.kind === 'claude-started') {
      pids.set(Number(e.n), Number(e.pid));
    }
  }
  const exits = new Map<number, string>();
  const strace = join(dir, 'strace.txt');
  if (existsSync(strace)) {
    for (const line of readFileSync(strace, 'utf8').split('\n')) {
      for (const [n, pid] of pids) {
        if (line.startsWith(`${pid} `) && line.includes('+++')) {
          exits.set(n, line.slice(line.indexOf('+++')).trim());
        }
      }
    }
  }
  const entryLine = (e: Ev): string => {
    const en = e.entry as Json;
    const sub = String(e.file).includes('subagents') ? 'SUB ' : '';
    if (typeof en.uuid !== 'string') {
      return `      ${sub}(${en.type})`;
    }
    const parent = typeof en.parentUuid === 'string' ? byUuid.get(en.parentUuid) : undefined;
    const lag = typeof en.timestamp === 'string' ? e.wall - Date.parse(en.timestamp) : 0;
    return `      ${sub}${label(en)}  <- parent: ${en.parentUuid ? label(parent) : 'none'}${lag > 1000 ? `  [timestamp ${lag} ms before written]` : ''}`;
  };
  const lines = (from: number, to: number, meta = false): string[] =>
    events
      .filter((e) => e.src === 'transcript' && e.kind === 'line' && e.wall >= from && e.wall < to)
      .filter((e) => meta || typeof (e.entry as Json).uuid === 'string')
      .map(entryLine);

  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as Json;
  const versions = new Set(events.map((e) => (e.entry as Json | undefined)?.version).filter(Boolean));
  out.push(`## ${run.scenario}  (${basename(dir)})  versions: ${[...versions].join(',')}`);
  const err = events.find((e) => e.src === 'drv' && e.kind === 'error');
  if (err) {
    out.push(`   DRIVER ERROR: ${String(err.error).split('\n')[0]}`);
  }
  const stops = events.filter((e) => e.src === 'drv' && ['esc', 'signal', 'kill-pane'].includes(e.kind));
  const says = events.filter((e) => e.src === 'drv' && e.kind === 'say');
  const launches = events.filter((e) => e.src === 'drv' && e.kind === 'launch');
  const readies = events.filter((e) => e.src === 'drv' && e.kind === 'ready');
  const end = events.at(-1)?.wall ?? Infinity;
  for (const s of stops) {
    const nextBoundary = [...says, ...launches].map((e) => e.wall).filter((w) => w > s.wall).sort((a, b) => a - b)[0] ?? end;
    const at = events.filter((e) => e.src === 'drv' && e.kind.startsWith('at-') && e.wall <= s.wall).at(-1);
    out.push(`   STOP ${s.kind}${s.sig ? ` ${s.sig}` : ''} (claude#${s.n})${at ? ` at ${at.kind} ${JSON.stringify({ laterBlockStarted: at.laterBlockStarted, blocks: at.blocks })}` : ''}`);
    const pre = events.filter((e) => e.src === 'drv' && e.kind === 'input-prefilled' && e.wall > s.wall && e.wall < nextBoundary);
    for (const p of pre) {
      out.push(`      input box after the stop held: ${JSON.stringify(String(p.text).slice(0, 60))}`);
    }
    out.push(...lines(s.wall, nextBoundary, true));
    if (s.kind !== 'esc') {
      out.push(`      exit: ${exits.get(Number(s.n)) ?? '(no exit line)'}`);
    }
  }
  for (const r of readies.filter((e) => Number(e.n) > 1)) {
    const next = [...says, ...launches, ...events.filter((e) => e.kind === 'exit-command' || e.kind === 'signal')].map((e) => e.wall).filter((w) => w > r.wall).sort((a, b) => a - b)[0] ?? end;
    const launch = launches.find((e) => e.n === r.n);
    const written = lines(r.wall, next, true);
    out.push(`   RESUME claude#${r.n} ${JSON.stringify(launch?.args)}: written between ready and the next action: ${written.length ? '' : 'nothing'}`);
    out.push(...written);
  }
  const lastSay = says.filter((e) => String(e.text).includes('NEXT')).at(-1);
  if (lastSay) {
    const prompt = events.find((e) => e.src === 'transcript' && e.wall >= lastSay.wall && brief((e.entry as Json).content).includes('Reply with the word NEXT'));
    out.push(`   SEND "NEXT" (claude#${lastSay.n}): written up to and including the prompt:`);
    out.push(...lines(lastSay.wall, (prompt?.wall ?? lastSay.wall) + 1));
    const index = join(dir, 'api-bodies', 'index.jsonl');
    if (existsSync(index)) {
      const reqs = readFileSync(index, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Json)
        .filter((j) => j.query_source === 'repl_main_thread' && Date.parse(String(j.timestamp)) > lastSay.wall);
      const first = reqs[0];
      if (first) {
        const body = JSON.parse(readFileSync(join(dir, 'api-bodies', String(first.request_file)), 'utf8')) as Json;
        const msgs = (body.messages as Json[]).slice(2);
        out.push(`   NEXT REQUEST messages[2..] (${first.request_file}):`);
        msgs.forEach((m, i) => out.push(`      [${i + 2}] ${m.role}: ${brief(m.content, 50)}`));
      }
    }
  }
  return out.join('\n');
}

for (const d of process.argv.slice(2)) {
  console.log(summarise(d));
  console.log('');
}
