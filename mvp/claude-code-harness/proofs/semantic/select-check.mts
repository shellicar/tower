// Offline check of the main-conversation selectors (select.mts) against the
// ground truth Claude Code writes after each successful response:
// index.jsonl's query_source ("sdk" is the main conversation under the SDK).
// A request file with no index line (a failed or aborted attempt) has no
// ground truth there; it is counted separately.
//
// Requests are taken in index.jsonl order (response order), then the
// request files with no index line. A run whose record lacks the entries a
// resume started from (a resume through a store whose load() output wasn't
// kept) is reported as such, not scored: a live participant has those entries.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl, runEntries, sessionIdOf } from './corpus.mts';
import type { ApiMessage, Json } from './form.mts';
import { type Accepted, flatTail, offlinePending, select } from './select.mts';

export interface SelectRow {
  run: string;
  file: string;
  model: string;
  source: string | undefined;
  truth: boolean | undefined;
  incompleteRecord: boolean;
  history: boolean;
  retry: boolean;
  resent: number;
  reason: string;
  prevIdSays: boolean | undefined;
  proof16Says: boolean;
  // A's attribution of what a main request adds: text no entry accounts
  // for, and notes (a trailing newline after the last entry's text, R12).
  uncovered: string[];
  notes: string[];
}

export function selectRun(runDirArg: string): SelectRow[] {
  const runDir = runDirArg.replace(/\/+$/, '');
  const dir = join(runDir, 'api-bodies');
  if (!existsSync(join(dir, 'index.jsonl'))) {
    return [];
  }
  const index = readJsonl(join(dir, 'index.jsonl'));
  const bySource = new Map(index.map((e) => [String(e.request_file), String(e.query_source)]));
  const mainLine = index.find((e) => e.query_source === 'sdk');
  // The model as the body names it (index.jsonl adds a date suffix).
  const mainFile = mainLine ? join(dir, String(mainLine.request_file)) : undefined;
  const mainModel = mainFile && existsSync(mainFile) ? String((JSON.parse(readFileSync(mainFile, 'utf8')) as Json).model) : '';
  const sessionId = sessionIdOf(runDir);
  const { entries, source } = runEntries(runDir, sessionId);
  const incompleteRecord = source === 'store-appends.jsonl' && existsSync(join(runDir, 'store-load.jsonl')) && readJsonl(join(runDir, 'store-load.jsonl')).some((l) => [l.returned, l.count].some((n) => typeof n === 'number' && n > 0));
  const main = entries.filter((e) => e.isSidechain !== true);
  const files = [...index.map((e) => String(e.request_file)).filter((f) => existsSync(join(dir, f))), ...readdirSync(dir).filter((f) => f.endsWith('.request.json') && !bySource.has(f))];
  const accepted: Accepted[] = [];
  const placed = new Set<string>();
  const rows: SelectRow[] = [];
  for (const f of files) {
    const body = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Json & { messages: ApiMessage[]; model: string };
    const src = bySource.get(f);
    const v = select(body, { model: mainModel, main, pending: offlinePending(main, placed), accepted });
    if (v.main) {
      accepted.push({ anchor: v.anchor, tail: flatTail(body) });
      for (const m of v.attribution?.messages ?? []) {
        for (const c of m.ccEntries) {
          placed.add(c.uuid);
        }
      }
    }
    rows.push({ run: runDir, file: f, model: body.model, source: src, truth: src === undefined ? undefined : src === 'sdk', incompleteRecord, history: v.main, retry: v.retry, resent: v.resent, reason: v.reason, prevIdSays: v.prevIdSays, proof16Says: v.proof16Says, uncovered: (v.attribution?.uncovered ?? []).map((u) => u.text), notes: v.attribution?.notes ?? [] });
  }
  return rows;
}

export function selectReport(rows: SelectRow[]): string {
  const out: string[] = [];
  const models = [...new Set(rows.map((r) => r.model.replace(/-\d{8}$/, '')))].sort();
  const tally = (xs: SelectRow[], say: (r: SelectRow) => boolean | undefined): string => {
    const known = xs.filter((r) => r.truth !== undefined);
    const tp = known.filter((r) => r.truth && say(r) === true).length;
    const fn = known.filter((r) => r.truth && say(r) !== true).length;
    const fp = known.filter((r) => !r.truth && say(r) === true).length;
    const tn = known.filter((r) => !r.truth && say(r) !== true).length;
    const undecided = known.filter((r) => say(r) === undefined).length;
    return `main found ${tp}/${tp + fn}, others taken as main ${fp}/${fp + tn}${undecided ? `, no answer ${undecided}` : ''}`;
  };
  const name = (r: SelectRow): string => `${r.run.split('/').slice(-1)[0]}/${r.file.slice(0, 8)}`;
  for (const m of models) {
    const all = rows.filter((r) => r.model.replace(/-\d{8}$/, '') === m);
    const xs = all.filter((r) => !r.incompleteRecord);
    const sources = new Map<string, number>();
    for (const r of xs) {
      sources.set(r.source ?? '(no index line)', (sources.get(r.source ?? '(no index line)') ?? 0) + 1);
    }
    const skipped = all.filter((r) => r.incompleteRecord);
    out.push(`== ${m}: ${xs.length} request file(s) in ${new Set(xs.map((r) => r.run)).size} run(s); sources ${[...sources].map(([s, n]) => `${s} ${n}`).join(', ')}; not scored (record lacks the entries load() returned): ${skipped.length} file(s) in ${new Set(skipped.map((r) => r.run)).size} run(s)`);
    out.push(`   history match:           ${tally(xs, (r) => r.history)}; of the main ones, retries ${xs.filter((r) => r.truth && r.retry).length}, with re-sent blocks cut ${xs.filter((r) => r.truth && r.resent > 0 && !r.retry).length}`);
    const mains = xs.filter((r) => r.truth && r.history && !r.retry);
    const clean = mains.filter((r) => r.uncovered.length === 0);
    out.push(`   A: ${clean.length}/${mains.length} main requests (not retries) fully matched: every block of what they add tied to an entry; ${mains.filter((r) => r.uncovered.length === 0 && r.notes.length > 0).length} of those with only a trailing newline noted`);
    const kinds = new Map<string, number>();
    for (const r of mains) {
      for (const u of r.uncovered) {
        const k = u.replace(/\s+/g, ' ').slice(0, 70);
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
    }
    for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      out.push(`      unmatched x${n}: ${JSON.stringify(k)}`);
    }
    out.push(`   previous_message_id:     ${tally(xs, (r) => r.prevIdSays)}`);
    out.push(`   proof 16 (model+thread): ${tally(xs, (r) => r.proof16Says)}`);
    for (const r of xs.filter((x) => x.truth !== undefined && x.truth !== x.history)) {
      out.push(`   history match WRONG on ${r.source}: ${name(r)}: ${r.reason}`);
    }
    for (const r of xs.filter((x) => x.truth === false && x.prevIdSays)) {
      out.push(`   previous_message_id takes ${r.source} as main: ${name(r)}`);
    }
    for (const r of xs.filter((x) => x.truth === false && x.proof16Says)) {
      out.push(`   proof 16 selector takes ${r.source} as main: ${name(r)}`);
    }
    for (const r of xs.filter((x) => x.truth && x.resent > 0 && !x.retry)) {
      out.push(`   re-sent blocks cut: ${name(r)}: ${r.reason}`);
    }
    for (const r of xs.filter((x) => x.truth === undefined)) {
      out.push(`   no index line: ${name(r)}: history match says ${r.history ? (r.retry ? 'main (retry)' : 'main') : 'other'} (${r.reason})`);
    }
  }
  return `${out.join('\n')}\n`;
}
