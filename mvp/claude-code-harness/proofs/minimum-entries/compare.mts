// Minimum entries: compare each variant's request (Claude Code's own body
// log) with the base's (the R0@ holding resumed in the same batch) and with
// the live request where the pickup has one, after commit-resume's
// normalisations (device id, working directory). Where a difference is
// found, it is described block by block against the base: which blocks the
// variant's request adds, loses or changes, and where (message index, role).
// Differences with the same description are one class (M<n>).
//
//   node proofs/minimum-entries/compare.mts <plan-dir>
//
// Writes compare.json, matrix.txt (pickup by variant), classes.txt (each
// class in full, and where it occurs).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diff as crDiff, maskCompaction, norm as crNorm, requestOf as crRequestOf } from '../commit-resume/compare.mts';

// On top of commit-resume's normalisations: the billing header's
// cc_prompt_id, a random id Claude Code mints per prompt (seen differing
// between two sends of the same prompt; everything else in the header is
// compared).
const PROMPT_ID = /cc_prompt_id=[0-9a-f-]+;/g;
function norm(body: Json): Json {
  const b = crNorm(body);
  const sys = b.system as Json[] | undefined;
  if (Array.isArray(sys)) {
    for (const x of sys) {
      if (typeof x.text === 'string') {
        x.text = x.text.replace(PROMPT_ID, 'cc_prompt_id=<id>;');
      }
    }
  }
  return b;
}
const diff = (a: Json, b: Json): string[] => crDiff(norm(a), norm(b));
const requestOf = crRequestOf;

type Json = Record<string, unknown>;

interface Block {
  where: string;
  sig: string;
  text: string;
}

function textOf(b: Json): string {
  if (typeof b.text === 'string') {
    return b.text;
  }
  if (b.type === 'tool_result') {
    const c = b.content;
    return typeof c === 'string' ? c : Array.isArray(c) ? (c as Json[]).map((x) => (typeof x.text === 'string' ? x.text : `[${String(x.type)}]`)).join('\n') : '';
  }
  if (b.type === 'tool_use') {
    return `${String(b.name)} ${JSON.stringify(b.input)}`;
  }
  if (b.type === 'thinking') {
    return `thinking sig…${String(b.signature ?? '').slice(-8)}`;
  }
  return JSON.stringify(b).slice(0, 200);
}

const snip = (t: string, n = 110): string => JSON.stringify(t.replace(/\s+/g, ' ').slice(0, n) + (t.length > n ? '…' : ''));

function blocksOf(body: Json): Block[] {
  const out: Block[] = [];
  for (const [i, m] of ((body.messages ?? []) as Json[]).entries()) {
    const c = m.content;
    const bs = typeof c === 'string' ? [{ type: 'text', text: c } as Json] : ((c ?? []) as Json[]);
    for (const [j, b] of bs.entries()) {
      const cc = b.cache_control ? '+cc' : '';
      out.push({ where: `m${i}.${String(m.role)}[${j}]`, sig: JSON.stringify(b), text: `${String(b.type)}${cc} ${snip(textOf(b))}` });
    }
  }
  return out;
}

// Block-level edit script (LCS on the blocks' JSON), as lines relative to a.
function blockDiff(a: Json, b: Json): string[] {
  const A = blocksOf(a);
  const B = blocksOf(b);
  const n = A.length;
  const m = B.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      (L[i] as number[])[j] = (A[i] as Block).sig === (B[j] as Block).sig ? ((L[i + 1] as number[])[j + 1] as number) + 1 : Math.max((L[i + 1] as number[])[j] as number, (L[i] as number[])[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && (A[i] as Block).sig === (B[j] as Block).sig) {
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || ((L[i] as number[])[j + 1] as number) >= ((L[i + 1] as number[])[j] as number))) {
      out.push(`+ ${(B[j] as Block).where} ${(B[j] as Block).text}`);
      j += 1;
    } else {
      out.push(`- ${(A[i] as Block).where} ${(A[i] as Block).text}`);
      i += 1;
    }
  }
  // Message structure (roles) when it differs.
  const roles = (x: Json): string => ((x.messages ?? []) as Json[]).map((mm) => String(mm.role)[0]).join('');
  if (roles(a) !== roles(b)) {
    out.unshift(`roles ${roles(a)} -> ${roles(b)}`);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'messages' || JSON.stringify(a[k]) === JSON.stringify(b[k])) {
      continue;
    }
    if (k === 'tools') {
      const names = (x: unknown): string[] => ((x ?? []) as Json[]).map((t) => String(t.name));
      const an = names(a[k]);
      const bn = names(b[k]);
      out.unshift(`tools: -[${an.filter((x) => !bn.includes(x)).join(',')}] +[${bn.filter((x) => !an.includes(x)).join(',')}]${an.join() === bn.join() ? ' (same names, content differs)' : ''}`);
    } else if (k === 'system') {
      const sa = (a[k] ?? []) as Json[];
      const sb = (b[k] ?? []) as Json[];
      for (let s = 0; s < Math.max(sa.length, sb.length); s += 1) {
        if (JSON.stringify(sa[s]) !== JSON.stringify(sb[s])) {
          out.unshift(`system[${s}]: ${snip(String(sa[s]?.text ?? ''), 60)} -> ${snip(String(sb[s]?.text ?? ''), 60)}`);
        }
      }
    } else {
      out.unshift(`${k}: ${JSON.stringify(a[k])?.slice(0, 120)} -> ${JSON.stringify(b[k])?.slice(0, 120)}`);
    }
  }
  return out;
}

// The class key: the description with ids, uuids, dates and positions made
// generic, so the same effect at different pickups is one class.
function classKey(lines: string[]): string {
  return lines
    .map((l) =>
      l
        .replace(/m\d+\.(\w+)\[\d+\]/g, '$1')
        .replace(/toolu_[A-Za-z0-9]+/g, 'toolu_*')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
        .replace(/sig…\S+/g, 'sig…')
        .replace(/roles \w+ -> \w+/, 'roles'),
    )
    .join('\n');
}

function main(): void {
  const planDir = resolve(process.argv[2] ?? '');
  const pickups = JSON.parse(readFileSync(join(planDir, 'pickups.json'), 'utf8')) as Json[];
  const jobs = JSON.parse(readFileSync(join(planDir, 'jobs.json'), 'utf8')) as Json[];
  const jobOf = new Map<string, Json>();
  for (const j of jobs) {
    jobOf.set(`${String(j.holding)}|${String(j.probe)}|${JSON.stringify(j.options)}|${String(j.sessionId)}`, j);
  }
  const classes = new Map<string, { id: string; lines: string[]; where: string[] }>();
  const classOf = (lines: string[], where: string): string => {
    const k = classKey(lines);
    let c = classes.get(k);
    if (!c) {
      c = { id: `M${classes.size + 1}`, lines, where: [] };
      classes.set(k, c);
    }
    c.where.push(where);
    return c.id;
  };
  const rows: Json[] = [];
  const variantNames = new Set<string>();
  for (const p of pickups) {
    const probe = String(p.probe);
    const live = ((p.refs ?? []) as { kind: string; file: string }[]).find((r) => r.kind === 'live');
    // A plan's liveRewrite pairs (p24-plan.mts: the recording's date) apply
    // to the live body's text before it is compared.
    let liveText = live && existsSync(live.file) ? readFileSync(live.file, 'utf8') : undefined;
    for (const [from, to] of (p.liveRewrite ?? []) as [string, string][]) {
      liveText = liveText?.split(from).join(to);
    }
    const liveParsed = liveText ? (JSON.parse(liveText) as Json) : undefined;
    // A live request that continued a server-side thread carries only the
    // new messages: a resume always creates one, so there is nothing to
    // compare it with.
    const liveContinue = ((liveParsed?.thread as Json | undefined)?.type as string | undefined) === 'continue';
    const liveBody = liveContinue ? undefined : liveParsed;
    const reqOf = (h: string): { req?: { file: string; body: Json }; error?: string; ran: boolean; job: string } => {
      const j = jobOf.get(`${h}|${probe}|${JSON.stringify(p.options)}|${String(p.sessionId)}`);
      const outDir = join(planDir, 'out', String(j?.id));
      const ran = existsSync(join(outDir, 'job.json'));
      const jr = ran ? (JSON.parse(readFileSync(join(outDir, 'job.json'), 'utf8')) as Json) : {};
      return { req: ran ? requestOf(outDir, probe) : undefined, error: jr.error ? String(jr.error) : undefined, ran, job: String(j?.id) };
    };
    const holdings = p.holdings as Record<string, string>;
    const base = reqOf(holdings.base as string);
    const cells: Record<string, Json> = {};
    const same = (a: Json, b: Json): 'same' | 'same~c' | 'diff' => {
      if (diff(a, b).length === 0) {
        return 'same';
      }
      const ma = maskCompaction(a);
      const mb = maskCompaction(b);
      return ma && mb && diff(ma, mb).length === 0 ? 'same~c' : 'diff';
    };
    for (const [name, h] of Object.entries(holdings)) {
      variantNames.add(name);
      const g = name === 'base' ? base : reqOf(h);
      if (!g.ran || !g.req) {
        cells[name] = { job: g.job, status: g.ran ? 'no request' : 'not run', error: g.error ?? null };
        continue;
      }
      const vsLive = liveBody ? same(liveBody, g.req.body) : null;
      const vsBase = base.req ? same(base.req.body, g.req.body) : null;
      let cls: string | null = null;
      let detail: string[] | null = null;
      if (vsBase === 'diff' && base.req) {
        detail = blockDiff(norm(base.req.body), norm(g.req.body));
        cls = classOf(detail, `${String(p.scenario)} ${String(p.point)} ${name}`);
      }
      let liveDetail: string[] | null = null;
      if (name === 'base' && vsLive === 'diff' && liveBody) {
        liveDetail = blockDiff(norm(liveBody), norm(g.req.body));
      }
      cells[name] = { job: g.job, request: g.req.file, vsBase, vsLive, class: cls, detail, liveDetail };
    }
    rows.push({ liveContinue, scenario: p.scenario, point: p.point, probe, model: (p.options as Json).model ?? 'claude-sonnet-5', live: live?.file ?? null, kinds: p.kinds, cells });
  }
  writeFileSync(join(planDir, 'compare.json'), `${JSON.stringify(rows, null, 1)}\n`);
  // Matrix: one line per pickup and variant that differs from base or live.
  const out: string[] = [];
  out.push('Cell: B= same as base, B~c same as base apart from the compaction summary, M<n> differs from base (classes.txt);');
  out.push('then /L= same as live, /L~c, /Lx differs from live, /- no live request. "no request" = the resume sent none.');
  for (const r of rows) {
    const cells = r.cells as Record<string, Json>;
    const b = cells.base as Json;
    out.push(`## ${String(r.model)} ${String(r.scenario)} ${String(r.point)}  base ${r.liveContinue ? 'live continued a thread (not comparable)' : b.vsLive === null || b.vsLive === undefined ? 'no live' : `vs live: ${String(b.vsLive)}`}`);
    if (b.liveDetail) {
      for (const l of b.liveDetail as string[]) {
        out.push(`     base vs live> ${l}`);
      }
    }
    for (const [name, c] of Object.entries(cells)) {
      if (name === 'base') {
        continue;
      }
      if (!c.vsBase) {
        out.push(`   ${name.padEnd(40)} ${String(c.status)}${c.error ? ` (${String(c.error).slice(0, 120)})` : ''}`);
        continue;
      }
      const bpart = c.vsBase === 'same' ? 'B=' : c.vsBase === 'same~c' ? 'B~c' : String(c.class);
      const lpart = c.vsLive === null ? '/-' : c.vsLive === 'same' ? '/L=' : c.vsLive === 'same~c' ? '/L~c' : '/Lx';
      out.push(`   ${name.padEnd(40)} ${bpart}${lpart}`);
    }
  }
  writeFileSync(join(planDir, 'matrix.txt'), `${out.join('\n')}\n`);
  const cl: string[] = [];
  for (const c of classes.values()) {
    cl.push(`### ${c.id} (${c.where.length})`);
    cl.push(...c.lines.map((l) => `    ${l}`));
    cl.push(...c.where.map((w) => `  at ${w}`));
  }
  writeFileSync(join(planDir, 'classes.txt'), `${cl.join('\n')}\n`);
  process.stdout.write(`${rows.length} pickups, ${classes.size} classes -> ${planDir}\n`);
}

main();
