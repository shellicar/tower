// Integration proof: the checks. Each returns a verdict and its evidence.
//
// Request comparison (probeRequest, comparable, diffPaths, resumeVerdict) is
// proof 24's, as the reconcile copied it (proofs/reconcile/analyse.mts, which
// runs on import): the noise floor masked (metadata device_id, the billing
// header's cc_prompt_id and cc_prev_req, `caller`, cache_control), cache
// numbers compared as proof 24 did (T reads what L read and wrote, writes 0).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build, kindOf, type Recording, type TMsg } from '../reconcile/holding.mts';
import { compareUnits, describeEntry, probeCut, requestUnits, towerBeforeProbeReply, towerUnits, type Verdict, without } from '../reconcile/compare.mts';
import { fullHistory, readIndex } from '../next/history.mts';
import { coreHash, NO_RESPONSE, type PublishedLine } from './committer.mts';
import { type Json, readJsonl } from './lib.mts';
import { entryId, Lineage } from './lineage.mts';

export interface ReqInfo {
  file: string;
  mtimeMs: number;
  body: Json;
  root: Json;
  messages: Json[];
  chain: string[];
  usage: Json | null;
  diagnostics: Json | null;
  stop: unknown;
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
  return { file, mtimeMs: statSync(join(bodies, file)).mtimeMs, body, root, messages: h.messages as unknown as Json[], chain: h.chain, usage, diagnostics, stop };
}

// The first main request carrying `text` (after `afterMs`, if given).
export function probeRequest(bodies: string, model: string, text: string, afterMs = 0): ReqInfo | undefined {
  if (!existsSync(bodies)) {
    return undefined;
  }
  const files = readdirSync(bodies)
    .filter((f) => f.endsWith('.request.json'))
    .map((f) => ({ f, t: statSync(join(bodies, f)).mtimeMs }))
    .filter((x) => x.t >= afterMs)
    .sort((a, b) => a.t - b.t);
  for (const { f } of files) {
    const body = JSON.parse(readFileSync(join(bodies, f), 'utf8')) as Json;
    if (!String(body.model).startsWith(model) || body.thinking === undefined || !Array.isArray(body.messages) || (body.thread === undefined && !(Array.isArray(body.tools) && body.tools.length > 0))) {
      continue;
    }
    // The text as the last user message's own text, not a mention elsewhere.
    if (JSON.stringify(body.messages).includes(text)) {
      return reqInfo(bodies, f);
    }
  }
  return undefined;
}

function norm(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(norm);
  }
  if (v && typeof v === 'object') {
    const o: Json = {};
    for (const [k, x] of Object.entries(v as Json)) {
      if (k === 'cache_control' || k === 'caller') {
        continue;
      }
      o[k] = k === 'content' && typeof x === 'string' ? [{ type: 'text', text: x }] : norm(x);
    }
    return o;
  }
  return v;
}

export function comparable(r: ReqInfo, mask: [string, string][] = []): Json {
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
  const sysText = JSON.stringify(system).replace(/cc_prompt_id=[0-9a-f-]*/g, 'cc_prompt_id=*').replace(/ cc_prev_req=[A-Za-z0-9_]*;/g, '');
  let out = JSON.stringify({
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
  });
  for (const [from, to] of mask) {
    out = out.split(from).join(to);
  }
  return JSON.parse(out) as Json;
}

export function diffPaths(a: unknown, b: unknown, path = '', out: string[] = [], limit = 12): string[] {
  if (out.length >= limit || JSON.stringify(a) === JSON.stringify(b)) {
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
    for (const k of new Set([...Object.keys(a as Json), ...Object.keys(b as Json)])) {
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

const usageOf = (x: Json | null): Json | null => (x ? { read: x.cache_read_input_tokens, write: x.cache_creation_input_tokens, input: x.input_tokens } : null);

// OK: same request, and T read what L read and wrote, writing nothing.
// REQ: same request, no usage on one side (a failed probe). DIFF otherwise.
export function resumeVerdict(L: ReqInfo, T: ReqInfo | undefined, mask: [string, string][] = []): Json {
  if (!T) {
    return { verdict: 'no T request' };
  }
  const d = diffPaths(comparable(L), comparable(T, mask));
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
  const s = JSON.stringify(T.messages);
  // With permission mode auto, the live Claude Code sends the server-side
  // auto-mode classifier's beta (dangerous-tool-use-2026-09-03, a per-
  // conversation latch in 2.1.282) and a resumed one's first request
  // doesn't: reported apart, so it reads as what it is.
  const lb = ((L.body.betas as string[] | undefined) ?? []).filter((b) => !((T.body.betas as string[] | undefined) ?? []).includes(b));
  const tb = ((T.body.betas as string[] | undefined) ?? []).filter((b) => !((L.body.betas as string[] | undefined) ?? []).includes(b));
  const onlyBetas = d.length > 0 && d.every((x) => x.startsWith('.betas'));
  return {
    verdict,
    onlyBetas,
    betas: { onlyL: lb, onlyT: tb },
    diff: d,
    L: { file: L.file, usage: usageOf(L.usage), chain: L.chain },
    T: { file: T.file, usage: usageOf(T.usage), chain: T.chain, missReason: (T.diagnostics as Json | null)?.cache_miss_reason ?? null },
    tInsertedNoResponse: s.includes(`"${NO_RESPONSE}"`),
  };
}

// ---------------------------------------------------------------------------
// Tower read back as reconcile's TMsg.

export function tmsgsOf(bodies: Json[]): TMsg[] {
  return bodies.map((b) => ({ commitMs: Date.parse(String(b.ts)), id: String(b.id), role: String(b.role), turnId: String(b.turnId), content: (b.content as never[]) ?? [], cc: (b.ccEntries as never[]) ?? [], via: 'tower' }));
}

// Tower against the messages L's request carried: every part a kept reply
// has closed, message for message (reconcile's offline analyse, option run).
export function towerVsRequest(rec: Recording, towerBodies: Json[], L: ReqInfo): Verdict {
  const describe = describeEntry(rec);
  const reqUnits = requestUnits(rec, L.messages as never);
  const msgs = towerBeforeProbeReply(tmsgsOf(towerBodies), L.mtimeMs, rec);
  return compareUnits(reqUnits.units, without(towerUnits(msgs), probeCut(L.mtimeMs, rec)), describe);
}

// T's messages against L's, both attributed to the live recording's
// entries, cut to what was there at `asOfMs` (the probe's own turn is
// dropped on both sides). What L has and T lacks should be exactly
// `expectedMissing`.
export function messagesVs(rec: Recording, L: ReqInfo, T: ReqInfo, asOfMs: number): { missing: string[]; extra: string[]; placement: string[]; kinds: string[]; content: string[]; unattributed: { L: number; T: number } } {
  const describe = (u: string): string => u;
  const drop = new Set(rec.entries.filter((r) => r.ms > asOfMs).map((r) => String(r.entry.uuid)));
  const l = requestUnits(rec, L.messages as never);
  const t = requestUnits(rec, T.messages as never);
  const v = compareUnits(without(l.units, drop), without(t.units, drop), describe);
  // `content`: an entry both carry with different text (a resume putting
  // its own text where the entry was, e.g. a synthetic tool_result).
  return { missing: v.missing, extra: v.extra, placement: v.placement, kinds: v.kinds, content: v.bytes, unattributed: { L: l.unattributed, T: t.unattributed } };
}

// The carriers (entries the model sees) at or before `asOfMs` that tower
// didn't hold by then: what a resume from tower alone should miss.
export function unclosedAsOf(rec: Recording, towerBodies: Json[], asOfMs: number): string[] {
  const held = new Set(towerBodies.flatMap((b) => ((b.ccEntries as Json[] | undefined) ?? []).map((c) => String(c.uuid))));
  return rec.entries.filter((r) => r.ms <= asOfMs && kindOf(r.entry) === 'carrier' && !held.has(String(r.entry.uuid))).map((r) => String(r.entry.uuid));
}

// Join 8: the live-published sequence against build(finalRecording, 'run').
export function liveVsOffline(lineageDir: string, bodyOf: (m: TMsg) => Json): Json {
  const lin = Lineage.open(lineageDir);
  lin.pollBodies();
  const b = build(lin.rec, 'run');
  const pub = (readJsonl(join(lineageDir, 'published.jsonl')) as unknown as PublishedLine[]).filter((p) => p.kind === 'message');
  const seeded = new Set((readJsonl(join(lineageDir, 'published.jsonl')) as unknown as PublishedLine[]).filter((p) => p.kind === 'seed').map((p) => p.id));
  const carriedBySeed = new Set((readJsonl(join(lineageDir, 'published.jsonl')) as unknown as PublishedLine[]).filter((p) => p.kind === 'seed').flatMap((p) => p.cc));
  const offline = b.all.filter((m) => !seeded.has(m.id) && !(m.cc.length > 0 && m.cc.every((c) => carriedBySeed.has(c.uuid)))).map((m) => ({ id: m.id, hash: coreHash(bodyOf(m)), role: m.role }));
  const live = pub.map((p) => ({ id: p.id, hash: p.hash }));
  let first = -1;
  for (let i = 0; i < Math.max(live.length, offline.length); i += 1) {
    if (live[i]?.id !== offline[i]?.id || live[i]?.hash !== offline[i]?.hash) {
      first = i;
      break;
    }
  }
  const committer = readJsonl(join(lineageDir, 'committer.jsonl'));
  // Assistant pieces published before their own run's user side.
  return {
    equal: first < 0,
    firstDifference: first < 0 ? null : { index: first, live: live[first] ?? null, offline: offline[first] ?? null },
    live: live.length,
    offline: offline.length,
    orderWarnings: b.orderWarnings,
    committerNotes: committer.map((c) => ({ kind: c.kind, id: c.id ?? null, warning: c.warning ?? null, error: c.error ?? null })),
  };
}

// Join 7: "No response requested." never reaches tower.
export function noResponseOnTower(bodies: Json[]): string[] {
  return bodies.filter((b) => JSON.stringify(b.content).includes(NO_RESPONSE)).map((b) => String(b.id));
}

// A fork: two of tower's chain entries share a parent.
export function forks(bodies: Json[]): { parent: string; children: string[] }[] {
  const kids = new Map<string, string[]>();
  for (const b of bodies) {
    for (const c of (b.ccEntries as Json[] | undefined) ?? []) {
      const e = c.entry as Json;
      const parent = e.parentUuid;
      if (typeof parent === 'string' && e.isSidechain !== true) {
        kids.set(parent, [...(kids.get(parent) ?? []), String(c.uuid)]);
      }
    }
  }
  return [...kids].filter(([, ch]) => new Set(ch).size > 1).map(([parent, children]) => ({ parent, children: [...new Set(children)] }));
}

// What any of this machine's transcripts hold that tower doesn't, by kind:
// dropped thinking-only pieces and the synthetic "No response requested."
// are expected; the model-visible rest is lost.
export function lostFromTower(local: Json[], bodies: Json[]): { lostVisible: string[]; unshownNotCarried: string[]; droppedThinking: string[]; synthetic: string[] } {
  const held = new Set<string>();
  for (const b of bodies) {
    for (const c of (b.ccEntries as Json[] | undefined) ?? []) {
      held.add(`uuid:${String(c.uuid)}`);
    }
    for (const u of (b.ccUnshown as Json[] | undefined) ?? []) {
      held.add(entryId(u.entry as Json));
    }
  }
  const out = { lostVisible: [] as string[], unshownNotCarried: [] as string[], droppedThinking: [] as string[], synthetic: [] as string[] };
  for (const e of local) {
    if (held.has(entryId(e)) || e.isSidechain === true) {
      continue;
    }
    const d = `${String(e.type)} ${String(e.uuid ?? '-').slice(0, 8)}`;
    const content = (e.message as Json | undefined)?.content;
    const blocks = Array.isArray(content) ? (content as Json[]) : [];
    if (e.type === 'assistant' && JSON.stringify(content ?? '').includes(NO_RESPONSE)) {
      out.synthetic.push(d);
    } else if (e.type === 'assistant' && blocks.length > 0 && blocks.every((b) => b.type === 'thinking' || b.type === 'redacted_thinking')) {
      out.droppedThinking.push(d);
    } else if (kindOf(e) === 'unshown') {
      out.unshownNotCarried.push(`${d} ${String((e.attachment as Json | undefined)?.type ?? e.subtype ?? '')}`);
    } else {
      out.lostVisible.push(d);
    }
  }
  return out;
}
