// Minimum entries: variant by model, from one or more plans' compare.json
// (compare.mts). A cell counts the pickups where the variant's request is
// the base's ("same"), and names each difference class (M<n>, from that
// plan's classes.txt) with where it occurs. With a second run
// (compare-out2.json, run.mts CR_OUT=out2), a pickup whose two runs
// disagree is counted as unstable instead.
//
//   node proofs/minimum-entries/summary.mts <out-file> <plan-dir> [...]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

type Json = Record<string, unknown>;

const outFile = process.argv[2];
const plans = process.argv.slice(3).map((p) => resolve(p));
if (!outFile || plans.length === 0) {
  process.stderr.write('usage: summary.mts <out-file> <plan-dir> [...]\n');
  process.exit(2);
}

const short = (m: string): string => m.replace('claude-', '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-(\d)$/, ' $1');
interface Cell {
  same: number;
  sameC: number;
  diffs: Map<string, string[]>;
  unstable: string[];
  missing: string[];
}
const table = new Map<string, Map<string, Cell>>();
const models = new Set<string>();
for (const plan of plans) {
  const rows = JSON.parse(readFileSync(join(plan, 'compare.json'), 'utf8')) as Json[];
  const second = existsSync(join(plan, 'compare-out2.json')) ? (JSON.parse(readFileSync(join(plan, 'compare-out2.json'), 'utf8')) as Json[]) : undefined;
  const tag = basename(plan);
  for (const [i, r] of rows.entries()) {
    const model = short(String(r.model));
    models.add(model);
    const cells = r.cells as Record<string, Json>;
    const cells2 = second ? ((second[i] as Json).cells as Record<string, Json>) : undefined;
    const where = `${tag}:${String(r.scenario)}/${String(r.point)}`;
    for (const [name, c] of Object.entries(cells)) {
      if (name === 'base') {
        continue;
      }
      let row = table.get(name);
      if (!row) {
        row = new Map();
        table.set(name, row);
      }
      let cell = row.get(model);
      if (!cell) {
        cell = { same: 0, sameC: 0, diffs: new Map(), unstable: [], missing: [] };
        row.set(model, cell);
      }
      if (!c.vsBase) {
        cell.missing.push(`${where}(${String(c.status)})`);
        continue;
      }
      const c2 = cells2?.[name];
      const key = (x: Json | undefined): string => (x?.vsBase === 'diff' ? `diff:${JSON.stringify(x.detail)}` : String(x?.vsBase));
      if (c2 && c2.vsBase && key(c2) !== key(c)) {
        cell.unstable.push(where);
        continue;
      }
      if (c.vsBase === 'same') {
        cell.same += 1;
      } else if (c.vsBase === 'same~c') {
        cell.sameC += 1;
      } else {
        const k = `${tag}/${String(c.class)}`;
        cell.diffs.set(k, [...(cell.diffs.get(k) ?? []), `${String(r.scenario)}/${String(r.point)}`]);
      }
    }
  }
}
const ms = [...models];
const out: string[] = [];
out.push(`# variant | ${ms.join(' | ')}`);
out.push('# same N = same request as the full holding at N pickups; ~c = same apart from the compaction summary;');
out.push('# <plan>/M<n>[pickups] = differs, class in that plan\'s classes.txt; unstable = two runs disagree; missing = no request');
for (const [name, row] of [...table].sort(([a], [b]) => a.localeCompare(b))) {
  const parts = ms.map((m) => {
    const c = row.get(m);
    if (!c) {
      return '-';
    }
    const bits: string[] = [];
    if (c.same > 0) {
      bits.push(`same ${c.same}`);
    }
    if (c.sameC > 0) {
      bits.push(`~c ${c.sameC}`);
    }
    for (const [k, w] of c.diffs) {
      bits.push(`${k}[${w.join(',')}]`);
    }
    if (c.unstable.length > 0) {
      bits.push(`unstable[${c.unstable.join(',')}]`);
    }
    if (c.missing.length > 0) {
      bits.push(`missing[${c.missing.join(',')}]`);
    }
    return bits.join('; ');
  });
  out.push(`${name} | ${parts.join(' | ')}`);
}
writeFileSync(outFile, `${out.join('\n')}\n`);
process.stdout.write(`${table.size} variants -> ${outFile}\n`);
