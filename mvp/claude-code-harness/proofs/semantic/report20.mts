// Proof 20 reports, from a run's recorded files only.
//
// seedReport: every request file of a seed run, what each source says it
// was (the selector live, OTEL's api_request_body query_source per attempt,
// index.jsonl's query_source per successful response, proof 16's selector,
// the previous_message_id chain), what A made of each main request, whether
// each response was published under its own request's turn, and the delays.
//
// resumeReport: each resume's first main request against the full-record
// resume's, with cache numbers.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonl } from './corpus.mts';
import { type ApiMessage, type Block, blocksOf, type Json, stripCacheControl } from './form.mts';

function stats(xs: number[]): string {
  if (xs.length === 0) {
    return 'none';
  }
  const s = [...xs].sort((p, q) => p - q);
  return `n=${s.length} min ${Math.round(s[0] as number)} median ${Math.round(s[Math.floor(s.length / 2)] as number)} max ${Math.round(s[s.length - 1] as number)} ms`;
}

const read = (dir: string, f: string): Json[] => (existsSync(join(dir, f)) ? readJsonl(join(dir, f)) : []);

export function seedReport(dir: string): string {
  const out: string[] = [];
  const files = read(dir, 'request-files.jsonl');
  const signals = read(dir, 'signals.jsonl');
  const otel = read(dir, 'otel-events.jsonl').filter((e) => e.name === 'api_request_body');
  const index = read(join(dir, 'api-bodies'), 'index.jsonl');
  const faults = read(dir, 'faults.jsonl').filter((f) => f.fault !== undefined);
  const events = read(dir, 'proof-events.jsonl');
  const seed = existsSync(join(dir, 'seed.json')) ? (JSON.parse(readFileSync(join(dir, 'seed.json'), 'utf8')) as Json) : {};
  const otelSource = new Map(otel.map((e) => [`${String((e.attrs as Json).request_body_id)}.request.json`, String((e.attrs as Json).query_source)]));
  const indexSource = new Map(index.map((e) => [String(e.request_file), String(e.query_source)]));
  const msgOfFile = new Map(index.map((e) => [String(e.request_file), String(e.message_id)]));
  const finalSig = new Map<string, Json>();
  const rechecks = new Map<string, number>();
  for (const s of signals) {
    finalSig.set(String(s.file), s);
    rechecks.set(String(s.file), Number(s.attempt ?? 0));
  }
  out.push(`== seed ${dir.split('/').slice(-1)[0]}: ${String(seed.model)} ${String(seed.scenario)}, session ${String(seed.sessionId)}`);
  out.push('   request files, in the order they appeared (source: OTEL per attempt / index.jsonl per success):');
  let mainTotal = 0;
  let mainFound = 0;
  let otherTotal = 0;
  let otherTaken = 0;
  let p16Main = 0;
  let p16Other = 0;
  let prevMain = 0;
  let prevOther = 0;
  const faultOf = new Map(faults.filter((f) => f.file).map((f) => [String(f.file), String(f.fault)]));
  for (const f of files) {
    const file = String(f.file);
    const src = otelSource.get(file) ?? indexSource.get(file);
    const truthMain = src === undefined ? undefined : src === 'sdk';
    const s = finalSig.get(file) ?? {};
    const verdict = s.main === true ? (s.retry ? 'main (retry)' : 'main') : 'other';
    if (truthMain === true) {
      mainTotal += 1;
      mainFound += s.main === true ? 1 : 0;
      p16Main += s.proof16Says === true ? 1 : 0;
      prevMain += s.prevIdSays === true ? 1 : 0;
    } else if (truthMain === false) {
      otherTotal += 1;
      otherTaken += s.main === true ? 1 : 0;
      p16Other += s.proof16Says === true ? 1 : 0;
      prevOther += s.prevIdSays === true ? 1 : 0;
    }
    const unc = ((s.uncovered as Json[] | undefined) ?? []).map((u) => String(u.text).replace(/\s+/g, ' ').slice(0, 60));
    out.push(
      `   ${file.slice(0, 8)} ${String(f.seenAt).slice(11, 23)} ${String(f.model).replace('claude-', '')} thread=${String((f.thread as Json | null)?.type ?? '-')} src=${src ?? '?'}${indexSource.has(file) ? '' : ' (no index line)'} | selector ${verdict}${rechecks.get(file) ? ` after ${rechecks.get(file)} recheck(s)` : ''}${s.resent && !s.retry ? `, ${String(s.resent)} re-sent block(s) cut` : ''} | p16 ${s.proof16Says ? 'main' : 'other'} | prevId ${s.prevIdSays === undefined ? '-' : s.prevIdSays ? 'main' : 'other'}${faultOf.has(file) ? ` | FAULT ${faultOf.get(file)}` : ''}${s.main && !s.retry ? ` | A: ${unc.length === 0 ? 'fully matched' : `UNMATCHED ${JSON.stringify(unc)}`}${((s.released as Json[] | undefined) ?? []).length ? ` released ${JSON.stringify(s.released)}` : ''}` : ''}`,
    );
  }
  out.push(`   selector: main found ${mainFound}/${mainTotal}; others taken as main ${otherTaken}/${otherTotal} (truth: OTEL query_source, else index.jsonl)`);
  out.push(`   proof 16 selector (model+thread): main ${p16Main}/${mainTotal}; others taken ${p16Other}/${otherTotal}`);
  out.push(`   previous_message_id alone: main ${prevMain}/${mainTotal}; others taken ${prevOther}/${otherTotal}`);
  out.push(`   faults: ${JSON.stringify(faults.map((f) => ({ step: f.step, fault: f.fault, how: f.how, file: String(f.file ?? '').slice(0, 8), tunnelsReset: f.tunnelsReset })))}`);
  out.push(`   api_retry on the SDK stream: ${JSON.stringify(events.filter((e) => e.apiRetry).map((e) => e.apiRetry))}`);
  // Published messages and turns.
  const published = read(dir, 'published-A.jsonl').filter((p) => String(p.subject).endsWith('changes.message'));
  const turnOfFile = new Map<string, string>();
  for (const s of signals) {
    if (typeof s.turnId === 'string' && !s.retry && !turnOfFile.has(String(s.file))) {
      turnOfFile.set(String(s.file), s.turnId);
    }
  }
  // A retry's response answers the logical request: its turn is the one
  // taken for the first attempt.
  const fileOfMsg = new Map([...msgOfFile].map(([f, m]) => [m, f]));
  let turnOk = 0;
  let turnBad = 0;
  let turnUnknown = 0;
  const bad: string[] = [];
  for (const p of published) {
    const b = p.body as Json;
    if (b.role !== 'assistant') {
      continue;
    }
    const msgId = String((b.ccResponse as Json).messageId);
    const f = fileOfMsg.get(msgId);
    const sig = f ? finalSig.get(f) : undefined;
    const expected = f ? (turnOfFile.get(f) ?? (sig?.retry ? String(sig.turnId) : undefined)) : undefined;
    if (!expected) {
      turnUnknown += 1;
    } else if (expected === b.turnId) {
      turnOk += 1;
    } else {
      turnBad += 1;
      bad.push(`${msgId.slice(0, 16)} published under ${String(b.turnId).slice(0, 8)}, its request ${String(f).slice(0, 8)} took ${expected.slice(0, 8)}`);
    }
  }
  const roles = new Map<string, number>();
  for (const p of published) {
    const r = String((p.body as Json).role);
    roles.set(r, (roles.get(r) ?? 0) + 1);
  }
  out.push(`   published: ${published.length} changes.message (${[...roles].map(([r, n]) => `${r} ${n}`).join(', ')}); entry-less messages ${published.filter((p) => Array.isArray((p.body as Json).ccEntries) && ((p.body as Json).ccEntries as unknown[]).length === 0).length}`);
  out.push(`   assistant pieces under their own request's turn: ${turnOk} yes, ${turnBad} no, ${turnUnknown} with no index line to check against${bad.length ? `; wrong: ${bad.join('; ')}` : ''}`);
  // Timing.
  const timing = read(dir, 'timing-A.jsonl');
  const fileMtime = new Map(files.map((f) => [String(f.file), Date.parse(String(f.fileMtime))]));
  const um = timing.filter((t) => t.role === 'user' || t.role === 'system');
  const am = timing.filter((t) => t.role === 'assistant');
  out.push(`   delay, user/system message published after its last entry reached the store: ${stats(um.map((t) => Number(t.waitAfterLastEntryMs)))}`);
  out.push(`   delay, user/system message published after its request file was written: ${stats(um.map((t) => Number(t.publishedMs) - (fileMtime.get(String(t.signal).split(' ')[1]) ?? Number.NaN)).filter((x) => !Number.isNaN(x)))}`);
  out.push(`   delay, assistant piece published after its entry reached the store: ${stats(am.map((t) => Number(t.waitAfterAppendMs)))}`);
  for (const t of um) {
    out.push(`      seq ${String(t.seq)} ${String(t.role)} ${String(t.id).slice(0, 8)}: ${Math.round(Number(t.waitAfterLastEntryMs))} ms after its last entry, ${Math.round(Number(t.publishedMs) - (fileMtime.get(String(t.signal).split(' ')[1]) ?? Number.NaN))} ms after the request file`);
  }
  const slowA = am.filter((t) => Number(t.waitAfterAppendMs) > 50);
  for (const t of slowA) {
    out.push(`      assistant ${String(t.id).slice(0, 8)} (${String(t.msgId).slice(0, 16)}) waited ${Math.round(Number(t.waitAfterAppendMs))} ms`);
  }
  for (const t of timing.filter((x) => x.released)) {
    out.push(`   released unpublished: ${JSON.stringify(t)}`);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

interface FirstRequest {
  dir: string;
  source: string;
  file: string;
  body: Json & { messages: ApiMessage[] };
  usage: Json;
}

function firstMain(dir: string): FirstRequest | undefined {
  const index = read(join(dir, 'api-bodies'), 'index.jsonl').filter((e) => e.query_source === 'sdk');
  const first = index[0];
  if (!first) {
    return undefined;
  }
  const body = JSON.parse(readFileSync(join(dir, 'api-bodies', String(first.request_file)), 'utf8')) as FirstRequest['body'];
  const resp = JSON.parse(readFileSync(join(dir, 'api-bodies', String(first.response_file)), 'utf8')) as Json;
  const meta = existsSync(join(dir, 'resume.json')) ? (JSON.parse(readFileSync(join(dir, 'resume.json'), 'utf8')) as Json) : {};
  return { dir, source: String(meta.source ?? '?'), file: String(first.request_file), body, usage: (resp.usage as Json) ?? {} };
}

function msgKey(m: ApiMessage): string {
  const content = typeof m.content === 'string' ? m.content : m.content.map((b) => {
    const kept = stripCacheControl(b);
    if (kept.type === 'thinking') {
      const { thinking: _t, ...rest } = kept;
      return rest;
    }
    return kept;
  });
  return JSON.stringify({ role: m.role, content, ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'role' && k !== 'content')) });
}

function billing(b: Json): Map<string, string> {
  const sys = (b.system as Block[] | undefined)?.[0];
  const text = String(sys?.text ?? '');
  const m = new Map<string, string>();
  for (const part of text.replace(/^x-anthropic-billing-header:\s*/, '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k) {
      m.set(k, v ?? '');
    }
  }
  return m;
}

function describe(m: ApiMessage | undefined): string {
  if (!m) {
    return '(none)';
  }
  return `${m.role}: ${blocksOf(m.content)
    .map((b) => (b.type === 'text' ? `text ${JSON.stringify(String(b.text).slice(0, 60))}` : String(b.type)))
    .join(' | ')}`;
}

export function resumeReport(dirs: string[]): string {
  const out: string[] = [];
  const runs = dirs.map(firstMain);
  const base = runs[0];
  if (!base) {
    return 'no first main request in the full resume\n';
  }
  const num = (v: unknown): string => (typeof v === 'number' ? String(v) : '-');
  for (const r of runs) {
    if (!r) {
      out.push('   (a run with no main request)');
      continue;
    }
    const thread = (r.body.thread as Json | undefined)?.type ?? '-';
    out.push(`-- ${r.source.padEnd(12)} ${r.dir.split('/').slice(-1)[0]} ${r.file.slice(0, 8)}: messages ${r.body.messages.length}, thread ${String(thread)}, system ${Array.isArray(r.body.system) ? 'sent' : 'omitted'}, tools ${Array.isArray(r.body.tools) ? (r.body.tools as unknown[]).length : 'omitted'} | input ${num(r.usage.input_tokens)} cache_read ${num(r.usage.cache_read_input_tokens)} cache_write ${num(r.usage.cache_creation_input_tokens)}`);
  }
  for (const r of runs.slice(1)) {
    if (!r) {
      continue;
    }
    out.push(`== ${r.source} vs ${base.source}`);
    const n = Math.max(base.body.messages.length, r.body.messages.length);
    const diffs: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const a = base.body.messages[i];
      const b = r.body.messages[i];
      if (!a || !b || msgKey(a) !== msgKey(b)) {
        diffs.push(i);
      }
    }
    out.push(`   messages: ${diffs.length === 0 ? 'identical (cache_control and redacted thinking text aside)' : `differ at ${diffs.join(', ')}`}`);
    for (const i of diffs.slice(0, 6)) {
      out.push(`      [${i}] full:   ${describe(base.body.messages[i])}`);
      out.push(`           ${r.source}: ${describe(r.body.messages[i])}`);
    }
    const skip = new Set(['messages', 'metadata', 'system']);
    const other = [...new Set([...Object.keys(base.body), ...Object.keys(r.body)])].filter((k) => !skip.has(k) && JSON.stringify(base.body[k]) !== JSON.stringify(r.body[k]));
    const sysA = JSON.stringify(((base.body.system as Block[] | undefined) ?? []).slice(1).map(stripCacheControl));
    const sysB = JSON.stringify(((r.body.system as Block[] | undefined) ?? []).slice(1).map(stripCacheControl));
    const ba = billing(base.body);
    const bb = billing(r.body);
    const billingDiff = [...new Set([...ba.keys(), ...bb.keys()])].filter((k) => ba.get(k) !== bb.get(k));
    out.push(`   other fields that differ: ${other.length ? other.map((k) => `${k} ${JSON.stringify(base.body[k]).slice(0, 80)} vs ${JSON.stringify(r.body[k]).slice(0, 80)}`).join('; ') : 'none'}; system after the billing header ${sysA === sysB ? 'same' : 'DIFFERS'}; billing header differs in ${billingDiff.length ? billingDiff.join(', ') : 'nothing'}; metadata ${JSON.stringify(base.body.metadata) === JSON.stringify(r.body.metadata) ? 'same' : 'differs (device_id is per config dir)'}`);
  }
  return `${out.join('\n')}\n`;
}
