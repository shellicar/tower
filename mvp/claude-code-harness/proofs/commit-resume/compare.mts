// Store commit against resume from tower: compare each resume's request
// (Claude Code's own body log, OTEL_LOG_RAW_API_BODIES, the same form as the
// live reference) with each reference of its pickup, and write the table.
//
// Normalised before comparing, on both sides, and nothing else:
//   - metadata.user_id's device_id (a store resume runs in a fresh temporary
//     config dir, which gets its own device id)
//   - the agent's working directory path (work/<agent>)
// Everything else, cache_control included, is compared as sent.
//
//   node proofs/commit-resume/compare.mts <plan-dir> [--rules R0,R0@,...]

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

type Json = Record<string, unknown>;

function lastUserText(body: Json): string {
  const msgs = (body.messages ?? []) as Json[];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const c = last?.content;
  if (typeof c === 'string') {
    return c;
  }
  return Array.isArray(c) ? (c as Json[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n') : '';
}

function norm(body: Json): Json {
  const s = JSON.stringify(body).replace(/tower-claude-code-harness\/work\/[A-Za-z0-9_-]+/g, 'tower-claude-code-harness/work/<AGENT>');
  const b = JSON.parse(s) as Json;
  const md = b.metadata as Json | undefined;
  if (md && typeof md.user_id === 'string') {
    try {
      const u = JSON.parse(md.user_id) as Json;
      delete u.device_id;
      md.user_id = JSON.stringify(u);
    } catch {
      // not JSON: left as is
    }
  }
  return b;
}

function brief(m: Json | undefined): string {
  if (!m) {
    return '(none)';
  }
  const c = m.content;
  const blocks = typeof c === 'string' ? [{ type: 'string', text: c }] : ((c ?? []) as Json[]);
  return `${String(m.role)}[${blocks
    .map((b) => {
      const t = String(b.type);
      const cc = b.cache_control ? '+cc' : '';
      if (typeof b.text === 'string') {
        return `${t}${cc}(${JSON.stringify(b.text.length > 50 ? `${b.text.slice(0, 50)}…` : b.text)})`;
      }
      if (t === 'thinking') {
        return `thinking${cc}(sig ${String(b.signature ?? '').slice(-8)})`;
      }
      if (t === 'tool_use') {
        return `tool_use${cc}(${String(b.name)} ${String(b.id).slice(-6)})`;
      }
      if (t === 'tool_result') {
        return `tool_result${cc}(${String(b.tool_use_id).slice(-6)}${b.is_error ? ' ERR' : ''})`;
      }
      return `${t}${cc}`;
    })
    .join(' + ')}]`;
}

// Every difference, as short lines.
export function diff(ref: Json, got: Json): string[] {
  const a = norm(ref);
  const b = norm(got);
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'messages') {
      continue;
    }
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      out.push(`${k}: ${JSON.stringify(a[k])?.slice(0, 160)} vs ${JSON.stringify(b[k])?.slice(0, 160)}`);
    }
  }
  const am = (a.messages ?? []) as Json[];
  const bm = (b.messages ?? []) as Json[];
  if (am.length !== bm.length) {
    out.push(`messages: ${am.length} vs ${bm.length}`);
  }
  for (let i = 0; i < Math.max(am.length, bm.length); i += 1) {
    if (JSON.stringify(am[i]) !== JSON.stringify(bm[i])) {
      out.push(`msg ${i}: ${brief(am[i])} vs ${brief(bm[i])}`);
    }
  }
  return out;
}

function requestOf(outDir: string, probe: string): { file: string; body: Json } | undefined {
  const d = join(outDir, 'otel');
  if (!existsSync(d)) {
    return undefined;
  }
  for (const f of readdirSync(d).filter((x) => x.endsWith('.request.json'))) {
    const body = JSON.parse(readFileSync(join(d, f), 'utf8')) as Json;
    if (Array.isArray(body.tools) && body.tools.length > 0 && lastUserText(body).includes(probe)) {
      return { file: join(d, f), body };
    }
  }
  return undefined;
}

function main(): void {
  const planDir = resolve(process.argv[2] ?? '');
  const pickups = JSON.parse(readFileSync(join(planDir, 'pickups.json'), 'utf8')) as Json[];
  const jobs = JSON.parse(readFileSync(join(planDir, 'jobs.json'), 'utf8')) as Json[];
  const jobOf = new Map<string, Json>();
  for (const j of jobs) {
    jobOf.set(`${String(j.holding)}|${String(j.probe)}|${JSON.stringify(j.options)}|${String(j.sessionId)}`, j);
  }
  const rows: Json[] = [];
  for (const p of pickups) {
    const refs = [...((p.refs ?? []) as { kind: string; file: string }[])];
    const got: Record<string, { job: string; req?: { file: string; body: Json }; error?: string; ran: boolean }> = {};
    for (const [rule, h] of Object.entries(p.holdings as Record<string, string>)) {
      const j = jobOf.get(`${h}|${String(p.probe)}|${JSON.stringify(p.options)}|${String(p.sessionId)}`);
      const id = String(j?.id);
      const outDir = join(planDir, 'out', id);
      const ran = existsSync(join(outDir, 'job.json'));
      const jr = ran ? (JSON.parse(readFileSync(join(outDir, 'job.json'), 'utf8')) as Json) : {};
      got[rule] = { job: id, req: ran ? requestOf(outDir, String(p.probe)) : undefined, error: jr.error ? String(jr.error) : undefined, ran };
    }
    const own = got.OWN?.req;
    const cells: Json = {};
    for (const [rule, g] of Object.entries(got)) {
      const vs: Json = {};
      if (!g.ran) {
        cells[rule] = { job: g.job, status: 'not run' };
        continue;
      }
      if (!g.req) {
        cells[rule] = { job: g.job, status: 'no request', error: g.error ?? null };
        continue;
      }
      for (const r of refs) {
        const d = diff(JSON.parse(readFileSync(r.file, 'utf8')) as Json, g.req.body);
        vs[r.kind] = d.length === 0 ? 'same' : d;
      }
      if (own && rule !== 'OWN') {
        const d = diff(own.body, g.req.body);
        vs.OWN = d.length === 0 ? 'same' : d;
      }
      cells[rule] = { job: g.job, request: g.req.file, hash: createHash('sha256').update(JSON.stringify(norm(g.req.body))).digest('hex').slice(0, 10), vs };
    }
    rows.push({ scenario: p.scenario, rep: p.rep, point: p.point, probe: p.probe, refs, notCommitted: p.notCommitted, cells });
  }
  writeFileSync(join(planDir, 'compare.json'), `${JSON.stringify(rows, null, 1)}\n`);
  // Text table: one line per pickup and rule.
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(`## ${String(r.scenario)} r${String(r.rep)} ${String(r.point)} probe=${JSON.stringify(String(r.probe).slice(0, 40))} refs=${((r.refs as Json[]) ?? []).map((x) => x.kind).join(',') || '(none)'}`);
    if (r.notCommitted && Object.keys(r.notCommitted as Json).length > 0) {
      lines.push(`   not committed: ${JSON.stringify(r.notCommitted)}`);
    }
    for (const [rule, c] of Object.entries(r.cells as Record<string, Json>)) {
      if (!c.vs) {
        lines.push(`   ${rule.padEnd(4)} ${String(c.status)}${c.error ? ` (${String(c.error).slice(0, 100)})` : ''} [${String(c.job)}]`);
        continue;
      }
      const parts = Object.entries(c.vs as Record<string, unknown>).map(([k, v]) => (v === 'same' ? `${k}: same` : `${k}: DIFF`));
      lines.push(`   ${rule.padEnd(4)} ${String(c.hash)} ${parts.join('; ')} [${String(c.job)}]`);
      for (const [k, v] of Object.entries(c.vs as Record<string, unknown>)) {
        if (v !== 'same') {
          for (const d of v as string[]) {
            lines.push(`        ${k}> ${d}`);
          }
        }
      }
    }
  }
  writeFileSync(join(planDir, 'compare.txt'), `${lines.join('\n')}\n`);
  process.stdout.write(`${rows.length} pickups -> ${join(planDir, 'compare.txt')}\n`);
}

main();
