// Integration proof, attempt 3: the invariant check.
//
//   node proofs/integration/invariant.mts <convId>... [--out <dir>]
//   node proofs/integration/invariant.mts --evidence <runs/i3-...> [--out <dir>]
//   node proofs/integration/invariant.mts --all [--out <dir>]
//
// Stephen's invariant: "at every moment, what's on tower is exactly the
// beginning of Claude Code's conversation. That means what it will build its
// next query on, in the shape the model received it, in order, with nothing
// missing and nothing extra. Claude Code is the source; tower only follows."
//
// This check reads two things and nothing the committer computes:
//   - tower, from the harness broker's JetStream (every changes.message on
//     the conversation, in stream order, with the broker's timestamp);
//   - Claude Code's own record of what the model received: the request and
//     response bodies Claude Code writes (OTEL_LOG_RAW_API_BODIES) under
//     every lineage of the conversation on this machine, every agent, plus
//     the participant's plain records of when things happened (serve, say,
//     result events; store appends with their instants).
// It never imports the committer, build(), select(), attributeMessages,
// requestUnits, kindOf or anything else the committer decides with.
//
// A request's history ("what the model received") is its messages behind the
// server-side thread it continues: the previous request's history, the
// previous response's content, then its own messages (resolved through
// index.jsonl, in any lineage of the conversation).
//
// The kinds of point, and what each is judged against:
//   commit/next   every message tower received: tower up to and including it
//                 must be a prefix of the history of the next main request
//                 any live (non-dry) Claude Code sends after it.
//   commit/own    every assistant piece: tower up to and including it must
//                 be a prefix of the history of the request that got that
//                 response plus the response's content (the question the
//                 reply answers must be on tower when the reply is). It can
//                 fail a commit but never pass one on its own: with no later
//                 request, nothing confirms Claude Code kept the reply.
//   quiet         after every query end, up to the next say, request or
//                 pickup (a point where nothing is in flight; a pickup's
//                 point is tower up to the seq it read): tower must be the
//                 whole conversation, so the next request from a Claude Code
//                 that holds the conversation independently of tower (the
//                 same live Claude Code, or one resumed from its own local
//                 record) must be tower plus only new input. Also at every
//                 quiet point and pickup: every user-side entry the Claude
//                 Code tower was following wrote before it (from its store
//                 appends) must be on tower; one that isn't is a hold.
//   request       every main request from a live Claude Code: by the end of
//                 the run its history must be on tower (a prefix of what
//                 tower ends with), unless a later request from the same
//                 Claude Code no longer carries it (Claude Code rewrote it).
//   admission     the committer's own notes that it couldn't place a request
//                 or a held side (committer.jsonl: unanchored, reply-held, order-warning,
//                 error, changed, late-insert): each a failure, never a pass.
//   republish     a message id tower received twice.
//
// Attempt 3's shadow (TODO: undecided, a test method): each run publishes one
// commit variant to tower and computes the other over the same recording,
// published under the conversation id `<id>~shadow` with its own committer
// notes (committer.shadow.jsonl). The check judges the shadow exactly as it
// judges tower (every kind of point above), writes it beside it as
// `<id>.shadow.md`, and compares the two message sequences. At a pickup the
// shadow's round-trip labels are approximate: every Claude Code resumed from
// tower was built from the live variant, not the shadow.
//
// Verdicts: PASS (checked against a truth independent of tower),
// ROUND-TRIP (the only truth was a Claude Code resumed from tower at or past
// this point: it rebuilt what tower held, so agreement proves only the round
// trip; never counted as a pass), UNCHECKED (no truth yet, with why), FAIL
// (with the divergence: where, what tower held, what Claude Code built on,
// and whether it is only a split or merge of consecutive same-role messages
// or only a trailing newline).
//
// TODO: undecided, each the check's own assumption (not a design decision,
// not Stephen's; each marked here so it reads as undecided):
//   - Grouping: tower messages that are consecutive, share a role and share a
//     turnId are one API message (Stephen's decision covers assistant pieces:
//     one turnId, one API message; the same rule is assumed for the user and
//     system side). A difference that disappears when every run of
//     consecutive same-role messages is merged, on both sides, is still a
//     divergence, reported as "split/merge only". The Messages API documents
//     "Consecutive `user` or `assistant` turns in your request will be
//     combined into a single turn" (platform.claude.com/docs/en/api/messages),
//     and says there is no "system" role for input messages, yet Claude Code
//     2.1.282 sends system-role messages mid-conversation.
//   - Block identity: thinking by signature (the body log redacts thinking
//     text), redacted_thinking by data, `cache_control` and `caller` ignored,
//     string content read as one text block; everything else byte for byte.
//   - Clock: the broker's JetStream timestamp is a commit's instant; a
//     request's is its body file's mtime; say/result/serve instants are the
//     participant's Date.now(). Checked, not assumed: every broker timestamp
//     is compared with the body's own `ts` (the commit instant the committer
//     stamped); a negative gap is reported.
//   - Main requests: the index line's query_source "sdk"; a request with no
//     index line (a response that never completed) counts when it carries a
//     `thread` and the conversation's model.
//   - Which process sent a request: the lineage's latest serve event at or
//     before the request file's mtime. A dry local check's copied bodies
//     (the same file name in the lineage it was copied from) are skipped.
//   - New input at a quiet point, for each atom of the truth request beyond
//     tower: new if it is the say's prompt or comes after it (Claude Code
//     appends new input at the end), or if Claude Code wrote an entry
//     carrying it at or after the say's instant and before the lineage's next
//     request (tool_result by tool_use_id,
//     text by its text); old, so missing from tower, if it is the model's own
//     output, a tool_result answering a tool_use tower already holds, or
//     carried only by entries written before the say; unplaced (the point is
//     UNCHECKED for it) if no entry carries it. The say, not the query end,
//     is the boundary: a store append can land a second or more after the
//     query ended.
//   - Holds: every user-type entry Claude Code writes is taken to be one it
//     sends (see holdJudgment).
//   - Process stop is not a point of its own: every stop in these scenarios
//     follows a query end with nothing between, so the query end's point
//     stands for it; a SIGKILL mid-query has no quiet point (its next point is
//     the pickup that follows).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { AUDIT_STREAM, NATS_URL } from '../semantic/tower.mts';
import { clean, fileStamp, INTEGRATION_STATE, type Json, readJsonl, RUNS, AGENT_PREFIX } from './lib.mts';

// ---------------------------------------------------------------------------
// Tower, read back from the broker.

export interface TowerMsg {
  seq: number;
  ms: number; // broker timestamp
  bodyTsMs: number; // the body's own ts
  id: string;
  role: string;
  turnId: string;
  content: Json[];
  queryId: string;
  instanceId: string;
}

export async function readTower(convId: string): Promise<TowerMsg[]> {
  const nc = await connect({ servers: NATS_URL, name: 'integration-3-invariant' });
  try {
    const jsm = await jetstreamManager(nc);
    const filter = `conv.v2.${convId}.changes.message`;
    const info = await jsm.streams.info(AUDIT_STREAM, { subjects_filter: filter });
    const count = Object.values(info.state.subjects ?? {}).reduce((a, n) => a + n, 0);
    if (count === 0) {
      return [];
    }
    const js = jetstream(nc);
    const consumer = await js.consumers.get(AUDIT_STREAM, { filter_subjects: filter });
    const out: TowerMsg[] = [];
    const messages = await consumer.consume();
    for await (const m of messages) {
      const b = m.json() as Json;
      out.push({
        seq: m.seq,
        ms: Number(m.timestampNanos) / 1_000_000,
        bodyTsMs: Date.parse(String(b.ts)),
        id: String(b.id),
        role: String(b.role),
        turnId: String(b.turnId),
        content: Array.isArray(b.content) ? (b.content as Json[]) : [],
        queryId: String(b.queryId),
        instanceId: String(b.instanceId),
      });
      if (m.info.pending === 0) {
        break;
      }
    }
    await messages.close();
    // Deleted at once: many reads in a row (the grid report) would otherwise
    // leave ordered consumers behind faster than the server expires them.
    await consumer.delete().catch(() => false);
    return out;
  } finally {
    await nc.close();
  }
}

// ---------------------------------------------------------------------------
// Claude Code's side, read from every lineage of the conversation.

interface Proc {
  key: string; // agent/lineage#n
  agent: string;
  lineage: string;
  serveMs: number;
  endMs: number; // next serve in the same lineage
  decision: string;
  dry: boolean;
  upto: number | null; // tower seq read at a pickup from tower
  asOfMs: number | null; // a dry local check's "as of"
  commit: string | null; // attempt 3: the live commit variant this serve named
  shadow: string | null;
}

interface Req {
  file: string;
  lineage: string;
  ms: number;
  proc: Proc;
  body: Json;
  index: Json | undefined;
  main: boolean;
}

interface Lin {
  dir: string;
  agent: string;
  meta: Json;
  events: Json[];
  appends: { ms: number; how: string; entry: Json }[];
  index: Json[];
  procs: Proc[];
}

export interface Evidence {
  convId: string;
  lins: Lin[];
  reqs: Req[]; // main requests of every process, in time order
  allReqs: Req[];
  byMessageId: Map<string, { lin: Lin; line: Json }>;
}

export function lineagesOf(convId: string, root = INTEGRATION_STATE): string[] {
  const out: string[] = [];
  if (!existsSync(root)) {
    return out;
  }
  for (const agent of readdirSync(root)) {
    const c = join(root, agent, 'conv', convId);
    if (!existsSync(c)) {
      continue;
    }
    for (const l of readdirSync(c)) {
      if (existsSync(join(c, l, 'lineage.json'))) {
        out.push(join(c, l));
      }
    }
  }
  return out.sort();
}

export function gather(convId: string, root = INTEGRATION_STATE): Evidence {
  const lins: Lin[] = [];
  for (const dir of lineagesOf(convId, root)) {
    const agent = basename(join(dir, '..', '..', '..'));
    const meta = JSON.parse(readFileSync(join(dir, 'lineage.json'), 'utf8')) as Json;
    const events = readJsonl(join(dir, 'next-events.jsonl'));
    const appends = readJsonl(join(dir, 'store-appends.jsonl'))
      .filter((a) => !(a.key as Json | undefined)?.subpath)
      .flatMap((a) => (a.entries as Json[]).map((entry) => ({ ms: Number(a.ms), how: String(a.how), entry })));
    const index = readJsonl(join(dir, 'api-bodies', 'index.jsonl'));
    const serves = events.filter((e) => e.src === 'participant' && e.kind === 'serve').sort((a, b) => Number(a.ms) - Number(b.ms));
    const procs: Proc[] = serves.map((s, i) => ({
      key: `${agent}/${basename(dir)}#${i + 1}`,
      agent,
      lineage: dir,
      serveMs: Number(s.ms),
      endMs: Number(serves[i + 1]?.ms ?? Number.POSITIVE_INFINITY),
      decision: String(s.decision),
      dry: s.dry === true,
      upto: s.decision === 'tower' && typeof s.upto === 'number' ? s.upto : null,
      asOfMs: typeof meta.asOfMs === 'number' ? meta.asOfMs : null,
      commit: typeof s.commit === 'string' ? s.commit : null,
      shadow: typeof s.shadow === 'string' ? s.shadow : null,
    }));
    lins.push({ dir, agent, meta, events, appends, index, procs });
  }
  const byMessageId = new Map<string, { lin: Lin; line: Json }>();
  for (const lin of lins) {
    for (const line of lin.index) {
      if (typeof line.message_id === 'string' && !byMessageId.has(line.message_id)) {
        byMessageId.set(line.message_id, { lin, line });
      }
    }
  }
  const allReqs: Req[] = [];
  for (const lin of lins) {
    const bodies = join(lin.dir, 'api-bodies');
    if (!existsSync(bodies)) {
      continue;
    }
    const copiedFrom = typeof lin.meta.dryOf === 'string' ? join(String(lin.meta.dryOf), 'api-bodies') : undefined;
    for (const f of readdirSync(bodies).filter((x) => x.endsWith('.request.json'))) {
      if (copiedFrom && existsSync(join(copiedFrom, f))) {
        continue; // a dry check's copy of the lineage it was made from
      }
      const ms = statSync(join(bodies, f)).mtimeMs;
      const proc = [...lin.procs].reverse().find((p) => p.serveMs <= ms);
      if (!proc) {
        continue;
      }
      const body = JSON.parse(readFileSync(join(bodies, f), 'utf8')) as Json;
      const index = lin.index.find((l) => l.request_file === f);
      const main = index ? index.query_source === 'sdk' : body.thread !== undefined && body.model === lin.meta.model;
      allReqs.push({ file: f, lineage: lin.dir, ms, proc, body, index, main });
    }
  }
  allReqs.sort((a, b) => a.ms - b.ms);
  return { convId, lins, reqs: allReqs.filter((r) => r.main), allReqs, byMessageId };
}

// ---------------------------------------------------------------------------
// Blocks and messages, in one comparable form.

interface Blk {
  key: string;
  nl: string; // key with trailing newlines of text trimmed
  show: string;
}

interface Msg {
  role: string;
  blocks: Blk[];
  from: string; // where it came from (tower seqs, or a request/response file)
}

function canon(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map(canon).join(',')}]`;
  }
  if (v && typeof v === 'object') {
    const o = v as Json;
    return `{${Object.keys(o)
      .filter((k) => k !== 'cache_control' && k !== 'caller')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const listOf = (c: unknown): Json[] => (typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? (c as Json[]) : []);
const trimNl = (s: string): string => s.replace(/\n+$/, '');
const cut = (s: string, n = 60): string => JSON.stringify(s.length > n ? `${s.slice(0, n)}...` : s);

function blk(b: Json): Blk {
  const t = String(b.type);
  if (t === 'text') {
    const x = String(b.text ?? '');
    return { key: `text:${x}`, nl: `text:${trimNl(x)}`, show: `text ${cut(x)}` };
  }
  if (t === 'thinking') {
    const k = `thinking:${String(b.signature ?? '')}`;
    return { key: k, nl: k, show: `thinking sig ${String(b.signature ?? '').slice(0, 10)}` };
  }
  if (t === 'redacted_thinking') {
    const k = `redacted:${String(b.data ?? '')}`;
    return { key: k, nl: k, show: 'redacted_thinking' };
  }
  if (t === 'tool_use') {
    const k = `tool_use:${String(b.id)}:${String(b.name)}:${canon(b.input ?? null)}`;
    return { key: k, nl: k, show: `tool_use ${String(b.name)} ${String(b.id).slice(-6)}` };
  }
  if (t === 'tool_result') {
    const inner = listOf(b.content).map((x) => (x.type === 'text' ? { ...x, text: String(x.text ?? '') } : x));
    const base = `tool_result:${String(b.tool_use_id)}:${b.is_error === true}:`;
    const txt = inner.map((x) => String(x.text ?? '')).join('\n');
    return { key: base + canon(inner), nl: base + canon(inner.map((x) => (x.type === 'text' ? { ...x, text: trimNl(String(x.text)) } : x))), show: `tool_result ${String(b.tool_use_id).slice(-6)}${b.is_error ? ' error' : ''} ${cut(txt, 50)}` };
  }
  const k = `${t}:${canon(b)}`;
  return { key: k, nl: k, show: t };
}

const msgOf = (role: string, content: unknown, from: string): Msg => ({ role, blocks: listOf(content).map(blk), from });

// Tower's messages grouped into API messages (see the grouping TODO above).
function towerApi(ms: TowerMsg[]): Msg[] {
  const out: (Msg & { turnId: string })[] = [];
  for (const m of ms) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && last.turnId === m.turnId) {
      last.blocks.push(...m.content.map(blk));
      last.from += `,${m.seq}`;
    } else {
      out.push({ role: m.role, turnId: m.turnId, blocks: m.content.map(blk), from: `seq ${m.seq}` });
    }
  }
  return out;
}

// Every run of consecutive same-role messages merged into one.
function merged(ms: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const m of ms) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      out[out.length - 1] = { role: m.role, blocks: [...last.blocks, ...m.blocks], from: `${last.from}+${m.from}` };
    } else {
      out.push({ role: m.role, blocks: [...m.blocks], from: m.from });
    }
  }
  return out;
}

// A request's history: the thread it continues, then its own messages.
export function history(ev: Evidence, lineage: string, file: string, depth = 0): { messages: Msg[]; chain: string[] } | { error: string } {
  const body = JSON.parse(readFileSync(join(lineage, 'api-bodies', file), 'utf8')) as Json;
  const own = ((body.messages as Json[]) ?? []).map((m, i) => msgOf(String(m.role), m.content, `${file.slice(0, 8)} msg ${i}`));
  const thread = body.thread as Json | undefined;
  if (!thread || thread.type !== 'continue') {
    return { messages: own, chain: [`${file}(${thread ? String(thread.type) : 'no thread'})`] };
  }
  if (depth > 100) {
    return { error: `thread chain deeper than 100 at ${file}` };
  }
  const prevId = String(thread.previous_message_id);
  const sameLin = ev.lins.find((l) => l.dir === lineage)?.index.find((l) => l.message_id === prevId);
  const found = sameLin ? { lin: ev.lins.find((l) => l.dir === lineage) as Lin, line: sameLin } : ev.byMessageId.get(prevId);
  if (!found || typeof found.line.request_file !== 'string' || typeof found.line.response_file !== 'string') {
    return { error: `${file} continues ${prevId}, which no index line of this conversation records with a request and a response` };
  }
  const prev = history(ev, found.lin.dir, found.line.request_file, depth + 1);
  if ('error' in prev) {
    return prev;
  }
  const resp = JSON.parse(readFileSync(join(found.lin.dir, 'api-bodies', found.line.response_file), 'utf8')) as Json;
  return { messages: [...prev.messages, msgOf('assistant', resp.content, `${String(found.line.response_file).slice(0, 12)} response`), ...own], chain: [...prev.chain, `${file}(continue)`] };
}

// ---------------------------------------------------------------------------
// Tower against a truth: is tower a prefix of it?
//
// Two levels. Exact: API message for API message, block for block. Content:
// both sides flattened to atoms (each tool_use, tool_result, thinking block;
// each <system-reminder> span and each stretch of other text, trimmed), with
// their role, ignoring message and text-block boundaries. A difference at the
// exact level only is a shape divergence (a split or merge of consecutive
// same-role messages, text blocks split or joined, a trailing newline); a
// difference at the content level is a content divergence.

interface Atom {
  role: string;
  key: string;
  show: string;
  text: string | null; // a text atom's text
  from: string;
}

interface Divergence {
  kind: 'content' | 'shape only';
  shape: string[]; // for shape only: which
  shapeDiffs: string[]; // every exact-level difference found, message by message (indicative once counts differ)
  at: string; // the first exact-level difference
  tower: string;
  truth: string;
  contentAt?: string; // the first content-level difference
  towerAtoms?: string[];
  truthAtoms?: string[];
  towerShape: string;
  truthShape: string;
}

interface Prefix {
  ok: boolean; // exact
  contentOk: boolean;
  divergence?: Divergence;
  // What the truth has beyond tower, as atoms (when the content level holds).
  remainder: Atom[];
}

const shape = (ms: Msg[]): string => ms.map((m) => `${m.role[0]}${m.blocks.length}`).join(' ');
const showMsg = (m: Msg | undefined): string => (m ? `${m.role} [${m.blocks.map((b) => b.show).join(' | ')}] (${m.from})` : '(nothing)');

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function segments(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(REMINDER)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push(before);
    out.push(m[0].trim());
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push(rest);
  return out;
}

// Paragraphs: Claude Code joins reminders (wrapped or, on Opus and Fable,
// unwrapped) into one text block with blank lines between, where tower may
// hold them as blocks of their own; splitting at blank lines on both sides
// makes that a difference of shape, not of content.
const paras = (s: string): string[] => s.split(/\n[ \t]*\n/).map((x) => x.trim()).filter(Boolean);

function atoms(ms: Msg[]): Atom[] {
  const out: Atom[] = [];
  for (const m of ms) {
    for (const b of m.blocks) {
      if (b.key.startsWith('text:')) {
        for (const s of segments(b.key.slice(5)).flatMap(paras)) {
          out.push({ role: m.role, key: `text:${s}`, show: `text ${cut(s)}`, text: s, from: m.from });
        }
      } else {
        out.push({ role: m.role, key: b.nl, show: b.show, text: null, from: m.from });
      }
    }
  }
  return out;
}

function exactPrefix(t: Msg[], h: Msg[], key: 'key' | 'nl'): { ok: boolean; mi: number; bi: number } {
  for (let i = 0; i < t.length; i += 1) {
    const a = t[i] as Msg;
    const b = h[i];
    if (!b || a.role !== b.role) {
      return { ok: false, mi: i, bi: 0 };
    }
    const last = i === t.length - 1;
    for (let j = 0; j < Math.max(a.blocks.length, last ? 0 : b.blocks.length); j += 1) {
      if (a.blocks[j]?.[key] !== b.blocks[j]?.[key]) {
        return { ok: false, mi: i, bi: j };
      }
    }
  }
  return { ok: true, mi: -1, bi: -1 };
}

function shapeDiffs(t: Msg[], h: Msg[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(t.length, h.length) && out.length < 12; i += 1) {
    const a = t[i] as Msg;
    const b = h[i] as Msg;
    if (a.role !== b.role) {
      out.push(`API message ${i}: tower ${a.role} (${a.from}), Claude Code ${b.role} (${b.from}); messages no longer line up after this`);
      break;
    }
    const last = i === t.length - 1;
    if (a.blocks.length !== b.blocks.length && !(last && a.blocks.length < b.blocks.length)) {
      out.push(`API message ${i} ${a.role}: tower ${a.blocks.length} block(s) (${a.from}), Claude Code ${b.blocks.length} (${b.from})`);
      continue;
    }
    a.blocks.forEach((x, j) => {
      const y = b.blocks[j];
      if (y && x.key !== y.key) {
        out.push(`API message ${i} ${a.role} block ${j}: ${x.nl === y.nl ? 'trailing newline' : 'differs'} (${x.show})`);
      }
    });
  }
  return out;
}

const around = (xs: Atom[], i: number): string[] => xs.slice(Math.max(0, i - 1), i + 3).map((a, k) => `${Math.max(0, i - 1) + k === i ? '>' : ' '} ${a.role} ${a.show} (${a.from})`);

export function towerPrefixOf(tower: Msg[], truth: Msg[]): Prefix {
  const ta = atoms(tower);
  const ha = atoms(truth);
  let ci = -1;
  for (let i = 0; i < ta.length; i += 1) {
    if (ta[i]?.role !== ha[i]?.role || ta[i]?.key !== ha[i]?.key) {
      ci = i;
      break;
    }
  }
  const contentOk = ci < 0;
  const remainder = contentOk ? ha.slice(ta.length) : [];
  const strict = exactPrefix(tower, truth, 'key');
  if (strict.ok) {
    return contentOk ? { ok: true, contentOk, remainder } : { ok: true, contentOk, remainder };
  }
  const shapeTags: string[] = [];
  if (contentOk) {
    if (exactPrefix(tower, truth, 'nl').ok) {
      shapeTags.push('trailing newline');
    } else if (exactPrefix(merged(tower), merged(truth), 'key').ok) {
      shapeTags.push('split/merge of consecutive same-role messages');
    } else if (exactPrefix(merged(tower), merged(truth), 'nl').ok) {
      shapeTags.push('split/merge of consecutive same-role messages', 'trailing newline');
    } else {
      shapeTags.push('text blocks split or joined (reminders and text as separate blocks on one side, one block on the other), possibly with trailing newlines');
    }
  }
  const tm = tower[strict.mi];
  const hm = truth[strict.mi];
  return {
    ok: false,
    contentOk,
    remainder,
    divergence: {
      kind: contentOk ? 'shape only' : 'content',
      shape: shapeTags,
      shapeDiffs: shapeDiffs(tower, truth),
      at: `API message ${strict.mi}, block ${strict.bi}`,
      tower: `${showMsg(tm)}${tm ? `; block ${strict.bi}: ${tm.blocks[strict.bi]?.show ?? '(none)'}` : ''}`,
      truth: `${showMsg(hm)}${hm ? `; block ${strict.bi}: ${hm.blocks[strict.bi]?.show ?? '(none)'}` : ''}`,
      ...(contentOk ? {} : { contentAt: `atom ${ci} of tower's ${ta.length} (truth has ${ha.length})`, towerAtoms: around(ta, ci), truthAtoms: around(ha, ci) }),
      towerShape: shape(tower),
      truthShape: shape(truth),
    },
  };
}


// ---------------------------------------------------------------------------
// Points and verdicts.

export type Verdict = 'PASS' | 'ROUND-TRIP' | 'UNCHECKED' | 'FAIL';

export interface Judgment {
  truth: string; // which truth: next request, own request, independent restart, ...
  request?: string; // agent/lineage/file
  sender?: string; // the process that sent it and how it got the conversation
  verdict: Verdict;
  why: string;
  divergence?: Divergence;
  newInput?: string[];
  missing?: string[];
  unplaced?: string[];
  roundTrip?: boolean;
  // No later request confirms Claude Code kept what this judgment passes.
  unconfirmed?: boolean;
  // The verdict with shape-only divergences set aside (see contentOf).
  contentVerdict?: Verdict;
}

export interface Point {
  kind: 'commit' | 'quiet' | 'pickup' | 'request' | 'admission' | 'republish' | 'clock';
  label: string;
  towerUpTo: number | null; // seq
  towerCount: number;
  judgments: Judgment[];
  verdict: Verdict;
  contentVerdict: Verdict;
}

// A shape-only divergence is still a FAIL (Stephen: "in the shape the model
// received it"); the content verdict sets it aside, so a content divergence
// can't hide among shape ones.
function contentOf(j: Judgment): Verdict {
  if (j.unconfirmed && (j.verdict === 'PASS' || (j.verdict === 'FAIL' && j.divergence?.kind === 'shape only' && !j.missing?.length))) {
    return 'UNCHECKED';
  }
  if (j.verdict === 'FAIL' && j.divergence?.kind === 'shape only' && !j.missing?.length) {
    return j.unplaced?.length ? 'UNCHECKED' : j.roundTrip ? 'ROUND-TRIP' : 'PASS';
  }
  return j.verdict;
}

function overall(js: Judgment[]): Verdict {
  if (js.some((j) => j.verdict === 'FAIL')) return 'FAIL';
  if (js.some((j) => j.verdict === 'PASS')) return 'PASS';
  if (js.some((j) => j.verdict === 'ROUND-TRIP')) return 'ROUND-TRIP';
  return 'UNCHECKED';
}

const procDesc = (p: Proc): string => `${p.key} (${p.commit ? `commit ${p.commit}${p.shadow ? `, shadow ${p.shadow}` : ''}; ` : ''}${p.dry ? 'dry, ' : ''}${p.decision === 'tower' ? `resumed from tower at seq ${p.upto}` : p.decision === 'fresh' ? 'fresh' : p.decision === 'local' ? `resumed from its own local record${p.asOfMs ? ` as of ${new Date(p.asOfMs).toISOString()}` : ''}` : p.decision})`;
const reqName = (r: Req): string => `${r.proc.agent}/${basename(r.lineage)}/${r.file}`;

// A request is a round trip for tower up to `seq` when its sender was resumed
// from tower at or past that seq: it rebuilt what tower held.
const roundTrip = (r: Req, seq: number): boolean => r.proc.decision === 'tower' && r.proc.upto !== null && r.proc.upto >= seq;

function judgePrefix(ev: Evidence, tower: Msg[], r: Req, seq: number, truth: string, extra?: Msg[]): Judgment {
  const h = history(ev, r.lineage, r.file);
  if ('error' in h) {
    return { truth, request: reqName(r), sender: procDesc(r.proc), verdict: 'UNCHECKED', why: `the request's history can't be rebuilt: ${h.error}` };
  }
  const full = extra ? [...h.messages, ...extra] : h.messages;
  const p = towerPrefixOf(tower, full);
  const rt = roundTrip(r, seq);
  if (!p.ok) {
    return { truth, request: reqName(r), sender: procDesc(r.proc), verdict: 'FAIL', why: `tower is not the start of what ${rt ? 'this Claude Code (resumed from tower) built on' : 'Claude Code built on'}: ${kindOfDiv(p.divergence)}`, divergence: p.divergence, roundTrip: rt };
  }
  return { truth, request: reqName(r), sender: procDesc(r.proc), verdict: rt ? 'ROUND-TRIP' : 'PASS', why: rt ? 'tower is a prefix, but the sender rebuilt its history from tower' : `tower is a prefix (${p.remainder.length} atom(s) of the truth beyond it)` };
}

// towerPrefixOf(request, tower) names the sides the other way round.
const swap = (d: Divergence): Divergence => ({ ...d, tower: d.truth, truth: d.tower, towerAtoms: d.truthAtoms, truthAtoms: d.towerAtoms, towerShape: d.truthShape, truthShape: d.towerShape });
const kindOfDiv = (d: Divergence | undefined): string => (d ? (d.kind === 'content' ? 'content differs' : `shape only (${d.shape.join('; ')})`) : '');

// Every string inside an entry, for placing a request's block on the entry
// Claude Code wrote it from.
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) strings(x, out);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v as Json)) strings(x, out);
  }
  return out;
}

function carries(e: Json, a: Atom): boolean {
  if (a.role === 'assistant') {
    return false;
  }
  if (a.key.startsWith('tool_result:')) {
    const id = a.key.split(':')[1];
    return listOf((e.message as Json | undefined)?.content).some((x) => x.type === 'tool_result' && String(x.tool_use_id) === id);
  }
  if (a.text === null) {
    return false;
  }
  const x = a.text.trim();
  if (x === '') {
    return false;
  }
  return strings(e).some((s) => {
    const t = s.trim();
    return t === x || `<system-reminder>\n${t}\n</system-reminder>` === x || (x.length >= 30 && t.includes(x)) || (t.length >= 30 && x.includes(t));
  });
}

// The truth request's blocks beyond tower, sorted into new input and old.
function sortRemainder(lin: Lin, rem: Prefix['remainder'], pointMs: number, reqMs: number, towerAtoms: Atom[]): { newInput: string[]; missing: string[]; unplaced: string[] } {
  const out = { newInput: [] as string[], missing: [] as string[], unplaced: [] as string[] };
  // The say that started this request (the latest say in its lineage between
  // the point and the request): Claude Code appends new input at the end, so
  // its prompt and everything after it in the request are new.
  const say = lin.events.filter((e) => e.src === 'participant' && e.kind === 'say' && Number(e.ms) > pointMs && Number(e.ms) <= reqMs).at(-1);
  const sayText = typeof say?.text === 'string' ? say.text.trim() : undefined;
  let from = Number.POSITIVE_INFINITY;
  if (sayText) {
    rem.forEach((a, i) => {
      if (a.role === 'user' && a.text === sayText) from = i;
    });
  }
  // Old versus new by the say's instant, not the point's: a store append
  // can land a second or more after the query ended (auto mode), and nothing
  // written before the say is its input.
  const boundary = say ? Number(say.ms) : pointMs;
  const untilMs = Math.min(...lin.events.filter((e) => e.src === 'bodies' && e.kind === 'request' && Number(e.ms) > reqMs).map((e) => Number(e.ms)), Number.POSITIVE_INFINITY);
  const onTowerToolUse = new Set(towerAtoms.filter((a) => a.key.startsWith('tool_use:')).map((a) => a.key.split(':')[1]));
  for (const [i, r] of rem.entries()) {
    if (r.key.startsWith('tool_result:') && onTowerToolUse.has(r.key.split(':')[1]) && i < from) {
      out.missing.push(`${r.role} ${r.show} (answers a tool_use tower already holds, so it can't be new input)`);
      continue;
    }
    if (i >= from) {
      out.newInput.push(`${r.role} ${r.show}${i === from ? ' (the say\'s prompt)' : ' (after the say\'s prompt)'}`);
      continue;
    }
    const d = `${r.role} ${r.show}`;
    if (r.role === 'assistant') {
      out.missing.push(`${d} (the model's own output, from before this request)`);
      continue;
    }
    // Entries written up to the lineage's next request: Claude Code mirrors
    // a say's entries into the store ~80 ms after the request file.
    const hits = lin.appends.filter((a) => a.ms < untilMs && carries(a.entry, r));
    if (hits.some((a) => a.ms >= boundary)) {
      out.newInput.push(d);
    } else if (hits.length > 0) {
      out.missing.push(`${d} (written ${new Date(Math.min(...hits.map((a) => a.ms))).toISOString()}, entry ${String(hits[0]?.entry.uuid ?? '-').slice(0, 8)}, before the say that started this request)`);
    } else {
      out.unplaced.push(d);
    }
  }
  return out;
}

export interface Report {
  convId: string;
  which: string; // 'tower' or 'shadow (<id>~shadow)'
  evidence: string[]; // the runs/ dirs that named it, when given
  agents: string[];
  lineages: { dir: string; origin: unknown; procs: string[] }[];
  tower: { seq: number; ms: string; id: string; role: string; turnId: string; blocks: string }[];
  clock: { minGapMs: number | null; maxGapMs: number | null; negative: number };
  points: Point[];
  counts: Record<Verdict, number>;
  contentCounts: Record<Verdict, number>; // with shape-only divergences set aside
}

export function judge(ev: Evidence, tower: TowerMsg[], suffix = ''): Report {
  const points: Point[] = [];
  const upTo = (n: number): Msg[] => towerApi(tower.slice(0, n));
  const liveReqs = ev.reqs.filter((r) => !r.proc.dry);
  const push = (p: Omit<Point, 'verdict' | 'contentVerdict'>): void => {
    const judgments = p.judgments.map((j) => ({ ...j, contentVerdict: contentOf(j) }));
    points.push({ ...p, judgments, verdict: overall(judgments), contentVerdict: overall(judgments.map((j) => ({ ...j, verdict: j.contentVerdict }))) });
  };

  // Clock: broker timestamp against the commit instant the body carries.
  const gaps = tower.map((m) => m.ms - m.bodyTsMs).filter((g) => Number.isFinite(g));
  const clock = { minGapMs: gaps.length ? Math.min(...gaps) : null, maxGapMs: gaps.length ? Math.max(...gaps) : null, negative: gaps.filter((g) => g < 0).length };
  if (clock.negative > 0) {
    push({ kind: 'clock', label: 'broker timestamps behind the bodies\' own commit instants', towerUpTo: null, towerCount: tower.length, judgments: [{ truth: 'clock', verdict: 'UNCHECKED', why: `${clock.negative} message(s) with a broker timestamp before the body's ts (min gap ${clock.minGapMs} ms): instants compared across the two clocks may be misordered` }] });
  }

  // Republishes.
  const seen = new Map<string, number>();
  for (const m of tower) {
    if (seen.has(m.id)) {
      push({ kind: 'republish', label: `message ${m.id} published again at seq ${m.seq} (first at seq ${seen.get(m.id)})`, towerUpTo: m.seq, towerCount: 0, judgments: [{ truth: 'a commit is a fact', verdict: 'FAIL', why: 'the same message id reached tower twice' }] });
    } else {
      seen.set(m.id, m.seq);
    }
  }

  // Commits.
  tower.forEach((m, i) => {
    const T = upTo(i + 1);
    const js: Judgment[] = [];
    const next = liveReqs.find((r) => r.ms > m.ms);
    if (!next) {
      js.push({ truth: 'next request', verdict: 'UNCHECKED', why: 'no main request from a live Claude Code after this commit' });
    } else {
      js.push(judgePrefix(ev, T, next, m.seq, 'next request'));
      if (roundTrip(next, m.seq)) {
        // The next request only checks the round trip: the next one after it
        // from a Claude Code that didn't rebuild this commit from tower.
        const indep = liveReqs.find((r) => r.ms > m.ms && !roundTrip(r, m.seq));
        if (indep) {
          js.push(judgePrefix(ev, T, indep, m.seq, 'next request independent of tower'));
        } else {
          js.push({ truth: 'next request independent of tower', verdict: 'UNCHECKED', why: 'every later request came from a Claude Code resumed from tower at or past this commit' });
        }
      }
    }
    if (m.role === 'assistant') {
      const own = ev.byMessageId.get(m.turnId);
      const file = own?.line.request_file;
      const r = typeof file === 'string' ? ev.allReqs.find((x) => x.file === file && x.lineage === own?.lin.dir) : undefined;
      if (!own || !r || typeof own.line.response_file !== 'string') {
        js.push({ truth: 'own request + response', verdict: 'UNCHECKED', why: `no index line records a request and response for turnId ${m.turnId} (an interrupted response has none)` });
      } else {
        const resp = JSON.parse(readFileSync(join(own.lin.dir, 'api-bodies', String(own.line.response_file)), 'utf8')) as Json;
        const j = judgePrefix(ev, T, r, m.seq, 'own request + response', [msgOf('assistant', resp.content, `${String(own.line.response_file).slice(0, 12)} response`)]);
        if (j.verdict === 'FAIL') {
          j.why = `tower holds this reply piece but not exactly what the model received before producing it: ${kindOfDiv(j.divergence)}`;
        }
        // The message this reply answers: the request's user side after its
        // last assistant message. Each of its atoms must be on tower before
        // this piece (counted, so an earlier identical reminder is used once).
        const h = history(ev, r.lineage, r.file);
        if (!('error' in h)) {
          let la = -1;
          h.messages.forEach((mm, k) => {
            if (mm.role === 'assistant') la = k;
          });
          const have = new Map<string, number>();
          for (const a of atoms(upTo(i))) {
            have.set(`${a.role}|${a.key}`, (have.get(`${a.role}|${a.key}`) ?? 0) + 1);
          }
          const lacking = atoms(h.messages.slice(la + 1)).filter((a) => {
            const c = have.get(`${a.role}|${a.key}`) ?? 0;
            if (c > 0) {
              have.set(`${a.role}|${a.key}`, c - 1);
              return false;
            }
            return true;
          });
          if (lacking.length > 0) {
            j.verdict = 'FAIL';
            j.missing = lacking.map((a) => `${a.role} ${a.show}`);
            j.why = `tower holds this reply piece but not the message it answers: ${lacking.length} of its atom(s) are not on tower before it${j.divergence ? `; and ${kindOfDiv(j.divergence)}` : ''}`;
          }
        }
        if (!next) {
          // The own request is a truth for what came before the reply, not
          // for whether Claude Code kept the reply: with no later request it
          // can fail the point but never pass it.
          j.unconfirmed = true;
          if (j.verdict === 'PASS') {
            j.verdict = 'UNCHECKED';
            j.why = 'the message this reply answers is on tower, but no later request confirms Claude Code kept the reply';
          }
        }
        js.push(j);
      }
    }
    push({ kind: 'commit', label: `seq ${m.seq} ${m.role} ${m.id.slice(0, 8)} [${m.content.map((b) => blk(b).show).join(' | ')}]`, towerUpTo: m.seq, towerCount: i + 1, judgments: js });
  });

  // Quiet points: every query end of a live Claude Code; the window closes at
  // the next say, request or pickup.
  const results: { ms: number; lin: Lin; proc: Proc; e: Json }[] = [];
  for (const lin of ev.lins) {
    for (const e of lin.events.filter((x) => x.src === 'sdk' && x.kind === 'result')) {
      const proc = [...lin.procs].reverse().find((p) => p.serveMs <= Number(e.ms));
      if (proc && !proc.dry) {
        results.push({ ms: Number(e.ms), lin, proc, e });
      }
    }
  }
  results.sort((a, b) => a.ms - b.ms);
  const liveSays = ev.lins.flatMap((l) => l.events.filter((e) => e.src === 'participant' && e.kind === 'say').map((e) => ({ ms: Number(e.ms), lin: l }))).filter((s) => {
    const p = [...s.lin.procs].reverse().find((x) => x.serveMs <= s.ms);
    return p !== undefined && !p.dry;
  });
  const livePickups = ev.lins.flatMap((l) => l.procs).filter((p) => !p.dry);
  for (const q of results) {
    const closes = [...liveReqs.map((r) => r.ms), ...liveSays.map((s) => s.ms), ...livePickups.map((p) => p.serveMs)].filter((x) => x > q.ms);
    const closeMs = closes.length ? Math.min(...closes) : Number.POSITIVE_INFINITY;
    const n = tower.filter((m) => m.ms < closeMs).length;
    const T = upTo(n);
    const seq = tower[n - 1]?.seq ?? 0;
    const pickup = livePickups.find((p) => p.serveMs === closeMs);
    const js = quietJudgments(ev, T, seq, q.ms, q.proc, liveReqs);
    const hold = holdJudgment(ev, q.proc, T, closeMs, upTo(tower.length));
    if (hold) js.push(hold);
    push({ kind: 'quiet', label: `query end ${new Date(q.ms).toISOString()} (${q.proc.key}, ${String(q.e.subtype)}/${String(q.e.reason)}); tower through seq ${seq}${pickup ? `; closes at ${pickup.key}'s pickup` : ''}`, towerUpTo: seq, towerCount: n, judgments: js });
  }
  // Pickups from tower: tower as that process read it, against the Claude
  // Code tower was following before.
  for (const p of livePickups.filter((x) => x.decision === 'tower')) {
    const n = tower.filter((m) => m.seq <= (p.upto ?? 0)).length;
    const T = upTo(n);
    const before = results.filter((q) => q.ms < p.serveMs).at(-1);
    const prev = [...liveReqs].reverse().find((r) => r.ms < p.serveMs);
    const js: Judgment[] = [];
    if (!prev) {
      js.push({ truth: 'the Claude Code tower followed before', verdict: 'UNCHECKED', why: 'no earlier request' });
    } else {
      // The previous Claude Code's own later requests (it kept running, or a
      // restart of it from its own record) are its truth after the pickup.
      const later = liveReqs.find((r) => r.ms > p.serveMs && r.proc.lineage === prev.proc.lineage && r.proc.decision !== 'tower');
      // Or a dry restart of it from its own record "as of" an instant after
      // its last query end and before this pickup (attempt 3's truth probe):
      // its first request is what that Claude Code held then.
      const lastEnd = results.filter((q) => q.proc === prev.proc && q.ms < p.serveMs).at(-1)?.ms ?? prev.proc.serveMs;
      const dry = ev.reqs.find((r) => r.proc.dry && (r.proc.decision === 'local' || r.proc.decision === 'record') && r.proc.asOfMs !== null && r.proc.asOfMs >= lastEnd - 1 && r.proc.asOfMs <= p.serveMs && ev.lins.find((l) => l.dir === r.proc.lineage)?.meta.dryOf === prev.proc.lineage);
      if (later) {
        js.push(...quietJudgments(ev, T, p.upto ?? 0, before?.ms ?? p.serveMs, later.proc, [later]));
      } else if (dry) {
        js.push(...quietJudgments(ev, T, p.upto ?? 0, dry.proc.asOfMs as number, dry.proc, [dry], `a dry restart of ${prev.proc.key} from its own record as of ${new Date(dry.proc.asOfMs as number).toISOString()}`));
      } else {
        js.push({ truth: 'the Claude Code tower followed before', verdict: 'UNCHECKED', why: `${prev.proc.key} sent no request after this point and no restart of it from its own record did: its conversation at the pickup is not known from what the model received` });
      }
    }
    if (prev) {
      const hold = holdJudgment(ev, prev.proc, T, p.serveMs, upTo(tower.length));
      if (hold) js.push(hold);
    }
    const first = liveReqs.find((r) => r.proc === p);
    if (first) {
      js.push(judgePrefix(ev, T, first, p.upto ?? 0, 'the pickup\'s own first request'));
    }
    push({ kind: 'pickup', label: `${procDesc(p)} at ${new Date(p.serveMs).toISOString()}`, towerUpTo: p.upto, towerCount: n, judgments: js });
  }

  // Requests: each live main request's history on tower by the end.
  const F = upTo(tower.length);
  for (const r of liveReqs) {
    const h = history(ev, r.lineage, r.file);
    if ('error' in h) {
      push({ kind: 'request', label: reqName(r), towerUpTo: null, towerCount: tower.length, judgments: [{ truth: 'its own history', request: reqName(r), sender: procDesc(r.proc), verdict: 'UNCHECKED', why: h.error }] });
      continue;
    }
    const p = towerPrefixOf(h.messages, F);
    let j: Judgment;
    if (p.ok) {
      j = { truth: 'its own history', request: reqName(r), sender: procDesc(r.proc), verdict: 'PASS', why: 'its history is on tower by the end' };
    } else {
      // Rewritten by Claude Code itself? A later request from the same
      // Claude Code that no longer carries this history.
      const laterSame = liveReqs.filter((x) => x.ms > r.ms && x.proc === r.proc);
      const rewritten = laterSame.find((x) => {
        const hx = history(ev, x.lineage, x.file);
        return !('error' in hx) && !towerPrefixOf(h.messages, hx.messages).contentOk;
      });
      j = rewritten
        ? { truth: 'its own history', request: reqName(r), sender: procDesc(r.proc), verdict: 'UNCHECKED', why: `not on tower by the end, but ${rewritten.file} from the same Claude Code no longer carries it either`, divergence: p.divergence }
        : { truth: 'its own history', request: reqName(r), sender: procDesc(r.proc), verdict: 'FAIL', why: `what the model received for this request is not on tower by the end of the run: ${kindOfDiv(p.divergence)}`, divergence: p.divergence && swap(p.divergence) };
      if (!p.contentOk) {
        // Its atoms that tower never holds at all (counted).
        const have = new Map<string, number>();
        for (const a of atoms(F)) have.set(`${a.role}|${a.key}`, (have.get(`${a.role}|${a.key}`) ?? 0) + 1);
        const never = atoms(h.messages).filter((a) => {
          const c = have.get(`${a.role}|${a.key}`) ?? 0;
          if (c > 0) {
            have.set(`${a.role}|${a.key}`, c - 1);
            return false;
          }
          return true;
        });
        if (never.length > 0) j.missing = never.map((a) => `${a.role} ${a.show} (never on tower)`);
      }
    }
    push({ kind: 'request', label: reqName(r), towerUpTo: tower.at(-1)?.seq ?? null, towerCount: tower.length, judgments: [j] });
  }

  // The committer's own admissions.
  for (const lin of ev.lins) {
    for (const n of readJsonl(join(lin.dir, `committer${suffix}.jsonl`))) {
      if (['unanchored', 'order-warning', 'error', 'changed', 'late-insert', 'reply-held'].includes(String(n.kind))) {
        // A dry check resume's committer never publishes: its notes count
        // as failures all the same, labelled as dry.
        if (lin.meta.origin === 'dry' || lin.procs.every((p) => p.dry)) {
          push({ kind: 'admission', label: `${lin.agent}/${basename(lin.dir)} (dry, never published) committer ${String(n.kind)}`, towerUpTo: null, towerCount: 0, judgments: [{ truth: 'the committer\'s own note', verdict: 'FAIL', why: `dry: ${JSON.stringify({ ...n, ts: undefined, ms: undefined }).slice(0, 400)}` }] });
          continue;
        }
        push({ kind: 'admission', label: `${lin.agent}/${basename(lin.dir)} committer ${String(n.kind)}`, towerUpTo: null, towerCount: 0, judgments: [{ truth: 'the committer\'s own note', verdict: 'FAIL', why: JSON.stringify({ ...n, ts: undefined, ms: undefined }).slice(0, 400) }] });
      }
    }
  }

  const counts = { PASS: 0, 'ROUND-TRIP': 0, UNCHECKED: 0, FAIL: 0 } as Record<Verdict, number>;
  const contentCounts = { ...counts };
  for (const p of points) {
    counts[p.verdict] += 1;
    contentCounts[p.contentVerdict] += 1;
  }
  return {
    convId: ev.convId,
    which: suffix ? `shadow (${ev.convId}~shadow)` : 'tower',
    evidence: [],
    agents: [...new Set(ev.lins.map((l) => `${l.agent} (${String(l.meta.name)})`))],
    lineages: ev.lins.map((l) => ({ dir: l.dir, origin: l.meta.origin, procs: l.procs.map(procDesc) })),
    tower: tower.map((m) => ({ seq: m.seq, ms: new Date(m.ms).toISOString(), id: m.id, role: m.role, turnId: m.turnId, blocks: m.content.map((b) => blk(b).show).join(' | ') })),
    clock,
    points,
    counts,
    contentCounts,
  };
}

// Holds: user-side entries the followed Claude Code wrote before the window
// closed that tower doesn't carry by then. Found from its own store appends,
// since the committer records no hold. Only failures are reported: finding
// none shows nothing about what Claude Code builds on.
//
// TODO: undecided (the check's own assumption): every user-type entry Claude
// Code writes (prompts, tool results, the interrupt marker, meta nudges) is
// something it sends; a tool_result is carried when tower holds a tool_result
// for the same tool_use_id, a text when tower holds the same text (a reminder
// with or without its wrapper).
function holdJudgment(ev: Evidence, proc: Proc, T: Msg[], closeMs: number, towerLater: Msg[]): Judgment | undefined {
  const lin = ev.lins.find((l) => l.dir === proc.lineage);
  if (!lin) return undefined;
  const ta = atoms(T);
  const later = atoms(towerLater);
  // A tool_result is carried only as written (same id, same content).
  const carried = (xs: Atom[], kind: 'result' | 'text', v: string): boolean => xs.some((a) => (kind === 'result' ? a.key === v : a.text === v || a.text === `<system-reminder>\n${v}\n</system-reminder>`));
  const sameId = (xs: Atom[], id: string): boolean => xs.some((a) => a.key.startsWith(`tool_result:${id}:`));
  const held: string[] = [];
  for (const a of lin.appends) {
    const e = a.entry;
    if (a.how === 'seed' || a.ms < proc.serveMs || a.ms >= closeMs || e.type !== 'user' || e.isSidechain === true) continue;
    for (const b of listOf((e.message as Json | undefined)?.content)) {
      const parts: ['result' | 'text', string][] = b.type === 'tool_result' ? [['result', blk(b).nl]] : b.type === 'text' ? segments(String(b.text ?? '')).flatMap(paras).map((x) => ['text', x] as ['text', string]) : [];
      for (const [kind, v] of parts) {
        if (!carried(ta, kind, v)) {
          const id = String(b.tool_use_id);
          const what = kind === 'result' ? blk(b).show : `text ${cut(v)}`;
          const after = carried(later, kind, v) ? '; on tower later' : kind === 'result' && sameId(later, id) ? '; tower later holds a different tool_result for this tool_use' : '; never on tower';
          held.push(`user ${what} (entry ${String(e.uuid).slice(0, 8)}, written ${new Date(a.ms).toISOString()}${after})`);
        }
      }
    }
  }
  if (held.length === 0) return undefined;
  return { truth: `what ${proc.key} wrote`, sender: procDesc(proc), verdict: 'FAIL', why: `${held.length} user-side part(s) ${proc.key} wrote before this point are not on tower: held, not committed`, missing: held };
}

// A quiet point: tower should be the whole conversation. Truths, in order of
// preference: the same Claude Code's next request; a restart of it from its
// own local record (dry checks "as of" this point included); otherwise the
// next request of a Claude Code resumed from tower (a round trip).
function quietJudgments(ev: Evidence, T: Msg[], seq: number, pointMs: number, proc: Proc, liveReqs: Req[], sameLabel = 'the same Claude Code\'s next request'): Judgment[] {
  const js: Judgment[] = [];
  const same = liveReqs.find((r) => r.ms > pointMs && r.proc === proc);
  // A live restart stands for the point only when it is the next thing to
  // happen after it (no other live request in between); a dry one "as of"
  // the point stands for it by construction.
  const nextLive = liveReqs.find((r) => r.ms > pointMs) ?? ev.reqs.filter((r) => !r.proc.dry).find((r) => r.ms > pointMs);
  const localRestarts = ev.reqs.filter((r) => r.ms > pointMs && r.proc !== proc && (r.proc.decision === 'local' || r.proc.decision === 'record') && (r.proc.dry ? r.proc.asOfMs !== null && Math.abs(r.proc.asOfMs - pointMs) < 1 : r.proc.lineage === proc.lineage && r === nextLive));
  const firstPerProc = new Map<Proc, Req>();
  for (const r of localRestarts) {
    if (!firstPerProc.has(r.proc)) firstPerProc.set(r.proc, r);
  }
  const truths: [string, Req][] = [...(same ? [[sameLabel, same] as [string, Req]] : []), ...[...firstPerProc.values()].map((r) => ['a restart from its own local record', r] as [string, Req])];
  for (const [label, r] of truths) {
    const h = history(ev, r.lineage, r.file);
    if ('error' in h) {
      js.push({ truth: label, request: reqName(r), sender: procDesc(r.proc), verdict: 'UNCHECKED', why: h.error });
      continue;
    }
    const p = towerPrefixOf(T, h.messages);
    const lin = ev.lins.find((l) => l.dir === r.lineage) as Lin;
    if (!p.contentOk) {
      js.push({ truth: label, request: reqName(r), sender: procDesc(r.proc), verdict: 'FAIL', why: `tower is not the start of what Claude Code built its next query on: ${kindOfDiv(p.divergence)}`, divergence: p.divergence });
      continue;
    }
    const s = sortRemainder(lin, p.remainder, pointMs, r.ms, atoms(T));
    const base = { truth: label, request: reqName(r), sender: procDesc(r.proc), newInput: s.newInput, missing: s.missing, unplaced: s.unplaced };
    const shapeNote = p.ok ? '' : ` (and differs in shape: ${kindOfDiv(p.divergence)})`;
    if (s.missing.length > 0) {
      js.push({ ...base, verdict: 'FAIL', why: `tower is missing ${s.missing.length} atom(s) Claude Code held at this point and built its next query on${shapeNote}`, ...(p.ok ? {} : { divergence: p.divergence }) });
    } else if (!p.ok) {
      js.push({ ...base, verdict: 'FAIL', why: `tower holds the whole conversation's content, but not in the shape the model received it: ${kindOfDiv(p.divergence)}`, divergence: p.divergence });
    } else if (s.unplaced.length > 0) {
      js.push({ ...base, verdict: 'UNCHECKED', why: `${s.unplaced.length} atom(s) beyond tower that no entry Claude Code wrote carries: can't tell new input from missing` });
    } else {
      js.push({ ...base, verdict: 'PASS', why: 'tower is the whole conversation: what is beyond it is only new input' });
    }
  }
  if (truths.length === 0) {
    const rt = liveReqs.find((r) => r.ms > pointMs && roundTrip(r, seq));
    if (rt) {
      const j = judgePrefix(ev, T, rt, seq, 'a Claude Code resumed from tower');
      js.push(j.verdict === 'PASS' ? { ...j, verdict: 'ROUND-TRIP' } : j);
    }
    js.push({ truth: 'the whole conversation', verdict: 'UNCHECKED', why: `no later request from ${proc.key} or from a restart of it from its own record: what it held at this point isn't known from what the model received` });
  }
  return js;
}

// ---------------------------------------------------------------------------
// Report.

export function markdown(r: Report): string {
  const L: string[] = [`# Invariant check: conversation ${r.convId}, ${r.which}`, '', `Scenario evidence: ${r.evidence.join(', ') || '(named by id)'}. Agents (conversation label): ${r.agents.join(', ')}.`, ''];
  L.push(`Verdicts: PASS ${r.counts.PASS}, FAIL ${r.counts.FAIL}, ROUND-TRIP ${r.counts['ROUND-TRIP']}, UNCHECKED ${r.counts.UNCHECKED}.`, '', `With shape-only divergences set aside (content verdicts): PASS ${r.contentCounts.PASS}, FAIL ${r.contentCounts.FAIL}, ROUND-TRIP ${r.contentCounts['ROUND-TRIP']}, UNCHECKED ${r.contentCounts.UNCHECKED}.`, '');
  L.push(`Clock: broker timestamp minus the body's commit instant, min ${r.clock.minGapMs} ms, max ${r.clock.maxGapMs} ms, negative ${r.clock.negative}.`, '');
  L.push('## Lineages', '');
  for (const l of r.lineages) {
    L.push(`- ${l.dir} (origin ${String(l.origin)}): ${l.procs.join('; ')}`);
  }
  L.push('', '## Tower', '');
  for (const m of r.tower) {
    L.push(`- seq ${m.seq} ${m.ms} ${m.role} ${m.id.slice(0, 8)} turn ${m.turnId.slice(0, 16)}: ${m.blocks}`);
  }
  L.push('', '## Points', '');
  for (const p of r.points) {
    L.push(`### ${p.verdict}${p.verdict !== p.contentVerdict ? ` (content ${p.contentVerdict})` : ''} ${p.kind}: ${p.label}`, '');
    for (const j of p.judgments) {
      L.push(`- ${j.verdict}${j.contentVerdict && j.contentVerdict !== j.verdict ? ` (content ${j.contentVerdict})` : ''} against ${j.truth}${j.request ? ` (${j.request}, from ${j.sender})` : ''}: ${j.why}`);
      if (j.divergence) {
        const d = j.divergence;
        L.push(`  - ${kindOfDiv(d)}; exact-level differences: ${d.shapeDiffs.join('; ') || d.at}`, `  - tower: ${d.tower}`, `  - Claude Code: ${d.truth}`, `  - shapes (role, blocks per API message): tower ${d.towerShape}; Claude Code ${d.truthShape}`);
        if (d.contentAt) {
          L.push(`  - first content difference at ${d.contentAt}:`, '    tower:', ...(d.towerAtoms ?? []).map((x) => `      ${x}`), '    Claude Code:', ...(d.truthAtoms ?? []).map((x) => `      ${x}`));
        }
      }
      if (j.missing?.length) L.push(`  - missing from tower: ${j.missing.join('; ')}`);
      if (j.newInput?.length) L.push(`  - new input: ${j.newInput.join('; ')}`);
      if (j.unplaced?.length) L.push(`  - unplaced: ${j.unplaced.join('; ')}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// The live tower against its shadow: message for message, id, role, turnId
// and content.
export function compareShadow(live: TowerMsg[], shadow: TowerMsg[]): { same: boolean; at: number | null; live: string | null; shadow: string | null } {
  const k = (m: TowerMsg): string => canon({ id: m.id, role: m.role, turnId: m.turnId, content: m.content });
  const show = (m: TowerMsg | undefined): string | null => (m ? `seq ${m.seq} ${m.role} ${m.id.slice(0, 8)} [${m.content.map((b) => blk(b).show).join(' | ')}]` : null);
  for (let i = 0; i < Math.max(live.length, shadow.length); i += 1) {
    const a = live[i];
    const b = shadow[i];
    if (!a || !b || k(a) !== k(b)) {
      return { same: false, at: i, live: show(a), shadow: show(b) };
    }
  }
  return { same: true, at: null, live: null, shadow: null };
}

function convIdsFromEvidence(dir: string): string[] {
  const text: string[] = [];
  const walk = (d: string): void => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(log|json|jsonl|md)$/.test(f.name) && statSync(p).size < 50_000_000) text.push(readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  const ids = new Set(text.join('\n').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
  return [...ids].filter((id) => lineagesOf(id).length > 0).sort();
}

function allConvIds(): string[] {
  const ids = new Set<string>();
  for (const agent of existsSync(INTEGRATION_STATE) ? readdirSync(INTEGRATION_STATE) : []) {
    const c = join(INTEGRATION_STATE, agent, 'conv');
    if (existsSync(c)) for (const id of readdirSync(c)) ids.add(id);
  }
  return [...ids].sort();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  const ids: string[] = [];
  const from = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--out') out = argv[++i];
    else if (a === '--evidence') {
      const d = String(argv[++i]);
      for (const id of convIdsFromEvidence(d)) {
        ids.push(id);
        from.set(id, [...(from.get(id) ?? []), d]);
      }
    }
    else if (a === '--all') ids.push(...allConvIds());
    else ids.push(a);
  }
  if (ids.length === 0) {
    process.stderr.write('usage: node proofs/integration/invariant.mts <convId>... | --evidence <runs dir> | --all [--out <dir>]\n');
    process.exit(2);
  }
  const dir = out ?? join(RUNS, `${AGENT_PREFIX}-${fileStamp()}-invariant`);
  mkdirSync(dir, { recursive: true });
  let fails = 0;
  for (const id of [...new Set(ids)]) {
    const ev = gather(id);
    const live = await readTower(id);
    const shadow = await readTower(`${id}~shadow`);
    for (const [suffix, tower] of [['', live], ['.shadow', shadow]] as const) {
    if (suffix && tower.length === 0) {
      continue;
    }
    const r = { ...judge(ev, tower, suffix), evidence: from.get(id) ?? [] };
    writeFileSync(join(dir, `${id}${suffix}.json`), clean(JSON.stringify(r, null, 2)));
    writeFileSync(join(dir, `${id}${suffix}.md`), clean(markdown(r)));
    fails += r.counts.FAIL;
    process.stdout.write(`${suffix ? 'SHADOW ' : ''}${id} [${r.agents.join(', ')}]${r.evidence.length ? ` from ${r.evidence.map((e) => basename(e)).join(', ')}` : ''}: tower ${tower.length} messages, ${ev.lins.length} lineages, ${ev.reqs.length} main requests; PASS ${r.counts.PASS} FAIL ${r.counts.FAIL} (of which shape only ${r.counts.FAIL - r.contentCounts.FAIL}) ROUND-TRIP ${r.counts['ROUND-TRIP']} UNCHECKED ${r.counts.UNCHECKED}; content verdicts PASS ${r.contentCounts.PASS} FAIL ${r.contentCounts.FAIL} ROUND-TRIP ${r.contentCounts['ROUND-TRIP']} UNCHECKED ${r.contentCounts.UNCHECKED} -> ${join(dir, `${id}${suffix}.md`)}\n`);
    for (const p of r.points.filter((x) => x.contentVerdict === 'FAIL')) {
      process.stdout.write(`  FAIL ${p.kind}: ${p.label}\n`);
      for (const j of p.judgments.filter((x) => x.contentVerdict === 'FAIL')) {
        process.stdout.write(`    ${j.truth}: ${j.why}${j.divergence?.contentAt ? ` [content at ${j.divergence.contentAt}: tower ${JSON.stringify(j.divergence.towerAtoms?.find((x) => x.startsWith('>')) ?? null)} vs Claude Code ${JSON.stringify(j.divergence.truthAtoms?.find((x) => x.startsWith('>')) ?? null)}]` : ''}${j.missing?.length ? ` missing: ${j.missing.join('; ')}` : ''}\n`);
      }
    }
    }
    if (shadow.length > 0) {
      const d = compareShadow(live, shadow);
      writeFileSync(join(dir, `${id}.live-vs-shadow.json`), clean(JSON.stringify(d, null, 2)));
      process.stdout.write(`  live vs shadow: ${d.same ? 'identical (same messages, ids, roles, turnIds and content, in order)' : `differ from message ${d.at}: live ${d.live ?? '(none)'} vs shadow ${d.shadow ?? '(none)'}`} (live ${live.length}, shadow ${shadow.length})\n`);
    }
  }
  process.exit(fails > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
