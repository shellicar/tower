// Proof 24, offline: score each way against proof 23's recorded runs.
//
// For every interrupt, normal, thinking-only, limit and API-error cell that
// proof 23 kept, it takes what each way would hold when the cell's query
// ended (its `result`), and compares it block by block with the history of
// Claude Code's actual next query (the probe's request, rebuilt through
// `continue` from the body log).
//
// Inputs are proof 23's raw copies (outside the repo: store appends, body
// log, commit events, unredacted) and its run directories (SDK messages).
//
//   node proofs/next/offline.mts <proof-23 runs dir> [out.jsonl]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Blk, Json } from './history.mts';
import { compareBlocks, entryBlocks, fullHistory, nextQueryBlocks, readIndex } from './history.mts';
import { fold, sdkEventBlocks, sdkReader } from './ways.mts';

const CELLS = new Set(['normal', 'thinking-only', 'thinking-only-limit', 'retry', 'first-byte:interrupt', 'thinking:interrupt', 'after-thinking:interrupt', 'mid-text:interrupt', 'tool-input:interrupt', 'tool-exec:interrupt']);

export function tsMs(ts: string): number {
  // 2026-09-26T20:14:11.533123Z: milliseconds plus the microseconds stamp() adds.
  const m = /^(.*T\d\d:\d\d:\d\d\.\d{3})(\d{0,3})Z$/.exec(ts);
  if (!m) {
    return Date.parse(ts);
  }
  return Date.parse(`${m[1]}Z`) + (m[2] ? Number(m[2].padEnd(3, '0')) / 1000 : 0);
}

function lines(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

interface WayOut {
  way: string;
  at: number | null; // ms after the query's result; null = never commits for this ending
  equal?: boolean;
  exact?: boolean;
  missing?: string[];
  extra?: string[];
  note?: string;
}

async function analyse(summary: Json): Promise<Json | undefined> {
  const mainDir = String(summary.main);
  const plan = JSON.parse(readFileSync(join(mainDir, 'commit-plan.json'), 'utf8')) as Json;
  const rawDir = String(plan.rawDir);
  const steps = plan.steps as string[];
  const probe = steps[2];
  if (!probe) {
    return undefined;
  }
  const events = lines(join(rawDir, 'commit-events.jsonl'));
  const sendTs = (step: number): number | undefined => {
    const e = events.find((x) => x.src === 'proof' && x.kind === 'send' && x.step === step);
    return e ? tsMs(String(e.ts)) : undefined;
  };
  const send1 = sendTs(1);
  const send2 = sendTs(2);
  if (send1 === undefined || send2 === undefined) {
    return { cell: summary.cell, model: summary.model, main: mainDir, skipped: 'step 1 or 2 never sent' };
  }
  const inStep1 = (e: Json): boolean => tsMs(String(e.ts)) > send1 && tsMs(String(e.ts)) < send2;
  const result = events.find((e) => e.src === 'sdk' && e.kind === 'result' && inStep1(e));
  if (!result) {
    return { cell: summary.cell, model: summary.model, main: mainDir, skipped: 'no result in step 1' };
  }
  const end = tsMs(String(result.ts));
  const stop = events.find((e) => e.src === 'proof' && e.kind === 'stop' && inStep1(e));
  const stopHook = events.find((e) => e.src === 'hook' && (e.kind === 'Stop' || e.kind === 'StopFailure') && inStep1(e));

  // Store appends (main session only), each with its time.
  const appends = lines(join(rawDir, 'store-appends.jsonl')).filter((a) => !(a.key as Json).subpath);
  const sessionId = String((appends[0]?.key as Json | undefined)?.sessionId ?? '');
  const entriesUntil = (t: number): Json[] => appends.filter((a) => tsMs(String(a.ts)) <= t).flatMap((a) => a.entries as Json[]);
  const step1Appends = appends.filter((a) => inStep1(a));
  const lastStep1Append = step1Appends.length > 0 ? tsMs(String(step1Appends[step1Appends.length - 1]?.ts)) : undefined;

  // Ground truth: the probe's main request (query_source sdk) and its history.
  const bodies = join(rawDir, 'api-bodies');
  const index = readIndex(bodies);
  const reqEvents = events.filter((e) => e.src === 'bodies' && e.kind === 'request' && tsMs(String(e.ts)) > send2);
  let truth: { before: Blk[]; messageShape: string[]; after: Blk[] } | undefined;
  let truthFile: string | undefined;
  let truthChain: string[] = [];
  let truthAt: number | undefined;
  for (const r of reqEvents) {
    const file = String(r.file);
    const line = index.find((l) => l.request_file === file);
    if (line && line.query_source !== 'sdk') {
      continue;
    }
    const body = JSON.parse(readFileSync(join(bodies, file), 'utf8')) as Json;
    if (!String(body.model).startsWith(String(summary.model))) {
      continue;
    }
    const h = fullHistory(bodies, file);
    const nb = nextQueryBlocks(h.messages, probe);
    if (nb) {
      truth = nb;
      truthFile = file;
      truthChain = h.chain;
      truthAt = tsMs(String(r.ts));
      break;
    }
  }
  if (!truth) {
    return { cell: summary.cell, model: summary.model, main: mainDir, skipped: 'no probe request found' };
  }

  const ways: WayOut[] = [];
  const score = (way: string, at: number | null, held: Blk[] | undefined, note?: string): void => {
    if (!held) {
      ways.push({ way, at, note });
      return;
    }
    const c = compareBlocks(held, truth.before);
    ways.push({ way, at, equal: c.equal, exact: c.exact, missing: c.missing, extra: c.extra, note });
  };

  // W1 store as written, at result; and settled (everything step 1 wrote).
  const atResult = entriesUntil(end);
  score('store-at-result', 0, entryBlocks(atResult));
  const settled = entriesUntil(send2 - 0.001);
  score('store-settled', lastStep1Append !== undefined ? Math.max(0, lastStep1Append - end) : 0, entryBlocks(settled), `last step-1 append ${lastStep1Append !== undefined ? (lastStep1Append - end).toFixed(1) : '-'} ms after result`);

  // W2 store plus the fold, at result.
  const f = fold(atResult);
  score('store+fold', 0, entryBlocks(f.kept), f.dropped.length ? `dropped ${f.dropped.map((d) => `${d.rule}:${d.uuid.slice(0, 6)}`).join(',')}` : undefined);

  // W3 the SDK's reader over the store, at result.
  const t0 = performance.now();
  const reader = await sdkReader(sessionId, atResult);
  score('sdk-reader', 0, reader.blocks, `reader ${(performance.now() - t0).toFixed(1)} ms offline`);

  // W4 SDK events up to result.
  const sdk = lines(join(mainDir, 'sdk-messages.jsonl'));
  const stepMsgs = (from: number, to: number): Json[] => sdk.filter((l) => tsMs(String(l.ts)) > from && tsMs(String(l.ts)) <= to).map((l) => l.message as Json);
  const send0 = sendTs(0) ?? 0;
  score('sdk-events', 0, sdkEventBlocks([
    { prompt: String(steps[0]), messages: stepMsgs(send0, send1) },
    { prompt: String(steps[1]), messages: stepMsgs(send1, end) },
  ]));

  // W5 Stop / StopFailure hook, with the store at that instant.
  if (stopHook) {
    const t = tsMs(String(stopHook.ts));
    score(`hook-${String(stopHook.kind)}`, t - end, entryBlocks(entriesUntil(t)));
  } else {
    score('hook-Stop', null, undefined, 'no Stop or StopFailure hook in the step');
  }

  // W6 the next query's own body: exact by construction, at the next query.
  score('next-body', truthAt !== undefined ? truthAt - end : null, truth.before, 'the probe was sent 2.5 s after result (proof 23 quiet period)');

  return {
    cell: summary.cell,
    model: summary.model,
    actual: summary.actual,
    main: mainDir,
    rawDir,
    sessionId,
    stopToResultMs: stop ? end - tsMs(String(stop.ts)) : null,
    truthFile,
    truthChain,
    truthShape: truth.messageShape,
    truthBefore: truth.before.map((b) => b.show),
    ways,
  };
}

async function main(): Promise<void> {
  const [runsDir, out] = process.argv.slice(2);
  if (!runsDir) {
    process.stderr.write('usage: node proofs/next/offline.mts <proof-23 runs dir> [out.jsonl]\n');
    process.exit(2);
  }
  const summaries = readdirSync(runsDir)
    .filter((f) => f.endsWith('.summary.json'))
    .flatMap((f) => JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as Json[]);
  const rows: Json[] = [];
  for (const s of summaries) {
    if (!CELLS.has(String(s.cell))) {
      continue;
    }
    try {
      const r = await analyse(s);
      if (r) {
        rows.push(r);
      }
    } catch (err) {
      rows.push({ cell: s.cell, model: s.model, main: s.main, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const text = rows.map((r) => JSON.stringify(r)).join('\n');
  if (out) {
    writeFileSync(out, `${text}\n`);
  }
  for (const r of rows) {
    const ways = (r.ways as WayOut[] | undefined) ?? [];
    const cells = ways.map((w) => `${w.way}=${w.equal === undefined ? 'none' : w.exact ? 'EXACT' : w.equal ? 'eq~nl' : 'DIFF'}${w.at === null ? '' : `@${w.at.toFixed(0)}`}`);
    process.stdout.write(`${String(r.model).padEnd(18)} ${String(r.cell).padEnd(24)} ${String(r.actual ?? r.skipped ?? r.error ?? '').padEnd(14)} ${cells.join(' ')}\n`);
  }
}

await main();
