// Reconcile: the resumes with and without the two carriers tower doesn't
// have (run.mts with RC_BARE=1), per run.
//
//   node proofs/reconcile/bare.mts <analysis.jsonl>

import { readFileSync } from 'node:fs';
import { reached } from './ending.mts';
import type { Json } from './holding.mts';

const rows = readFileSync(process.argv[2] as string, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json);
const ways = ['record', 'entry', 'entry/bare-previous', 'entry/bare-raw', 'run+last', 'run+last/bare-previous', 'run+last/bare-raw', 'run+entry', 'run+entry/bare-previous', 'run+entry/bare-raw'];
const models = [...new Set(rows.map((r) => String(r.model)))].sort();
const cells = ['normal', 'first-byte', 'mid-text', 'tool-exec', 'limit', 'api-error'];
for (const w of ways) {
  process.stdout.write(`\n### ${w}\n\n| ending | ${models.map((m) => m.replace('claude-', '')).join(' | ')} |\n|---|${models.map(() => '---').join('|')}|\n`);
  for (const c of cells) {
    const cols = models.map((m) => {
      const r = rows.find((x) => x.model === m && x.cell === c);
      if (!r) {
        return '-';
      }
      if (!reached(r)) {
        return 'not reached';
      }
      const v = (r.resumes as Json)[w] as Json | undefined;
      if (!v) {
        return '?';
      }
      return v.verdict === 'DIFF' ? `DIFF: ${String(((v.diff as string[]) ?? [])[0] ?? '').slice(0, 70).replace(/\|/g, '/')}` : String(v.verdict);
    });
    process.stdout.write(`| ${c} | ${cols.join(' | ')} |\n`);
  }
}
