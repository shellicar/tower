// Store commit against resume from tower: the rule by pickup matrix from
// compare.json. Each cell compares a rule's request with the pickup's
// primary reference: the live request where the main run sent one (P<s>),
// otherwise OWN@ (Claude Code's own transcript, resumed at its last entry),
// otherwise the first recorded reference (D9's end2: the recorded resume).
// "=" is the same request; "=c" the same apart from the compaction summary
// (model output, "OK" from the fake API); anything else names the
// difference, abbreviated (the full lines are in compare.txt).
//
//   node proofs/commit-resume/matrix.mts <plan-dir>

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Json = Record<string, unknown>;
const RULES = ['R0', 'R0@', 'H', 'H@', 'Hp', 'Hp@', 'Hl', 'Hl@', 'OWN', 'OWN@'];

function short(d: string[]): string {
  // The first differing message line, trimmed.
  const m = d.find((x) => x.startsWith('msg ')) ?? d[0] ?? '';
  return m.replace(/\s+/g, ' ').slice(0, 140);
}

const planDir = resolve(process.argv[2] ?? '');
const rows = JSON.parse(readFileSync(join(planDir, 'compare.json'), 'utf8')) as Json[];
const out: string[] = [];
const patterns = new Map<string, { n: number; where: string[] }>();
out.push(`scenario point ref | ${RULES.join(' | ')}`);
for (const r of rows) {
  const refs = (r.refs as { kind: string }[]).map((x) => x.kind);
  const cellsAll = r.cells as Record<string, Json>;
  const primary = refs.includes('live') ? 'live' : cellsAll['OWN@']?.vs ? 'OWN@' : (refs[0] ?? 'OWN@');
  const cells = r.cells as Record<string, Json>;
  const line: string[] = [];
  for (const rule of RULES) {
    const c = cells[rule];
    if (!c) {
      line.push('-');
      continue;
    }
    if (!c.vs) {
      line.push(String(c.status));
      continue;
    }
    if (rule === primary) {
      line.push('(ref)');
      continue;
    }
    const v = (c.vs as Record<string, unknown>)[primary];
    if (v === undefined) {
      line.push('?');
      continue;
    }
    if (v === 'same') {
      line.push('=');
      continue;
    }
    if ((c.vs as Record<string, unknown>)[`${primary}~masked`] === 'same') {
      line.push('=c');
      continue;
    }
    const s = short(v as string[]);
    const p = patterns.get(s) ?? { n: 0, where: [] };
    p.n += 1;
    p.where.push(`${String(r.scenario)}/${String(r.point)}/${rule}`);
    patterns.set(s, p);
    line.push(`D${[...patterns.keys()].indexOf(s) + 1}`);
  }
  out.push(`${String(r.scenario)} ${String(r.point)} ${primary} | ${line.join(' | ')}`);
}
out.push('');
let i = 0;
for (const [s, p] of patterns) {
  i += 1;
  out.push(`D${i} (${p.n}): ${s}`);
  out.push(`   ${p.where.slice(0, 12).join(', ')}${p.where.length > 12 ? ', ...' : ''}`);
}
writeFileSync(join(planDir, 'matrix.txt'), `${out.join('\n')}\n`);
process.stdout.write(`${join(planDir, 'matrix.txt')}\n`);
