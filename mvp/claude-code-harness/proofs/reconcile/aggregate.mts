// Reconcile: option by ending, per model, from offline.mts or analyse.mts
// output (JSON lines). Counts only runs that reached their ending.
//
//   node proofs/reconcile/aggregate.mts <jsonl> [...]

import { readFileSync } from 'node:fs';
import type { Json } from './holding.mts';

export function reached(r: Json): boolean {
  const e = r.ending as Json;
  switch (e.cell) {
    case 'normal':
      return e.keptReply === true;
    case 'thinking-only':
      return Number(e.droppedThinking) > 0 && e.keptReply !== true;
    case 'limit':
    case 'api-error':
      return Number(e.apiErrors) > 0;
    default:
      return e.stopped !== null && e.stopped !== 'after the result';
  }
}

const rows = process.argv.slice(2).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Json)).filter((r) => !r.error && r.ending);
const key = (field: 'final' | 'atResult') => (o: Json): string => ((o[field] as Json | undefined)?.kinds as string[] | undefined)?.join('+') ?? 'n/a';
const models = [...new Set(rows.map((r) => String(r.model)))].sort();
const cells = [...new Set(rows.map((r) => String((r.ending as Json).cell)))];
const options = Object.keys((rows[0]?.options as Json) ?? {});
for (const field of ['final', 'atResult'] as const) {
  console.log(`\n## ${field}`);
  for (const opt of options) {
    console.log(`\n### ${opt}\n\n| ending | ${models.join(' | ')} |\n|---|${models.map(() => '---').join('|')}|`);
    for (const c of cells) {
      const cols = models.map((m) => {
        const rs = rows.filter((r) => r.model === m && (r.ending as Json).cell === c && reached(r));
        if (rs.length === 0) return '-';
        const counts = new Map<string, number>();
        for (const r of rs) {
          const k = key(field)((r.options as Json)[opt] as Json);
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return [...counts].map(([k, n]) => `${k}×${n}`).join(' ');
      });
      console.log(`| ${c} | ${cols.join(' | ')} |`);
    }
  }
}
console.log('\n## R1 (user side: commit minus store append, ms, median of medians / max of maxes)');
for (const opt of options) {
  const line = models.map((m) => {
    const rs = rows.filter((r) => r.model === m && reached(r));
    const med = rs.map((r) => Number((((r.options as Json)[opt] as Json).r1 as Json as { userSide: Json }).userSide.median)).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    const mx = Math.max(...rs.map((r) => Number((((r.options as Json)[opt] as Json).r1 as Json as { userSide: Json }).userSide.max)).filter((x) => !Number.isNaN(x)));
    return `${m}: ${med[Math.floor(med.length / 2)]}/${mx}`;
  });
  console.log(`${opt}: ${line.join('  ')}`);
}
