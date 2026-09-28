// Integration attempt 3, stage 3: the invariant check over every grid run,
// gathered into one report.
//
//   node proofs/integration/grid-report.mts --grid <runs/i3-...-grid-...>... --out <dir>
//
// For every row of each grid's grid-index.json (one conversation per ending x
// pickup), runs the invariant check (invariant.mts: gather, readTower, judge)
// over tower and over the shadow, writes each conversation's full report
// under <out>/<model>/<live>/<cell>-<pickup>/, and writes <out>/report.md:
//   - per model and live variant, a row per ending x pickup: whether the
//     ending was reached, the pickup decisions, the check's verdicts (content
//     and shape-only failures, round trips, unchecked, passes), and whether
//     tower and its shadow differ;
//   - every content divergence, with its scenario, point, truth, and what
//     tower held against what Claude Code built on;
//   - shape-only divergences, by kind, with every cell they occur in;
//   - every UNCHECKED point, by reason, with its cells;
//   - endings not reached, and runs that errored;
//   - every leftover Claude Code the leftover stop found, and how it ended.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, type Json } from './lib.mts';
import { compareShadow, gather, judge, markdown, type Report, readTower } from './invariant.mts';

interface Row {
  model: string;
  live: string;
  shadow?: string;
  cell: string;
  pickup: string;
  attempt: number;
  reached: boolean;
  ending: Json;
  convId: string;
  dir: string;
  decisions: Json;
  origin: string;
  error?: string;
}

const args = process.argv.slice(2);
const grids: string[] = [];
let out = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--grid') grids.push(String(args[++i]));
  else if (args[i] === '--out') out = String(args[++i]);
}
if (grids.length === 0 || !out) {
  process.stderr.write('usage: node proofs/integration/grid-report.mts --grid <runs dir>... --out <dir>\n');
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const cut = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}...` : s);
// A reason with process and file names taken out, so like reasons group.
const norm = (s: string): string => s.replace(/i3-[\w-]+\/[LD]\d{4}-[\w-]+#\d+/g, '<process>').replace(/[0-9a-f]{8}-[0-9a-f-]{27}\.request\.json/g, '<request>').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>').replace(/seq \d+/g, 'seq N');

// The account's usage limit answering a say: every result in any lineage of
// the conversation whose text is the limit's.
const LIMIT = /hit your (weekly |daily |session )?limit|weekly limit|usage limit/i;
function limitHits(convId: string): string[] {
  const out: string[] = [];
  for (const lin of gather(convId).lins) {
    for (const e of lin.events.filter((x) => x.src === 'sdk' && x.kind === 'result' && LIMIT.test(String(x.text ?? '')))) {
      out.push(`${lin.agent} ${String(lin.meta.name)} step ${String(e.step)} at ${new Date(Number(e.ms)).toISOString()}`);
    }
  }
  return out;
}

interface Summary {
  limit?: string[];
  // The usage limit answered the origin's warm-up or step 1: the cell's
  // intended ending never happened.
  limitEnding?: boolean;
  supersededBy?: string;
  row: Row;
  live?: Report;
  shadow?: Report;
  shadowSame?: Json;
}

const summaries: Summary[] = [];
for (const g of grids) {
  const idx = JSON.parse(readFileSync(join(g, 'grid-index.json'), 'utf8')) as { rows: Row[] };
  for (const row of idx.rows) {
    const s: Summary = { row };
    summaries.push(s);
    if (row.convId) {
      s.limit = limitHits(row.convId);
      s.limitEnding = s.limit.some((x) => x.startsWith(`${row.origin} c step 0 `) || x.startsWith(`${row.origin} c step 1 `));
    }
    if (!row.reached || !row.convId) {
      continue;
    }
    const ev = gather(row.convId);
    const dir = join(out, row.model, row.live, `${row.cell}-${row.pickup}${row.attempt > 1 ? `-try${row.attempt}` : ''}`);
    mkdirSync(dir, { recursive: true });
    const live = await readTower(row.convId);
    const shadow = await readTower(`${row.convId}~shadow`);
    s.live = { ...judge(ev, live), evidence: [row.dir] };
    writeFileSync(join(dir, `${row.convId}.md`), clean(markdown(s.live)));
    writeFileSync(join(dir, `${row.convId}.json`), clean(JSON.stringify(s.live, null, 2)));
    if (shadow.length > 0) {
      s.shadow = { ...judge(ev, shadow, '.shadow'), evidence: [row.dir] };
      writeFileSync(join(dir, `${row.convId}.shadow.md`), clean(markdown(s.shadow)));
      s.shadowSame = compareShadow(live, shadow) as unknown as Json;
    }
    process.stdout.write(`${row.model} ${row.live} ${row.cell}/${row.pickup}: live FAIL ${s.live.contentCounts.FAIL} content, ${s.live.counts.FAIL - s.live.contentCounts.FAIL} shape only; shadow ${s.shadowSame ? (s.shadowSame.same ? 'same' : 'DIFFERS') : 'none'}\n`);
  }
}

// A try that didn't reach its ending, where a later try of the same model,
// live variant, ending and pickup did.
const key = (r: Row): string => `${r.model}|${r.live}|${r.cell}|${r.pickup}`;
for (const s of summaries) {
  if (!s.row.reached || s.limitEnding) {
    const later = summaries.find((x) => x !== s && key(x.row) === key(s.row) && x.row.reached && !x.limitEnding);
    if (later) s.supersededBy = `${later.row.dir}${later.row.attempt > 1 ? ` (try ${later.row.attempt})` : ''}`;
  }
}

// Leftover stops: every stop-*.json a participant wrote in the grids.
const stops: Json[] = [];
const walk = (d: string): void => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (/^stop-.*\.json$/.test(f.name)) {
      const j = JSON.parse(readFileSync(p, 'utf8')) as Json;
      const rounds = (j.rounds as Json[] | undefined) ?? [];
      const found = rounds.flatMap((r) => (r.found as Json[] | undefined) ?? []);
      stops.push({ file: p, outcome: j.outcome, found: found.map((x) => ({ pid: x.pid, claudeCode: x.claudeCode, cmd: cut(String(x.cmd ?? ''), 80) })), signals: rounds.flatMap((r) => (r.signals as Json[] | undefined) ?? []), waited: rounds.flatMap((r) => (r.waited as Json[] | undefined) ?? []) });
    }
  }
};
for (const g of grids) walk(g);

const L: string[] = ['# Integration attempt 3, stage 3: the invariant over every ending and pickup', ''];
L.push(`Grids: ${grids.join(', ')}.`, '', 'Verdict columns count points (commits, quiet points, pickups, requests, the committer\'s notes), by content verdict: "content FAIL" is a failure in content (or atoms missing from tower); "shape-only FAIL" differs only in shape (message or block boundaries, trailing newlines) and is still a failure of the invariant. Full per-conversation reports sit beside this file.', '');
const models = [...new Set(summaries.map((s) => s.row.model))];
for (const m of models) {
  for (const v of [...new Set(summaries.filter((s) => s.row.model === m).map((s) => s.row.live))]) {
    L.push(`## ${m}, ${v} live (shadow ${v === 'run+last' ? 'run+entry' : 'run+last'})`, '');
    L.push('| ending | pickup | reached | decisions | content FAIL | shape-only FAIL | ROUND-TRIP | UNCHECKED | PASS | shadow |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const s of summaries.filter((x) => x.row.model === m && x.row.live === v && !x.supersededBy)) {
      const r = s.live;
      const d = Object.entries(s.row.decisions ?? {}).filter(([k]) => k !== 'recovery').map(([k, x]) => `${k} ${String(x)}`).join(', ');
      // The origin's step 1 is the ending; any other say is the pickup's.
      const lim = s.limit?.length ? (s.limitEnding ? ' (ending: the usage limit, not the cell\'s)' : ' (usage limit in the pickup)') : '';
      L.push(`| ${s.row.cell}${s.row.attempt > 1 ? ` (try ${s.row.attempt})` : ''} | ${s.row.pickup} | ${s.row.error ? 'error' : s.row.reached ? 'yes' : '**not reached**'}${lim} | ${d} | ${r ? r.contentCounts.FAIL : '-'} | ${r ? r.counts.FAIL - r.contentCounts.FAIL : '-'} | ${r ? r.contentCounts['ROUND-TRIP'] : '-'} | ${r ? r.contentCounts.UNCHECKED : '-'} | ${r ? r.contentCounts.PASS : '-'} | ${s.shadowSame ? (s.shadowSame.same ? 'same' : `**differs at message ${String(s.shadowSame.at)}**`) : '-'} |`);
    }
    L.push('');
  }
}

L.push('## Live and shadow differences', '');
const diffs = summaries.filter((s) => !s.supersededBy && s.shadowSame && !s.shadowSame.same);
if (diffs.length === 0) L.push('- none: in every cell the shadow variant holds exactly what tower holds.');
for (const s of diffs) {
  L.push(`- ${s.row.model}, ${s.row.live} live, ${s.row.cell} then ${s.row.pickup} (${s.row.convId}): first difference at message ${String(s.shadowSame?.at)}; tower ${String(s.shadowSame?.live)}; shadow ${String(s.shadowSame?.shadow)}`);
}

L.push('', '## Content divergences', '', 'Every FAIL whose divergence is in content, or that names atoms missing from tower. The shadow is listed only where it differs from tower.', '');
for (const s of summaries.filter((x) => !x.supersededBy)) {
  for (const [which, r] of [['tower', s.live], ['shadow', s.shadowSame && !s.shadowSame.same ? s.shadow : undefined]] as const) {
    if (!r) continue;
    const items = r.points.flatMap((p) => p.judgments.filter((j) => j.contentVerdict === 'FAIL').map((j) => ({ p, j })));
    if (items.length === 0) continue;
    L.push(`### ${s.row.model}, ${s.row.live} live, ${s.row.cell} then ${s.row.pickup} (${which}; conversation ${s.row.convId})`, '');
    for (const { p, j } of items) {
      L.push(`- **${p.kind}** ${cut(p.label, 200)}`);
      L.push(`  - against ${j.truth}${j.request ? ` (${j.request})` : ''}: ${cut(j.why, 300)}`);
      if (j.divergence?.contentAt) {
        L.push(`  - first content difference at ${j.divergence.contentAt}; tower: ${(j.divergence.towerAtoms ?? []).find((x) => x.startsWith('>')) ?? '(none)'}; Claude Code: ${(j.divergence.truthAtoms ?? []).find((x) => x.startsWith('>')) ?? '(none)'}`);
      }
      if (j.missing?.length) L.push(`  - missing from tower: ${j.missing.map((x) => cut(x, 140)).join('; ')}`);
    }
    L.push('');
  }
}

L.push('## Shape-only divergences, by kind', '');
const shapes = new Map<string, Set<string>>();
for (const s of summaries.filter((x) => !x.supersededBy)) {
  for (const p of s.live?.points ?? []) {
    for (const j of p.judgments) {
      if (j.verdict === 'FAIL' && j.contentVerdict !== 'FAIL' && j.divergence) {
        for (const x of j.divergence.shapeDiffs.length ? j.divergence.shapeDiffs : [j.divergence.at]) {
          const k = norm(x).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
          const set = shapes.get(k) ?? new Set<string>();
          set.add(`${s.row.model}/${s.row.live}/${s.row.cell}-${s.row.pickup}`);
          shapes.set(k, set);
        }
      }
    }
  }
}
for (const [k, set] of [...shapes].sort((a, b) => b[1].size - a[1].size)) {
  L.push(`- ${k}: in ${set.size} cell(s): ${[...set].join(', ')}`);
}

L.push('', '## UNCHECKED points, by reason', '', 'A point whose content verdict is UNCHECKED: no truth independent of tower reached it.', '');
const unchecked = new Map<string, string[]>();
for (const s of summaries.filter((x) => !x.supersededBy)) {
  for (const p of s.live?.points ?? []) {
    if (p.contentVerdict !== 'UNCHECKED') continue;
    const why = p.judgments.map((j) => norm(`${j.truth}: ${j.why}`)).join(' / ');
    const k = `${p.kind}: ${why}`;
    unchecked.set(k, [...(unchecked.get(k) ?? []), `${s.row.model}/${s.row.live}/${s.row.cell}-${s.row.pickup}: ${cut(p.label, 90)}`]);
  }
}
for (const [k, v] of [...unchecked].sort((a, b) => b[1].length - a[1].length)) {
  L.push(`- ${v.length} x ${cut(k, 400)}`);
  for (const x of v) L.push(`  - ${x}`);
}

L.push('', '## The usage limit inside recorded conversations', '', 'Conversations where the account\'s usage limit answered a say (the model call returned the limit error at once). Judged by the check like any API-error ending; listed so they read as what they are.', '');
for (const s of summaries.filter((x) => x.limit?.length)) {
  L.push(`- ${s.row.model}, ${s.row.live}, ${s.row.cell} then ${s.row.pickup}, try ${s.row.attempt} (${s.row.reached ? 'ending reached' : 'not reached'}${s.supersededBy ? '; rerun' : ''}): ${s.limit?.join('; ')}`);
}

L.push('', '## Endings not reached, and errors', '');
for (const s of summaries.filter((x) => !x.row.reached || x.row.error || x.limitEnding)) {
  L.push(`- ${s.row.model}, ${s.row.live}, ${s.row.cell} then ${s.row.pickup}, try ${s.row.attempt}: ${s.supersededBy ? `superseded by a later try (${s.supersededBy.replace(/.*\/runs\//, 'runs/')}); ` : ''}${s.row.error ? `error ${cut(s.row.error, 300)}` : s.limitEnding ? `the usage limit answered the origin (${(s.limit ?? []).filter((x) => x.startsWith(s.row.origin)).slice(0, 2).join('; ')}), so the cell's own ending never happened` : `not reached ${cut(JSON.stringify(s.row.ending), 300)}`}`);
}

L.push('', '## The leftover stop', '');
const acted = stops.filter((x) => (x.found as Json[]).length > 0 || !/none found/.test(String(x.outcome)));
L.push(`- ${stops.length} serves ran the leftover stop; ${stops.length - acted.length} found nothing.`);
for (const x of acted) L.push(`- ${String(x.file).replace(/.*\/runs\//, 'runs/')}: ${String(x.outcome)}; found ${JSON.stringify(x.found)}; signals ${JSON.stringify(x.signals)}; waited ${cut(JSON.stringify(x.waited), 200)}`);

writeFileSync(join(out, 'report.md'), clean(`${L.join('\n')}\n`));
writeFileSync(join(out, 'index.json'), clean(JSON.stringify(summaries.map((s) => ({ ...s.row, check: s.live ? { counts: s.live.counts, content: s.live.contentCounts } : null, shadowCheck: s.shadow ? { counts: s.shadow.counts, content: s.shadow.contentCounts } : null, shadowSame: s.shadowSame ?? null })), null, 2)));
process.stdout.write(`report: ${join(out, 'report.md')}\n`);
process.exit(0);
