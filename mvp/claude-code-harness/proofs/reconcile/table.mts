// Reconcile: the per-ending table from analyse.mts output. For each option,
// ending by model, every run that reached its ending as
// `after/at-result/resume`:
//   after      tower once the probe's run is committed, against the probe's
//              request (the next query)
//   at-result  tower at step 1's result, against the next query less the
//              probe's own entries (what a resume there has to rebuild)
//   resume     a resume from tower at step 1's result against Claude Code's
//              own continuation (L): OK same request and cache; REQ same
//              request, no usage to compare (L failed); REQ,cache±N same
//              request, cache differs; DIFF different request
// History kinds: = exact; nl newline only; grp grouping only; plc placement;
// cnt content differs; mis entries missing; ext entries tower has and the
// next query doesn't.
//
//   node proofs/reconcile/table.mts <analysis.jsonl> [...] > table.md

import { readFileSync } from 'node:fs';
import { reached } from './ending.mts';
import type { Json } from './holding.mts';

const SHORT: Record<string, string> = { exact: '=', newline: 'nl', grouping: 'grp', placement: 'plc', content: 'cnt', missing: 'mis', extra: 'ext' };
const kinds = (v: Json | undefined): string => (v ? ((v.kinds as string[]) ?? []).map((k) => SHORT[k] ?? k).join('+') : '?');
const resume = (v: Json | undefined): string => {
  if (!v) {
    return '?';
  }
  const s = String(v.verdict);
  if (s !== 'DIFF') {
    return s;
  }
  const adds = (v.adds as string[] | undefined) ?? [];
  return adds.some((a) => a.includes('No response')) ? 'DIFF(NRR)' : 'DIFF';
};

const rows = process.argv
  .slice(2)
  .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== ''))
  .map((l) => JSON.parse(l) as Json)
  .filter((r) => !r.error && !r.failed && r.ending);
const models = [...new Set(rows.map((r) => String(r.model)))].sort();
const ENDINGS = ['normal', 'thinking-only', 'limit', 'api-error', 'first-byte', 'thinking', 'mid-text', 'tool-input', 'tool-exec'];
const OPTIONS: [string, string][] = [
  ['record', 'control: Claude Code\'s own record at the result (proof 24 H), resumeSessionAt'],
  ['entry', 'each entry as written, at its store append'],
  ['request', 'as received, per request, when its body and entries are in'],
  ['run', 'as received, per run, when its kept reply is in; a tail waits'],
  ['run+last', 'as run; a tail at a query end committed in its last request\'s form'],
  ['run+entry', 'as run; a tail at a query end committed as written'],
  ['next', 'as run, committed when the next query\'s request appears'],
];
const out: string[] = [];
out.push(`Runs per model that reached each ending, and the runs in total: ${models.map((m) => `${m} ${rows.filter((r) => r.model === m && reached(r)).length}/${rows.filter((r) => r.model === m).length}`).join(', ')}.`);
out.push('');
for (const [opt, label] of OPTIONS) {
  out.push(`### ${opt}: ${label}`);
  out.push('');
  out.push(`| ending | ${models.map((m) => m.replace('claude-', '')).join(' | ')} |`);
  out.push(`|---|${models.map(() => '---').join('|')}|`);
  for (const e of ENDINGS) {
    const cells = models.map((m) => {
      const rs = rows.filter((r) => r.model === m && (r.ending as Json).cell === e && reached(r));
      if (rs.length === 0) {
        return 'not reached';
      }
      const counts = new Map<string, number>();
      for (const r of rs) {
        const o = ((r.options as Json)[opt] as Json | undefined) ?? {};
        const hist = opt === 'record' ? '' : `${kinds(o.final as Json | undefined)}/${kinds(o.atResult as Json | undefined)}/`;
        const k = `${hist}${resume(((r.resumes as Json) ?? {})[opt] as Json | undefined)}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
    });
    out.push(`| ${e} | ${cells.join(' | ')} |`);
  }
  out.push('');
}
out.push('### R1: user-side entries, commit instant minus store append (ms), per model: median of run medians / largest');
out.push('');
out.push(`| option | ${models.map((m) => m.replace('claude-', '')).join(' | ')} |`);
out.push(`|---|${models.map(() => '---').join('|')}|`);
for (const [opt] of OPTIONS.slice(1)) {
  const cells = models.map((m) => {
    const rs = rows.filter((r) => r.model === m && reached(r)).map((r) => ((r.options as Json)[opt] as Json).r1 as Json);
    const med = rs.map((x) => Number((x.userSide as Json).median)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const mx = Math.max(...rs.map((x) => Number((x.userSide as Json).max)).filter((x) => Number.isFinite(x)));
    const never = rs.reduce((a, x) => a + Number(x.neverCommitted), 0);
    return `${med[Math.floor(med.length / 2)] ?? '?'} / ${Number.isFinite(mx) ? mx : '?'}${never ? ` (${never} never)` : ''}`;
  });
  out.push(`| ${opt} | ${cells.join(' | ')} |`);
}
out.push('');
out.push(`Form source: the body's form of a closed run against proof 16's fold prediction (by-fold.mts), runs matching per model: ${models.map((m) => {
  const xs = rows.filter((r) => r.model === m).map((r) => String(r.foldMatchesBody).split('/').map(Number));
  return `${m} ${xs.reduce((a, x) => a + (x[0] ?? 0), 0)}/${xs.reduce((a, x) => a + (x[1] ?? 0), 0)}`;
}).join(', ')}.`);
process.stdout.write(`${out.join('\n')}\n`);
