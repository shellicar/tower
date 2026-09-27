// Reconcile: analyse live runs (run.mts's index). Per cell: the history and
// timing of every option (offline.mts over the main run's recording), and,
// per option, its resume at step 1's result (T) against Claude Code's own
// continuation (L): the request, field by field (noise floor as proof 24:
// metadata device_id, cc_prompt_id; cc_prev_req and `caller` masked), and
// the cache numbers. Proof 24's analyse.mts request comparison, copied.
//
//   node proofs/reconcile/analyse.mts <rc-index.json> [...] > analysis.jsonl

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from './holding.mts';
import { fullHistory, readIndex } from '../next/history.mts';
import { analyse, PROBE } from './offline.mts';

interface ReqInfo {
  file: string;
  body: Json;
  root: Json; // the chain's first request (system and tools live there for a continue)
  messages: Json[];
  chain: string[];
  usage: Json | null;
  diagnostics: Json | null;
  stop: unknown;
}

function lines(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

function reqInfo(bodies: string, file: string): ReqInfo {
  const body = JSON.parse(readFileSync(join(bodies, file), 'utf8')) as Json;
  const h = fullHistory(bodies, file);
  const rootFile = String(h.chain[0]).replace(/\(.*$/, '');
  const root = JSON.parse(readFileSync(join(bodies, rootFile), 'utf8')) as Json;
  const line = readIndex(bodies).find((l) => l.request_file === file);
  let usage: Json | null = null;
  let diagnostics: Json | null = null;
  let stop: unknown = null;
  if (line?.response_file && existsSync(join(bodies, line.response_file))) {
    const r = JSON.parse(readFileSync(join(bodies, line.response_file), 'utf8')) as Json;
    usage = (r.usage as Json) ?? null;
    diagnostics = (r.diagnostics as Json) ?? null;
    stop = r.stop_reason;
  }
  return { file, body, root, messages: h.messages as unknown as Json[], chain: h.chain, usage, diagnostics, stop };
}

// The first main request (the served model, from the SDK loop) that carries
// the probe.
function probeRequest(bodies: string, model: string): ReqInfo | undefined {
  const idx = readIndex(bodies);
  const files = idx.filter((l) => l.query_source === 'sdk' && String(l.model).startsWith(model)).map((l) => String(l.request_file));
  // Requests without an index line (no response: failed or interrupted).
  for (const f of existsSync(bodies) ? readdirSync(bodies) : []) {
    if (f.endsWith('.request.json') && !files.includes(f)) {
      files.push(f);
    }
  }
  const withTime = files.map((f) => ({ f, t: statSync(join(bodies, f)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { f } of withTime) {
    const body = JSON.parse(readFileSync(join(bodies, f), 'utf8')) as Json;
    // Main requests: the served model, thinking, and a thread or tools (the
    // session title request has neither).
    if (!String(body.model).startsWith(model) || body.thinking === undefined || !Array.isArray(body.messages) || (body.thread === undefined && !(Array.isArray(body.tools) && body.tools.length > 0))) {
      continue;
    }
    if (JSON.stringify(body.messages).includes(PROBE)) {
      return reqInfo(bodies, f);
    }
  }
  return undefined;
}

// Normal form for comparing two requests: content as block lists,
// cache_control dropped, the noise floor fields dropped.
function norm(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(norm);
  }
  if (v && typeof v === 'object') {
    const o: Json = {};
    for (const [k, x] of Object.entries(v as Json)) {
      // cache_control moves with the last message. `caller` is on tool_use
      // blocks in the API's responses (so in a server-side thread) but not
      // in Claude Code's entries; reported separately (callerOnly).
      if (k === 'cache_control' || k === 'caller') {
        continue;
      }
      o[k] = k === 'content' && typeof x === 'string' ? [{ type: 'text', text: x }] : norm(x);
    }
    return o;
  }
  return v;
}

function comparable(r: ReqInfo): Json {
  const b = r.body;
  const meta = b.metadata as Json | undefined;
  let userId: unknown = meta?.user_id;
  try {
    const u = JSON.parse(String(userId)) as Json;
    delete u.device_id;
    userId = u;
  } catch {
    // leave as is
  }
  const system = norm(r.root.system);
  // Noise floor (proof 16): cc_prompt_id in the billing header.
  // cc_prev_req (the previous request's id) is masked too: a fresh process
  // has no previous request until it reads one from the entries (proof 16);
  // reported separately (prevReq).
  const sysText = JSON.stringify(system).replace(/cc_prompt_id=[0-9a-f-]*/g, 'cc_prompt_id=*').replace(/ cc_prev_req=[A-Za-z0-9_]*;/g, '');
  return {
    model: b.model,
    system: JSON.parse(sysText),
    tools: norm(r.root.tools ?? null),
    messages: norm(r.messages),
    thinking: b.thinking,
    max_tokens: b.max_tokens,
    output_config: b.output_config,
    context_management: b.context_management ?? r.root.context_management ?? null,
    betas: b.betas,
    metadata: userId,
  };
}

function diffPaths(a: unknown, b: unknown, path = '', out: string[] = [], limit = 12): string[] {
  if (out.length >= limit) {
    return out;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) {
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path}: length ${a.length} vs ${b.length}`);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      diffPaths(a[i], b[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a as Json), ...Object.keys(b as Json)]);
    for (const k of keys) {
      diffPaths((a as Json)[k], (b as Json)[k], `${path}.${k}`, out, limit);
    }
    return out;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    let i = 0;
    while (i < a.length && a[i] === b[i]) {
      i++;
    }
    out.push(`${path}: at char ${i}: ${JSON.stringify(a.slice(Math.max(0, i - 20), i + 70))} vs ${JSON.stringify(b.slice(Math.max(0, i - 20), i + 70))}`);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)?.slice(0, 90)} vs ${JSON.stringify(b)?.slice(0, 90)}`);
  return out;
}

const prevReq = (r: ReqInfo): string | null => /cc_prev_req=([A-Za-z0-9_]*)/.exec(JSON.stringify(r.root.system))?.[1] ?? null;

// What a resumed request adds or changes that no commit rule controls.
function classify(T: ReqInfo): string[] {
  const out: string[] = [];
  const s = JSON.stringify(T.messages);
  if (s.includes('"No response requested."')) {
    out.push('resume inserted "No response requested."');
  }
  if (s.includes('re-read when this session started')) {
    out.push('resume re-announced the session context');
  }
  if (s.includes('SYSTEM NOTIFICATION')) {
    out.push('a background task notification');
  }
  return out;
}

const u = (x: Json | null): string => (x ? `read ${String(x.cache_read_input_tokens)} write ${String(x.cache_creation_input_tokens)} in ${String(x.input_tokens)}` : 'no usage');
const total = (x: Json | null): number | null => (x ? Number(x.cache_read_input_tokens) + Number(x.cache_creation_input_tokens) + Number(x.input_tokens) : null);


function resumeVerdict(L: ReqInfo, T: ReqInfo | undefined): Json {
  if (!T) {
    return { verdict: 'no probe request' };
  }
  const d = diffPaths(comparable(L), comparable(T));
  const u = (x: Json | null): Json | null => (x ? { read: x.cache_read_input_tokens, write: x.cache_creation_input_tokens, input: x.input_tokens } : null);
  let verdict: string;
  if (d.length > 0) {
    verdict = 'DIFF';
  } else if (!L.usage || !T.usage) {
    verdict = 'REQ';
  } else {
    const want = Number(L.usage.cache_read_input_tokens) + Number(L.usage.cache_creation_input_tokens);
    const read = Number(T.usage.cache_read_input_tokens);
    verdict = read === want && Number(T.usage.cache_creation_input_tokens) === 0 ? 'OK' : `REQ,cache${read - want >= 0 ? '+' : ''}${read - want}r/${String(T.usage.cache_creation_input_tokens)}w`;
  }
  return { verdict, diff: d, L: u(L.usage), T: u(T.usage), adds: classify(T), prevReq: { L: prevReq(L), T: prevReq(T) }, tMissReason: (T.diagnostics as Json | null)?.cache_miss_reason ?? null };
}

function main(): void {
  for (const f of process.argv.slice(2)) {
    for (const row of JSON.parse(readFileSync(f, 'utf8')) as Json[]) {
      if (row.failed || !row.rawDir) {
        process.stdout.write(`${JSON.stringify({ model: row.model, cell: row.cell, failed: row.failed ?? 'no raw dir' })}\n`);
        continue;
      }
      try {
        const model = String(row.model);
        const out = analyse(String(row.rawDir), model);
        const L = probeRequest(join(String(row.rawDir), 'api-bodies'), model);
        const resumes: Json = {};
        const ways = (row.ways as Record<string, Json>) ?? {};
        for (const [way, w] of Object.entries(ways)) {
          const res = (row.resumes as Record<string, Json>)[String(w.hash)];
          if (!res || !L) {
            resumes[way] = { verdict: L ? 'no resume' : 'no L', notCommitted: w.notCommitted, invalid: w.invalid };
            continue;
          }
          const T = probeRequest(join(String(res.rawDir), 'api-bodies'), model);
          resumes[way] = { ...resumeVerdict(L, T), resume: res.dir, sharedWith: res.ways, entries: w.entries, notCommitted: (w.notCommitted as string[]).length, invalid: w.invalid };
        }
        out.resumes = resumes;
        out.cell = row.cell;
        out.L = L ? { file: L.file, chain: L.chain, usage: L.usage } : null;
        process.stdout.write(`${JSON.stringify(out)}\n`);
      } catch (err) {
        process.stdout.write(`${JSON.stringify({ model: row.model, cell: row.cell, error: err instanceof Error ? err.stack : String(err) })}\n`);
      }
    }
  }
}

main();
