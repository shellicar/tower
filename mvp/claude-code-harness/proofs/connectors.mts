// Proof 18: keeping the claude.ai account's connectors out of a run.
//
// Proof 7 found the account's "claude.ai Claude Docs" connector connected in
// a harness run despite settingSources []. Proof 14 found the connectors'
// tools join the tool list late, so the first request after a resume misses
// the prompt cache. This proof tries each documented way of keeping them out
// and measures, per way, a seed conversation and its resume.
//
//   node proofs/connectors.mts <model> <way> [preset] [all-tools] [dummy-mcp]
//   node proofs/connectors.mts --compare <run dir A> <run dir B> [<i A> <i B>]
//       (the i-th main-thread request of each, from 0; default the first)
//   node proofs/connectors.mts --table <run dir> ...
//
// Ways (each goes in this proof's options, never in the harness):
//   baseline     nothing: connectors attach as they do by default
//   env          env ENABLE_CLAUDEAI_MCP_SERVERS=false
//   setting      settings (the SDK's flag layer) {disableClaudeAiConnectors: true}
//   managed      managedSettings (the SDK's policy tier) {disableClaudeAiConnectors: true}
//   strict       strictMcpConfig: true, no mcpServers
//   deny         settings {deniedMcpServers: [by serverName, each connector
//                seen in the baseline]}
//   allow-empty  settings {allowedMcpServers: []}
//   safe-mode    env CLAUDE_CODE_SAFE_MODE=1
//   managed-control  not a way: managedSettings holding only an inert
//                deniedMcpServers entry (a name no server has), to tell what
//                the managed way changes because managedSettings is present
//                from what it changes by keeping connectors out
//   toggle       at start, poll mcpServerStatus() until the claude.ai
//                servers appear and none is still pending (up to
//                TOGGLE_WAIT_MS), toggleMcpServer(name, false) for each, then
//                send; the same again in the resume
//
// One invocation is a seed run and its resume, both under the same way:
//   seed    three turns. Turn 1 carries a per-invocation nonce, so no
//           earlier run's cache can serve the history. Turn 2 carries about
//           4k tokens of padding, sent after the connectors have joined (in
//           the baseline), so the history past the join is plainly more than
//           the system prompt. Turn 3 is short.
//   resume  a new run (fresh CLAUDE_CONFIG_DIR, as the harness gives every
//           run) resuming the seed's session through the SDK's session
//           store: load() returns every main-thread entry the seed's store
//           was given, in order. One short turn. Started as soon as the seed
//           has exited, well inside the 5-minute cache lifetime.
// Both runs use the proof name `connectors`, so both (and every way) share
// one working directory, and the system prompt's environment block is the
// same across ways.
//
// Per run, recorded in the run directory beside the harness's own files:
//   proof.json          way, role, nonce, session id, seed run dir
//   store-appends.jsonl every append the store was given
//   store-load.jsonl    what load() returned (resume only)
//   proof-events.jsonl  control calls (toggle) and their results
//   api-bodies/         OTEL_LOG_RAW_API_BODIES request and response bodies
//   debug.log           Claude Code's debug log
//   summary.txt         per request: tools, system, messages, usage; init
//                       mcp_servers; the debug log's claude.ai lines
//
// TODO: undecided, each is the easiest thing that runs, for this proof only:
//   - System prompt: the SDK's minimal default (no systemPrompt option, as
//     proof 14), or with a trailing `preset` argument Claude Code's
//     claude_code preset, to see what the connectors change in it.
//   - Tools: none of Claude Code's own (tools: []), so each turn is one
//     request and the only tools are whatever MCP servers attach. With
//     tools: [] there is no ToolSearch, so MCP tools join the tools array
//     itself. `all-tools` leaves `tools` unset (Claude Code's default set,
//     ToolSearch included), for the other shape: the MCP docs say that
//     with tool search on, MCP tools are deferred and a server that
//     connects later has its tool names listed on the next request.
//   - `dummy-mcp` passes one stdio server of the proof's own
//     (proofs/dummy-mcp.mjs) through mcpServers, to see which ways also keep
//     a passed server out. Thinking
//     left unset (Claude Code's own default).
//   - The resume transport: an in-process session store, proof 14's `full`
//     source without NATS.
//   - deny names the connectors by display name, taken from what the
//     baseline's init message listed; a renamed or new connector would slip
//     through.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

type Json = Record<string, unknown>;

const NAME = 'connectors';
const STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'proof-18');
const QUIET_MS = 3000;
const TOGGLE_WAIT_MS = 20000;

// The connectors the baseline's init message listed (runs/*-connectors with
// way baseline, sdk-messages.jsonl, init.mcp_servers; also proof 14's runs).
const SEEN_CONNECTORS = ['claude.ai Claude Docs', 'claude.ai Google Drive'];

const WAYS = ['baseline', 'env', 'setting', 'managed', 'strict', 'deny', 'allow-empty', 'safe-mode', 'toggle', 'managed-control'] as const;
type Way = (typeof WAYS)[number];

// About 4k tokens.
const PADDING = Array.from({ length: 300 }, (_, i) => `Reference line ${i + 1}: padding so the conversation history is long enough to cache.`).join('\n');

function wayOptions(way: Way): { options: Partial<HarnessOptions>; env: Record<string, string> } {
  switch (way) {
    case 'baseline':
    case 'toggle':
      return { options: {}, env: {} };
    case 'env':
      return { options: {}, env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } };
    case 'setting':
      return { options: { settings: { disableClaudeAiConnectors: true } as HarnessOptions['settings'] }, env: {} };
    case 'managed':
      return { options: { managedSettings: { disableClaudeAiConnectors: true } as HarnessOptions['managedSettings'] }, env: {} };
    case 'managed-control':
      return { options: { managedSettings: { deniedMcpServers: [{ serverName: 'tower-proof-18-no-such-server' }] } as HarnessOptions['managedSettings'] }, env: {} };
    case 'strict':
      return { options: { strictMcpConfig: true }, env: {} };
    case 'deny':
      return { options: { settings: { deniedMcpServers: SEEN_CONNECTORS.map((serverName) => ({ serverName })) } as HarnessOptions['settings'] }, env: {} };
    case 'allow-empty':
      return { options: { settings: { allowedMcpServers: [] } as HarnessOptions['settings'] }, env: {} };
    case 'safe-mode':
      return { options: {}, env: { CLAUDE_CODE_SAFE_MODE: '1' } };
  }
}

class Recorder {
  path: string | undefined;
  pending: string[] = [];
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  attach(dir: string): void {
    this.path = join(dir, this.file);
    for (const line of this.pending) {
      appendFileSync(this.path, line);
    }
    this.pending = [];
  }
  write(value: unknown): void {
    const line = `${redact(typeof value === 'string' ? value : JSON.stringify(value)).text}\n`;
    if (this.path) {
      appendFileSync(this.path, line);
    } else {
      this.pending.push(line);
    }
  }
}

// Records every append; load() returns what `source` gives it.
class ProofStore implements SessionStore {
  readonly appends = new Recorder('store-appends.jsonl');
  readonly loads = new Recorder('store-load.jsonl');
  readonly main: Json[] = [];
  readonly source: Json[] | null;
  constructor(source: Json[] | null) {
    this.source = source;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.appends.write({ ts: stamp(), key, count: entries.length, entries });
    if (!key.subpath) {
      this.main.push(...(entries as unknown as Json[]));
    }
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const out = key.subpath ? null : this.source;
    this.loads.write({ ts: stamp(), key, returned: out === null ? null : out.length });
    return out as SessionStoreEntry[] | null;
  }
}

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function log(s: string): void {
  process.stdout.write(`${stamp()} ${s}\n`);
}

async function toggleOff(run: Run, events: Recorder): Promise<void> {
  const deadline = Date.now() + TOGGLE_WAIT_MS;
  let found: { name: string; status: string; source?: string }[] = [];
  for (;;) {
    const status = (await run.query.mcpServerStatus()) as unknown as { name: string; status: string; source?: string }[];
    found = status.filter((s) => s.source === 'claudeai' || s.name.startsWith('claude.ai '));
    events.write({ ts: stamp(), mcpServerStatus: status.map((s) => ({ name: s.name, status: s.status, source: s.source })) });
    // A toggle while a connector is still `pending` is undone when its
    // connection completes (first toggle run, 26 Sep: disabled, then
    // connected in the next init), so wait until none is pending.
    if ((found.length >= SEEN_CONNECTORS.length && found.every((s) => s.status !== 'pending')) || Date.now() >= deadline) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const s of found) {
    const result = await run.query.toggleMcpServer(s.name, false).then(
      () => 'ok',
      (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
    );
    events.write({ ts: stamp(), toggleMcpServer: s.name, enabled: false, result });
    log(`toggleMcpServer(${JSON.stringify(s.name)}, false): ${result}`);
  }
  const after = (await run.query.mcpServerStatus()) as unknown as { name: string; status: string; source?: string }[];
  events.write({ ts: stamp(), after: after.map((s) => ({ name: s.name, status: s.status, source: s.source })) });
}

// Sends each prompt after the previous turn's result has been followed by
// QUIET_MS of silence; ends the input after the last.
async function drive(run: Run, prompts: string[], before: (() => Promise<void>) | undefined): Promise<void> {
  let index = 0;
  let quiet: NodeJS.Timeout | undefined;
  const next = (): void => {
    quiet = undefined;
    index += 1;
    if (index >= prompts.length) {
      log('quiet after last turn; end');
      run.end();
      return;
    }
    log(`turn ${index + 1}: send ${JSON.stringify(prompts[index].slice(0, 80))}`);
    run.send(user(prompts[index]));
  };
  if (before) {
    await before();
  }
  log(`turn 1: send ${JSON.stringify(prompts[0].slice(0, 80))}`);
  run.send(user(prompts[0]));
  for await (const message of run.messages() as AsyncIterable<SDKMessage>) {
    if (quiet) {
      clearTimeout(quiet);
      quiet = setTimeout(next, QUIET_MS);
    }
    if (message.type === 'result') {
      log(`result ${message.subtype}`);
      quiet = setTimeout(next, QUIET_MS);
    }
    if (message.type === 'assistant') {
      for (const b of message.message.content as unknown as Json[]) {
        if (b.type === 'text') {
          log(`assistant: ${String(b.text).slice(0, 120)}`);
        }
      }
    }
  }
  if (quiet) {
    clearTimeout(quiet);
  }
}

interface Flags {
  preset: boolean;
  allTools: boolean;
  dummyMcp: boolean;
}

const HERE = new URL('.', import.meta.url).pathname;

async function oneRun(model: string, way: Way, flags: Flags, role: 'seed' | 'resume', store: ProofStore, extra: Json, prompts: string[], resume?: string): Promise<Run> {
  const bodies = join(STATE, `${stamp().replace(/[:.]/g, '')}-${way}-${role}`);
  mkdirSync(bodies, { recursive: true });
  const w = wayOptions(way);
  const options: HarnessOptions = {
    model,
    ...(flags.allTools ? {} : { tools: [] }),
    ...(flags.dummyMcp ? { mcpServers: { tower_dummy: { type: 'stdio', command: process.execPath, args: [join(HERE, 'dummy-mcp.mjs')] } } } : {}),
    includePartialMessages: true,
    sessionStore: store,
    sessionStoreFlush: 'eager',
    debugFile: join(bodies, 'debug.log'),
    ...(flags.preset ? { systemPrompt: { type: 'preset', preset: 'claude_code' } as const } : {}),
    ...w.options,
    ...(resume ? { resume } : {}),
    env: { ...process.env, ...w.env, OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
  };
  const run = startRun({ name: NAME, options });
  store.appends.attach(run.dir);
  store.loads.attach(run.dir);
  const events = new Recorder('proof-events.jsonl');
  events.attach(run.dir);
  writeFileSync(join(run.dir, 'proof.json'), `${JSON.stringify({ way, role, ...flags, wayEnv: Object.keys(w.env), wayOptions: w.options, bodies, ...extra }, null, 2)}\n`);
  log(`${role} run dir: ${run.dir}`);
  await drive(run, prompts, way === 'toggle' ? () => toggleOff(run, events) : undefined);
  try {
    await run.done;
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  const out = join(run.dir, 'api-bodies');
  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(bodies)) {
    if (entry === 'latest') {
      continue;
    }
    const text = redact(readFileSync(join(bodies, entry), 'utf8')).text;
    writeFileSync(entry === 'debug.log' ? join(run.dir, 'debug.log') : join(out, entry), text);
  }
  const summary = summarise(run.dir);
  writeFileSync(join(run.dir, 'summary.txt'), summary);
  process.stdout.write(`\n${summary}\n`);
  return run;
}

async function seedAndResume(model: string, way: Way, flags: Flags): Promise<void> {
  const nonce = randomUUID();
  const seedStore = new ProofStore(null);
  const seed = await oneRun(model, way, flags, 'seed', seedStore, { nonce }, [
    `Nonce ${nonce}. Ignore the nonce. Without using any tool: how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7? Reply with the number only.`,
    `Ignore the reference lines below.\n\n${PADDING}\n\nWithout using any tool: how many from 1 to 600? Reply with the number only.`,
    'Without using any tool: how many from 1 to 900? Reply with the number only.',
  ]);
  const sessionId = seedStore.main.find((e) => typeof e.sessionId === 'string')?.sessionId as string | undefined;
  if (!sessionId) {
    throw new Error('seed: no session id in the store appends');
  }
  log(`seed session ${sessionId}; ${seedStore.main.length} main-thread entries`);
  const resumeStore = new ProofStore(seedStore.main);
  await oneRun(model, way, flags, 'resume', resumeStore, { nonce, sessionId, seedRun: seed.dir }, ['Reply with the word OK only.'], sessionId);
}

// ---------------------------------------------------------------------------
// Reading the runs

interface Req {
  line: number;
  file: string;
  source: string;
  body: Json & { messages: Json[]; system?: Json[] | string; tools?: Json[] };
  usage: Json | undefined;
}

function readJsonl(path: string): Json[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Json)
    : [];
}

function requests(runDir: string): Req[] {
  const dir = join(runDir, 'api-bodies');
  return readJsonl(join(dir, 'index.jsonl')).map((e, i) => {
    const resp = join(dir, String(e.response_file));
    const r = existsSync(resp) ? (JSON.parse(readFileSync(resp, 'utf8')) as Json) : undefined;
    return {
      line: i + 1,
      file: String(e.request_file),
      source: String(e.query_source),
      body: JSON.parse(readFileSync(join(dir, String(e.request_file)), 'utf8')) as Req['body'],
      usage: r?.usage as Json | undefined,
    };
  });
}

function usage(r: Req): Json {
  const u = r.usage ?? {};
  const input = Number(u.input_tokens ?? 0);
  const read = Number(u.cache_read_input_tokens ?? 0);
  const write = Number(u.cache_creation_input_tokens ?? 0);
  return { input, cache_read: read, cache_write: write, prefix: input + read + write };
}

function systemTexts(r: Req): string[] {
  const s = r.body.system;
  if (typeof s === 'string') {
    return [s];
  }
  return (s ?? []).map((b) => String(b.text ?? JSON.stringify(b)));
}

function toolNames(r: Req): string[] {
  return (r.body.tools ?? []).map((t) => String(t.name ?? t.type));
}

function reminderHeads(content: unknown): string[] {
  const texts: string[] = typeof content === 'string' ? [content] : Array.isArray(content) ? (content as Json[]).map((b) => (b.type === 'text' ? String(b.text) : '')) : [];
  const out: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(/<system-reminder>\n?([^\n]*)/g)) {
      out.push(m[1].slice(0, 90));
    }
  }
  return out;
}

function summarise(runDir: string): string {
  const lines: string[] = [`== ${runDir}`];
  const proof = existsSync(join(runDir, 'proof.json')) ? (JSON.parse(readFileSync(join(runDir, 'proof.json'), 'utf8')) as Json) : {};
  lines.push(`way ${String(proof.way)} role ${String(proof.role)}`);
  const sdk = readJsonl(join(runDir, 'sdk-messages.jsonl'));
  sdk.forEach((e, i) => {
    const m = e.message as Json;
    if (m.type === 'system' && m.subtype === 'init') {
      const tools = (m.tools as string[]).filter((t) => t.startsWith('mcp__'));
      lines.push(`init (sdk-messages.jsonl line ${i + 1}): mcp_servers=${JSON.stringify(m.mcp_servers)} mcp tools=${tools.length} skills=${(m.skills as string[]).length} plugins=${JSON.stringify(m.plugins)}`);
    }
  });
  for (const r of requests(runDir)) {
    const sys = systemTexts(r);
    const mcpSys = sys.some((t) => t.includes('MCP Server Instructions'));
    lines.push(`request ${r.line} (${r.source}) ${r.file}: ${JSON.stringify(usage(r))} tools=${toolNames(r).length} [${toolNames(r).join(',')}] system blocks=${sys.length} chars=${sys.reduce((n, t) => n + t.length, 0)}${mcpSys ? ' (MCP Server Instructions in system)' : ''} messages=${r.body.messages.length}`);
    r.body.messages.forEach((m, i) => {
      const heads = reminderHeads(m.content);
      const mcp = JSON.stringify(m.content).match(/MCP Server Instructions|MCP servers have disconnected|claude\.ai|mcp__claude_ai/g);
      if (heads.length || mcp) {
        lines.push(`    [${i}] ${String(m.role)} reminders=${JSON.stringify(heads)}${mcp ? ` mentions=${JSON.stringify([...new Set(mcp)])}` : ''}`);
      }
    });
  }
  const debug = join(runDir, 'debug.log');
  if (existsSync(debug)) {
    const text = readFileSync(debug, 'utf8').split('\n');
    const hits = text.map((l, i) => [i + 1, l] as const).filter(([, l]) => /\[claudeai-mcp\]|"claude\.ai |claude\.ai connectors|claudeai-proxy|ClaudeAi/i.test(l));
    lines.push(`debug.log claude.ai lines: ${hits.length}`);
    for (const [n, l] of hits.slice(0, 25)) {
      lines.push(`  ${n}: ${l.slice(0, 220)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function mainReqs(runDir: string): Req[] {
  return requests(runDir).filter((r) => r.source === 'sdk');
}

// The first main-thread requests of two runs, piece by piece.
function compare(a: string, b: string, ia = 0, ib = 0): string {
  const ra = mainReqs(a)[ia];
  const rb = mainReqs(b)[ib];
  const out: string[] = [`A ${a}\n  first main request ${ra.file} ${JSON.stringify(usage(ra))}`, `B ${b}\n  first main request ${rb.file} ${JSON.stringify(usage(rb))}`];
  const ta = new Map((ra.body.tools ?? []).map((t) => [String(t.name), JSON.stringify(t)]));
  const tb = new Map((rb.body.tools ?? []).map((t) => [String(t.name), JSON.stringify(t)]));
  out.push(`tools only in A: ${JSON.stringify([...ta.keys()].filter((k) => !tb.has(k)))}`);
  out.push(`tools only in B: ${JSON.stringify([...tb.keys()].filter((k) => !ta.has(k)))}`);
  for (const [k, v] of ta) {
    if (tb.has(k) && tb.get(k) !== v) {
      out.push(`tool ${k} differs: ${firstDiff(v, tb.get(k) as string)}`);
    }
  }
  const sa = systemTexts(ra);
  const sb = systemTexts(rb);
  out.push(`system blocks: A ${sa.length}, B ${sb.length}`);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) {
      out.push(`system[${i}] differs: ${firstDiff(sa[i] ?? '', sb[i] ?? '')}`);
      out.push(`  A lines not in B: ${JSON.stringify(lineDiff(sa[i] ?? '', sb[i] ?? ''))}`);
      out.push(`  B lines not in A: ${JSON.stringify(lineDiff(sb[i] ?? '', sa[i] ?? ''))}`);
    }
  }
  const ma = ra.body.messages;
  const mb = rb.body.messages;
  out.push(`messages: A ${ma.length}, B ${mb.length}`);
  for (let i = 0; i < Math.max(ma.length, mb.length); i++) {
    const ja = JSON.stringify(stripCache(ma[i]));
    const jb = JSON.stringify(stripCache(mb[i]));
    if (ja !== jb) {
      out.push(`message[${i}] differs (${String(ma[i]?.role)} / ${String(mb[i]?.role)}): ${firstDiff(ja ?? '', jb ?? '')}`);
      out.push(`  A reminders ${JSON.stringify(reminderHeads(ma[i]?.content))}`);
      out.push(`  B reminders ${JSON.stringify(reminderHeads(mb[i]?.content))}`);
    }
  }
  const other = (k: string): boolean => !['tools', 'system', 'messages', 'metadata'].includes(k);
  for (const k of new Set([...Object.keys(ra.body), ...Object.keys(rb.body)].filter(other))) {
    const va = JSON.stringify(ra.body[k]);
    const vb = JSON.stringify(rb.body[k]);
    if (va !== vb) {
      out.push(`body.${k}: A ${va?.slice(0, 200)} | B ${vb?.slice(0, 200)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

function stripCache(m: Json | undefined): unknown {
  return JSON.parse(JSON.stringify(m ?? null, (k, v) => (k === 'cache_control' ? undefined : v)));
}

function lineDiff(a: string, b: string): string[] {
  const set = new Set(b.split('\n'));
  return a
    .split('\n')
    .filter((l) => !set.has(l))
    .map((l) => l.slice(0, 200));
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return `at char ${i}: A …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 120))} | B …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 120))}`;
}

// One row per run: way, role, the init's claude.ai servers, whether the
// debug log shows a connector fetch, and each main request's usage.
function table(dirs: string[]): string {
  const rows: string[] = [];
  for (const d of dirs) {
    const proof = JSON.parse(readFileSync(join(d, 'proof.json'), 'utf8')) as Json;
    const inits = readJsonl(join(d, 'sdk-messages.jsonl'))
      .map((e) => e.message as Json)
      .filter((m) => m.type === 'system' && m.subtype === 'init');
    const claudeai = inits.map((m) => ((m.mcp_servers as Json[] | undefined) ?? []).filter((s) => s.source === 'claudeai').map((s) => `${String(s.name).replace('claude.ai ', '')}:${String(s.status)}`).join('+') || '-');
    const debug = existsSync(join(d, 'debug.log')) ? readFileSync(join(d, 'debug.log'), 'utf8') : '';
    const fetched = /\[claudeai-mcp\] Fetching/.test(debug);
    const reqs = mainReqs(d).map((r) => {
      const u = usage(r);
      return `tools=${toolNames(r).length} r${String(u.cache_read)}/w${String(u.cache_write)}/i${String(u.input)}`;
    });
    rows.push(`${String(proof.way).padEnd(11)} ${proof.preset ? 'preset ' : 'minimal'}${proof.allTools ? '+all-tools' : ''}${proof.dummyMcp ? '+dummy' : ''} ${String(proof.role).padEnd(6)} fetch=${fetched ? 'yes' : 'no '} inits.claudeai=[${claudeai.join(' ')}] ${reqs.join('  ')}  ${d.split('/').pop()}`);
  }
  return `${rows.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const [first, ...rest] = process.argv.slice(2);
if (first === '--compare' && (rest.length === 2 || rest.length === 4)) {
  process.stdout.write(compare(rest[0], rest[1], Number(rest[2] ?? 0), Number(rest[3] ?? 0)));
} else if (first === '--table') {
  process.stdout.write(table(rest));
} else if (first === '--summarise' && rest.length === 1) {
  process.stdout.write(summarise(rest[0]));
} else if (first && WAYS.includes(rest[0] as Way) && rest.slice(1).every((f) => ['preset', 'all-tools', 'dummy-mcp'].includes(f))) {
  await seedAndResume(first, rest[0] as Way, { preset: rest.includes('preset'), allTools: rest.includes('all-tools'), dummyMcp: rest.includes('dummy-mcp') });
} else {
  process.stderr.write(`usage:\n  node proofs/connectors.mts <model> <${WAYS.join('|')}> [preset] [all-tools] [dummy-mcp]\n  node proofs/connectors.mts --compare <run dir A> <run dir B> [<i A> <i B>]\n  node proofs/connectors.mts --table <run dir> ...\n  node proofs/connectors.mts --summarise <run dir>\n`);
  process.exit(2);
}
