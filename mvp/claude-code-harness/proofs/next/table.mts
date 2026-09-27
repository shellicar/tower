// Proof 24: tabulate analysed runs (analyse.mts output, JSON lines) as
// scenario by way, one line per run.
//
//   node proofs/next/table.mts <analysis.jsonl> [...] > runs/p24-table.md

import { readFileSync } from 'node:fs';
import type { Json } from './history.mts';

function cacheVerdict(w: Json, L: Json | null): string {
  if (!w.T) {
    return 'no resume';
  }
  const T = w.T as Json;
  const tu = T.usage as Json | null;
  if (!tu) {
    return 'resume got no usage';
  }
  const lu = (L?.usage as Json | null) ?? null;
  const diff = (w.requestDiff as string[] | undefined) ?? [];
  const adds = (w.resumeAdds as string[] | undefined) ?? [];
  const nums = `T ${String(tu.cache_read_input_tokens)}r/${String(tu.cache_creation_input_tokens)}w`;
  if (!lu) {
    const req = diff.length === 0 ? 'SAME request' : `differs${adds.length ? ` [${adds.join('; ')}]` : ''} ${diff.slice(0, 2).join(' | ').slice(0, 160)}`;
    return `${req}; L got no usage (its request failed too); ${nums}`;
  }
  const lnums = `L ${String(lu.cache_read_input_tokens)}r/${String(lu.cache_creation_input_tokens)}w`;
  if (diff.length === 0) {
    const same = Number(tu.cache_read_input_tokens) === Number(lu.cache_read_input_tokens) + Number(lu.cache_creation_input_tokens) && Number(tu.cache_creation_input_tokens) === 0;
    return `${same ? 'SAME request, cache read all' : 'SAME request, cache differs'} (${lnums}, ${nums})`;
  }
  return `differs${adds.length ? ` [${adds.join('; ')}]` : ''} (${lnums}, ${nums}) ${diff.slice(0, 2).join(' | ').slice(0, 160)}`;
}

function main(): void {
  const rows = process.argv
    .slice(2)
    .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== ''))
    .map((l) => JSON.parse(l) as Json)
    .filter((r) => !r.error && !r.failed);
  const order = ['normal', 'thinking-only', 'limit', 'api-error', 'first-byte', 'thinking', 'mid-text', 'tool-input', 'tool-exec'];
  rows.sort((a, b) => String(a.model).localeCompare(String(b.model)) || order.indexOf(String(a.cell)) - order.indexOf(String(b.cell)));
  const out: string[] = [];
  for (const r of rows) {
    out.push(`### ${String(r.model)} ${String(r.cell)}: ${String(r.stopped)}`);
    out.push(`main ${String(r.main)}; store appends after result: ${JSON.stringify(r.lateAppends)}; Stop/StopFailure before result: ${JSON.stringify(r.hooksInStep)}`);
    out.push('');
    out.push('| way | at (ms after result) | history | cache (resume vs L) | vs full-record resume | resume |');
    out.push('|---|---|---|---|---|---|');
    for (const w of r.ways as Json[]) {
      const h = w.history === undefined ? 'no probe' : `${String(w.history)}${(w.missing as string[])?.length ? `; missing ${(w.missing as string[]).join(', ')}` : ''}${(w.extra as string[])?.length ? `; extra ${(w.extra as string[]).join(', ')}` : ''}`;
      const vs = Array.isArray(w.vsStoreResume) ? ((w.vsStoreResume as string[]).length === 0 ? 'same' : `differs: ${(w.vsStoreResume as string[]).slice(0, 2).join(' | ').slice(0, 140)}`) : String(w.vsStoreResume ?? '');
      out.push(`| ${String(w.way)} | ${Number(w.atMs).toFixed(1)} | ${h.replace(/\|/g, '/')} | ${cacheVerdict(w, r.L as Json | null).replace(/\|/g, '/')} | ${vs.replace(/\|/g, '/')} | ${String(w.resume ?? '').replace(/^.*\/runs\//, 'runs/')} |`);
    }
    out.push('');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

main();
