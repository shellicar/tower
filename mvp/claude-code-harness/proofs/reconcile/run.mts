// Reconcile, live: what tower holds for a Claude Code conversation, option
// by option (holding.mts), tested against Claude Code itself. Proof 24's
// runner, with its ways replaced by the options.
//
// One session per cell on one model:
//   step 0  warm-up, run to the end
//   step 1  the cell's prompt, ended by interrupt() at the cell's ending (or
//           left to end by itself: normal, thinking-only, limit, api-error)
//   step 2  the probe, sent into the same running Claude Code: Claude Code's
//           own continuation (L). Its request is the ground truth.
// Then, from the recording, each option's tower holding at step 1's result
// (a restart there: a handover, a reboot, or a graceful shutdown after an
// interrupt), as changes.message bodies, is loaded back into entries
// (load.mts) and resumed through a session store with resumeSessionAt at
// the last chain entry, with the same probe (T). T's first request is
// compared with L's.
//
// Choices carried from proof 24 (TODO: undecided, none a proposal): its
// triggers; connectors off; L first, then each T; the api-error cell's
// timeout and retries; a priming run after the reset. New here (TODO:
// undecided):
//   - Holdings are computed after the main run from its recording, each
//     message only if its commit instant is at or before step 1's result.
//   - A control resume from Claude Code's own record at the result (every
//     store entry less thinking-only pieces that never got a sibling, the
//     API error notes kept), with resumeSessionAt: proof 24's H.
//   - Limit cell: CLAUDE_CODE_MAX_OUTPUT_TOKENS 64 on every model (RC_LIMIT
//     overrides); api-error cell: API_TIMEOUT_MS 800, Fable 300, Haiku 100
//     (RC_ERROR_TIMEOUT overrides).
//   - Resume order: the control, then entry, run+last, run+entry, request,
//     run, next (a later resume can read what an earlier one wrote).
//
//   node proofs/reconcile/run.mts <model> <cell|all> [...]

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookCallbackMatcher, HookEvent, HookInput, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { redact, stamp } from '../../src/record.mts';
import type { Json } from './holding.mts';
import { assistantCommits, holdingAt, kindOf } from './holding.mts';
import { checkBody, load, toBodies, type TowerBody } from './load.mts';
import { readRecording } from './recording.mts';

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'reconcile');
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const QUIET_MS = 2500;
const STEP_TIMEOUT_MS = 240_000;
const POLL_MS = 5;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const clean = (text: string): string => redact(text).text.replace(EMAIL, '[email redacted]');
const now = (): number => performance.timeOrigin + performance.now();

// ---------------------------------------------------------------------------
// Cells

type Ending = 'first-byte' | 'thinking' | 'mid-text' | 'tool-input' | 'tool-exec';

interface Cell {
  id: string;
  prompt: string;
  ending?: Ending;
  env?: Record<string, string>; // process env for the whole run
  resumeEnv?: Record<string, string>; // process env for its resumes, if not env
}

const WARM = 'Reply with the word READY only.';
const PROBE = 'Reply with the word NEXT only.';
const HARD = 'Work out, carefully and step by step, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7.';
const NO_TOOLS = 'Answer in your reply itself; do not use any tools.';
// 800 ms timed out every attempt on Sonnet, Opus and Fable in proof 23;
// Haiku answered inside it (proof 24 pilot), so Haiku gets 100 ms.
// RC_ERROR_TIMEOUT overrides (Fable answered inside 800 ms in proof 24's
// later rounds).
const errorEnv = (model: string): Record<string, string> => ({ API_TIMEOUT_MS: process.env.RC_ERROR_TIMEOUT ?? (/haiku/.test(model) ? '100' : /fable/.test(model) ? '300' : '800'), CLAUDE_CODE_MAX_RETRIES: '2' });

function cells(model: string): Cell[] {
  const limit = process.env.RC_LIMIT ?? '64';
  return [
    { id: 'normal', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}` },
    { id: 'thinking-only', prompt: `Think carefully about whether 391 is prime. Then end your turn with an empty reply: write no text at all, not even a single word or punctuation mark. ${NO_TOOLS}` },
    { id: 'limit', prompt: `${HARD} Reply with the number only. ${NO_TOOLS}`, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: limit } },
    { id: 'api-error', prompt: `What is 17 times 23? Work it out, then reply with the number only. ${NO_TOOLS}`, env: errorEnv(model), resumeEnv: {} },
    { id: 'first-byte', prompt: `What is 17 times 23? Reply with the number only. ${NO_TOOLS}`, ending: 'first-byte' },
    { id: 'thinking', prompt: `${HARD} Reply with the number only. ${NO_TOOLS}`, ending: 'thinking' },
    { id: 'mid-text', prompt: `Write the numbers one to sixty in words, one per line, nothing else. ${NO_TOOLS}`, ending: 'mid-text' },
    { id: 'tool-input', prompt: 'Use the Write tool to create story.txt containing a 300-word story about a lighthouse keeper. Call the Write tool straight away, with no text before it.', ending: 'tool-input' },
    // Opus ran proof 23's prompt in the background in round 1 and finished
    // before the stop; "in the foreground" added from round 2.
    { id: 'tool-exec', prompt: 'Run this exact Bash command in the foreground (not in the background), once: `sleep 20; echo DONE`. Then reply with its output only.', ending: 'tool-exec' },
  ];
}

const short = (model: string): string => model.replace(/^claude-/, '').replace(/[^A-Za-z0-9]/g, '');
const agentName = (model: string): string => `rc-${short(model)}`;

// ---------------------------------------------------------------------------
// Recording

class Events {
  readonly path: string;
  readonly raw: string;
  constructor(dir: string, rawDir: string) {
    this.path = join(dir, 'next-events.jsonl');
    this.raw = join(rawDir, 'next-events.jsonl');
  }
  write(src: string, kind: string, detail: Json = {}): void {
    const line = JSON.stringify({ ts: stamp(), ms: now(), src, kind, ...detail });
    appendFileSync(this.raw, `${line}\n`);
    appendFileSync(this.path, `${clean(line)}\n`);
  }
}

class RecordingStore implements SessionStore {
  readonly all: Json[] = [];
  readonly rawPath: string;
  readonly events: Events;
  readonly toLoad: Json[] | undefined;
  constructor(events: Events, rawPath: string, toLoad?: Json[]) {
    this.events = events;
    this.rawPath = rawPath;
    this.toLoad = toLoad;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    appendFileSync(this.rawPath, `${JSON.stringify({ ts: stamp(), ms: now(), key, entries })}\n`);
    if (!key.subpath) {
      this.all.push(...(entries as Json[]));
    }
    this.events.write('store', 'append', { subpath: key.subpath ?? null, count: entries.length, types: (entries as Json[]).map((e) => e.type) });
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (!this.toLoad || key.subpath) {
      this.events.write('store', 'load', { subpath: key.subpath ?? null, returned: null });
      return null;
    }
    this.events.write('store', 'load', { returned: this.toLoad.length });
    return this.toLoad as SessionStoreEntry[];
  }
}

class BodiesWatch {
  readonly dir: string;
  readonly events: Events;
  readonly seen = new Set<string>();
  timer: NodeJS.Timeout | undefined;
  onRequest: (file: string, body: Json) => void = () => {};
  constructor(dir: string, events: Events) {
    this.dir = dir;
    this.events = events;
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }
  stop(): void {
    clearInterval(this.timer);
    this.poll();
  }
  poll(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of names) {
      if (this.seen.has(f) || !f.endsWith('.json')) {
        continue;
      }
      let body: Json;
      try {
        body = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Json;
      } catch {
        continue; // still being written
      }
      this.seen.add(f);
      if (f.endsWith('.request.json')) {
        this.events.write('bodies', 'request', { file: f, model: body.model, thread: body.thread ?? null, messages: Array.isArray(body.messages) ? body.messages.length : null, tools: Array.isArray(body.tools) ? body.tools.length : null });
        this.onRequest(f, body);
      } else {
        this.events.write('bodies', 'response', { file: f, id: body.id, stop_reason: body.stop_reason, usage: body.usage ?? null, diagnostics: body.diagnostics ?? null });
      }
    }
  }
}

const HOOKS: HookEvent[] = ['UserPromptSubmit', 'PreToolUse', 'Stop', 'StopFailure'];

function hooks(events: Events, onPreToolUse: (input: HookInput) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const out: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const h of HOOKS) {
    out[h] = [
      {
        hooks: [
          async (input) => {
            const i = input as Json;
            events.write('hook', h, { tool_name: i.tool_name, error: i.error, lastLen: typeof i.last_assistant_message === 'string' ? i.last_assistant_message.length : undefined });
            if (h === 'PreToolUse') {
              onPreToolUse(input);
            }
            return { continue: true };
          },
        ],
      },
    ];
  }
  return out;
}

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const f of existsSync(from) ? readdirSync(from) : []) {
    if (f !== 'latest') {
      writeFileSync(join(to, f), clean(readFileSync(join(from, f), 'utf8')));
    }
  }
}

function resetConfigDir(name: string): string {
  const r = spawnSync('pnpm', ['-s', 'reset-config-dir', name], { cwd: PACKAGE, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`reset-config-dir ${name} refused (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function baseOptions(model: string, store: SessionStore, bodies: string, env: Record<string, string>, ev: Events, onPreToolUse: (i: HookInput) => void): HarnessOptions {
  return {
    model,
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    tools: ['Bash', 'Write'],
    canUseTool: async (toolName, input) => {
      ev.write('proof', 'canUseTool', { toolName });
      return { behavior: 'allow', updatedInput: input };
    },
    hooks: hooks(ev, onPreToolUse),
    settings: { disableClaudeAiConnectors: true },
    sessionStore: store,
    sessionStoreFlush: 'eager',
    env: { ...process.env, ...env, OTEL_LOG_RAW_API_BODIES: `file:${bodies}` },
  };
}

// ---------------------------------------------------------------------------
// The holdings at step 1's result.

interface Holding {
  way: string;
  entries: Json[];
  resume: Json;
  bodies: number;
  invalid: string[];
  notCommitted: string[];
}

function holdingsAt(rawDir: string, model: string): Holding[] {
  const L = readRecording(rawDir, model);
  const at = L.step1ResultMs;
  if (at === undefined) {
    return [];
  }
  const out: Holding[] = [];
  // The control: Claude Code's own record at the result (proof 24's H).
  const commits = assistantCommits(L.rec);
  const recEntries = L.rec.entries.filter((r) => r.ms <= at && !(kindOf(r.entry) === 'assistant' && !commits.has(String(r.entry.uuid))));
  const ctl = load([], recEntries);
  out.push({ way: 'record', entries: ctl.entries, resume: ctl.lastChain ? { resumeSessionAt: ctl.lastChain } : {}, bodies: 0, invalid: [], notCommitted: [] });
  for (const option of ['entry', 'run+last', 'run+entry', 'request', 'run', 'next'] as const) {
    const h = holdingAt(L.rec, option, at);
    // Through JSON, as tower would hold them.
    const bodies = JSON.parse(JSON.stringify(toBodies(h.messages))) as TowerBody[];
    const invalid = bodies.flatMap((b) => checkBody(b).map((e) => `${b.id}: ${e}`));
    const l = load(bodies, h.unshown);
    out.push({ way: option, entries: l.entries, resume: l.lastChain ? { resumeSessionAt: l.lastChain } : {}, bodies: bodies.length, invalid, notCommitted: h.notCommitted.map((r) => String(r.entry.uuid)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The main run.

interface MainOut {
  dir: string;
  rawDir: string;
  sessionId: string;
  holdings: Holding[];
  stopped: string | null;
  probeFile: string | undefined;
}

function newRawDir(model: string, label: string): string {
  const d = join(STATE, `${stamp().replace(/[:.]/g, '')}-${short(model)}-${label}`);
  mkdirSync(join(d, 'api-bodies'), { recursive: true });
  return d;
}

async function runMain(model: string, cell: Cell): Promise<MainOut> {
  const rawDir = newRawDir(model, cell.id);
  const bodies = join(rawDir, 'api-bodies');
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = { write: (s: string, k: string, d: Json = {}) => (events ? events.write(s, k, d) : pre.push([s, k, d])) } as Events;
  const store = new RecordingStore(ev, join(rawDir, 'store-appends.jsonl'));
  let run: Run | undefined;
  let step = 0;
  let stopped: string | null = null;
  const fire = (how: string): void => {
    if (stopped || !run || step !== 1 || resultSeen1) {
      return;
    }
    stopped = how;
    ev.write('proof', 'stop', { how });
    void run.interrupt().then(
      (res) => ev.write('proof', 'interrupt-returned', { result: (res ?? null) as unknown as Json }),
      (err: unknown) => ev.write('proof', 'interrupt-error', { error: String(err) }),
    );
  };
  const onPreToolUse = (input: HookInput): void => {
    if (cell.ending === 'tool-exec' && (input as Json).tool_name === 'Bash') {
      setTimeout(() => fire('2 s after PreToolUse for Bash'), 2000);
    }
  };
  const options = baseOptions(model, store, bodies, cell.env ?? {}, ev, onPreToolUse);
  const bw = new BodiesWatch(bodies, ev);
  let probeFile: string | undefined;
  bw.onRequest = (file, body) => {
    const main = String(body.model).startsWith(model) && body.thinking !== undefined;
    if (!main) {
      return;
    }
    const text = JSON.stringify(body.messages ?? []);
    if (step === 1 && cell.ending === 'first-byte' && text.includes(cell.prompt.slice(0, 30))) {
      fire(`request file ${file}`);
    }
    if (step === 2 && probeFile === undefined && text.includes(PROBE)) {
      probeFile = file;
    }
  };
  run = startRun({ name: agentName(model), options });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  writeFileSync(join(run.dir, 'next-plan.json'), `${JSON.stringify({ model, cell, rawDir, role: 'main' }, null, 2)}\n`);
  process.stdout.write(`${stamp()} ${cell.id}: main ${run.dir}\n`);
  bw.start();

  const steps = [WARM, cell.prompt, PROBE];
  const sdkSteps: { prompt: string; messages: Json[] }[] = [];
  let sessionId = '';
  let quiet: NodeJS.Timeout | undefined;
  let stepTimer: NodeJS.Timeout | undefined;
  let resultSeen = false;
  let resultSeen1 = false;
  const stream = { thinkingOpen: false, textChars: 0, inputChars: 0 };
  const send = async (): Promise<void> => {
    const text = steps[step];
    if (text === undefined || !run) {
      ev.write('proof', 'end', {});
      run?.end();
      return;
    }
    ev.write('proof', 'send', { step, text });
    sdkSteps.push({ prompt: text, messages: [] });
    resultSeen = false;
    Object.assign(stream, { thinkingOpen: false, textChars: 0, inputChars: 0 });
    run.send(user(text));
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      ev.write('proof', 'step-timeout', { step });
      run?.end();
    }, STEP_TIMEOUT_MS);
  };
  const advance = (): void => {
    quiet = undefined;
    step += 1;
    void (async () => {
      await send();
    })();
  };
  void send();
  try {
    for await (const message of run.messages()) {
      const m = message as SDKMessage & Json;
      const rec = sdkSteps[sdkSteps.length - 1];
      rec?.messages.push(m as Json);
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = String(m.session_id);
      }
      if (m.type !== 'stream_event') {
        ev.write('sdk', m.type === 'system' ? `system:${String(m.subtype)}` : String(m.type), { uuid: m.uuid, subtype: m.subtype });
      }
      if (quiet) {
        clearTimeout(quiet);
        quiet = undefined;
      }
      if (m.type === 'stream_event' && (m.parent_tool_use_id ?? null) === null && step === 1) {
        const e = m.event as unknown as Json;
        const block = e.content_block as Json | undefined;
        const delta = e.delta as Json | undefined;
        if (e.type === 'content_block_start' && block?.type === 'thinking') {
          stream.thinkingOpen = true;
          if (cell.ending === 'thinking') {
            setTimeout(() => (stream.thinkingOpen ? fire('700 ms into an open thinking block') : ev.write('proof', 'trigger-missed', {})), 700);
          }
        }
        if (e.type === 'content_block_stop') {
          stream.thinkingOpen = false;
        }
        if (e.type === 'content_block_delta' && delta?.type === 'text_delta') {
          stream.textChars += String(delta.text ?? '').length;
          if (cell.ending === 'mid-text' && stream.textChars >= 60) {
            fire(`${stream.textChars} text characters streamed`);
          }
        }
        if (e.type === 'content_block_delta' && delta?.type === 'input_json_delta') {
          stream.inputChars += String(delta.partial_json ?? '').length;
          if (cell.ending === 'tool-input' && stream.inputChars >= 100) {
            fire(`${stream.inputChars} tool input characters streamed`);
          }
        }
      }
      if (m.type === 'result') {
        resultSeen = true;
        if (step === 1 && !resultSeen1) {
          resultSeen1 = true;
          ev.write('proof', 'step1-result', { storeEntries: store.all.length });
        }
      }
      if (resultSeen) {
        quiet = setTimeout(advance, QUIET_MS);
      }
    }
  } catch (err) {
    ev.write('proof', 'messages-error', { error: err instanceof Error ? err.message : String(err) });
  }
  clearTimeout(quiet);
  clearTimeout(stepTimer);
  try {
    await run.done;
  } catch (err) {
    ev.write('proof', 'run-done-error', { error: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((r) => setTimeout(r, 1500));
  bw.stop();
  copyDir(bodies, join(run.dir, 'api-bodies'));
  const holdings = holdingsAt(rawDir, model);
  writeFileSync(join(rawDir, 'holdings.json'), JSON.stringify(holdings));
  writeFileSync(join(run.dir, 'holdings.json'), clean(JSON.stringify(holdings)));
  writeFileSync(join(run.dir, 'store-appends.jsonl'), clean(existsSync(join(rawDir, 'store-appends.jsonl')) ? readFileSync(join(rawDir, 'store-appends.jsonl'), 'utf8') : ''));
  process.stdout.write(`${stamp()} ${cell.id}: main done, stopped: ${stopped ?? 'no'}, holdings ${holdings.map((h) => `${h.way}:${h.entries.length}${h.invalid.length ? `(invalid ${h.invalid.length})` : ''}`).join(' ')}\n`);
  return { dir: run.dir, rawDir, sessionId, holdings, stopped, probeFile };
}

// ---------------------------------------------------------------------------
// A resume from one holding.

async function runResume(model: string, cell: Cell, sessionId: string, label: string, entries: Json[], resumeExtra: Json = {}): Promise<{ dir: string; rawDir: string }> {
  const rawDir = newRawDir(model, `${cell.id}-${label}`);
  const bodies = join(rawDir, 'api-bodies');
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = { write: (s: string, k: string, d: Json = {}) => (events ? events.write(s, k, d) : pre.push([s, k, d])) } as Events;
  const store = new RecordingStore(ev, join(rawDir, 'store-appends.jsonl'), entries);
  const extra = {};
  const options: HarnessOptions = { ...baseOptions(model, store, bodies, { ...(cell.resumeEnv ?? cell.env ?? {}), ...extra }, ev, () => {}), resume: sessionId, ...(resumeExtra as Partial<HarnessOptions>) };
  const bw = new BodiesWatch(bodies, ev);
  const run = startRun({ name: agentName(model), options });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  writeFileSync(join(run.dir, 'next-plan.json'), `${JSON.stringify({ model, cell, rawDir, role: 'resume', label, sessionId, loaded: entries.length }, null, 2)}\n`);
  bw.start();
  let quiet: NodeJS.Timeout | undefined;
  const timer = setTimeout(() => run.end(), STEP_TIMEOUT_MS);
  run.send(user(PROBE));
  ev.write('proof', 'send', { step: 0, text: PROBE });
  try {
    for await (const message of run.messages()) {
      const m = message as SDKMessage & Json;
      if (m.type !== 'stream_event') {
        ev.write('sdk', m.type === 'system' ? `system:${String(m.subtype)}` : String(m.type), { uuid: m.uuid, subtype: m.subtype });
      }
      clearTimeout(quiet);
      if (m.type === 'result') {
        quiet = setTimeout(() => run.end(), QUIET_MS);
      }
    }
  } catch (err) {
    ev.write('proof', 'messages-error', { error: err instanceof Error ? err.message : String(err) });
  }
  clearTimeout(quiet);
  clearTimeout(timer);
  try {
    await run.done;
  } catch (err) {
    ev.write('proof', 'run-done-error', { error: err instanceof Error ? err.message : String(err) });
  }
  await new Promise((r) => setTimeout(r, 1000));
  bw.stop();
  copyDir(bodies, join(run.dir, 'api-bodies'));
  writeFileSync(join(run.dir, 'store-appends.jsonl'), clean(existsSync(join(rawDir, 'store-appends.jsonl')) ? readFileSync(join(rawDir, 'store-appends.jsonl'), 'utf8') : ''));
  process.stdout.write(`${stamp()} ${cell.id}: resume ${label} (${entries.length} entries) ${run.dir}\n`);
  return { dir: run.dir, rawDir };
}

// The warm-up alone, run to the end, so the config directory has what Claude
// Code caches on a first run before any cell starts.
async function runPrime(model: string): Promise<void> {
  const rawDir = newRawDir(model, 'prime');
  const pre: [string, string, Json][] = [];
  let events: Events | undefined;
  const ev = { write: (s: string, k: string, d: Json = {}) => (events ? events.write(s, k, d) : pre.push([s, k, d])) } as Events;
  const store = new RecordingStore(ev, join(rawDir, 'store-appends.jsonl'));
  const run = startRun({ name: agentName(model), options: baseOptions(model, store, join(rawDir, 'api-bodies'), {}, ev, () => {}) });
  events = new Events(run.dir, rawDir);
  for (const [s, k, d] of pre) {
    events.write(s, k, d);
  }
  run.send(user(WARM));
  for await (const m of run.messages()) {
    if (m.type === 'result') {
      run.end();
    }
  }
  try {
    await run.done;
  } catch (err) {
    ev.write('proof', 'run-done-error', { error: String(err) });
  }
  process.stdout.write(`${stamp()} prime: ${run.dir}\n`);
}

const hashOf = (h: Holding): string => createHash('sha256').update(JSON.stringify([h.entries, h.resume ?? null])).digest('hex').slice(0, 12);

async function runCell(model: string, cell: Cell): Promise<Json> {
  const main = await runMain(model, cell);
  const row: Json = { model, cell: cell.id, main: main.dir, rawDir: main.rawDir, sessionId: main.sessionId, stopped: main.stopped, probeFile: main.probeFile ?? null, ways: {}, resumes: {} };
  const byHash = new Map<string, string[]>();
  for (const h of main.holdings) {
    const k = hashOf(h);
    (row.ways as Json)[h.way] = { entries: h.entries.length, hash: k, bodies: h.bodies, invalid: h.invalid, notCommitted: h.notCommitted, resumeSessionAt: (h.resume as Json).resumeSessionAt ?? null };
    byHash.set(k, [...(byHash.get(k) ?? []), h.way]);
  }
  if (!main.sessionId) {
    return row;
  }
  // RC_ONLY_WAY: resume only from this way's holding, so it is the first
  // and only resume after L (a real participant resumes once; each resume
  // can read what an earlier resume wrote to the cache).
  const only = process.env.RC_ONLY_WAY;
  for (const [k, ways] of byHash) {
    if (only !== undefined && !ways.includes(only)) {
      continue;
    }
    const h = main.holdings.find((x) => hashOf(x) === k);
    if (!h) {
      continue;
    }
    const r = await runResume(model, cell, main.sessionId, ways[0]?.replace(/[^A-Za-z0-9+-]/g, '_') ?? 'resume', h.entries, h.resume ?? {});
    (row.resumes as Json)[k] = { ways, dir: r.dir, rawDir: r.rawDir };
  }
  return row;
}

async function main(): Promise<void> {
  const [model, ...wanted] = process.argv.slice(2);
  if (!model || wanted.length === 0) {
    process.stderr.write('usage: node proofs/next/run.mts <model> <cell|all> [...]\n');
    process.exit(2);
  }
  const all = cells(model);
  const chosen = wanted.includes('all') ? all : wanted.map((w) => all.find((c) => c.id === w) ?? (() => { throw new Error(`no cell ${w}`); })());
  mkdirSync(STATE, { recursive: true });
  if (process.env.RC_NO_RESET !== '1') {
    process.stdout.write(`${stamp()} reset ${resetConfigDir(agentName(model))}\n`);
  }
  if (process.env.RC_NO_PRIME !== '1') {
    await runPrime(model);
  }
  const indexPath = join(PACKAGE, 'runs', `rc-index-${short(model)}-${stamp().replace(/[:.]/g, '')}.json`);
  const index: Json[] = [];
  for (const cell of chosen) {
    try {
      index.push(await runCell(model, cell));
    } catch (err) {
      index.push({ model, cell: cell.id, failed: err instanceof Error ? err.message : String(err) });
      process.stdout.write(`${stamp()} ${cell.id}: failed ${String(err)}\n`);
    }
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }
  process.stdout.write(`${stamp()} INDEX ${indexPath}\n`);
}

await main();
