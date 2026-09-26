// Proof 20: approach A live on one model, with the main conversation's
// requests found by their history (select.mts), retries and aborts made on
// purpose (faults.mts), and resumes from what A published.
//
// Choices made for this proof, not decisions (TODO: undecided, each the
// easiest thing that runs):
//   - A publishes under Claude Code's session id; B does not run.
//   - A request whose history is the main conversation's but whose added
//     messages aren't anchored yet is looked at again 300, 1000 and 3000 ms
//     later (its entries can reach the store after the request file).
//   - Faults: a connection reset through the CONNECT tunnel, and the SDK's
//     interrupt, each on the first request file (or first text delta) after
//     the step's prompt.
//   - Raw bodies, raw store appends and raw OTEL events stay under
//     ~/.local/state/tower-claude-code-harness/proof-20/; runs/ gets copies
//     with tokens and email addresses redacted.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanUseTool, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { redact, stamp } from '../../src/record.mts';
import { readJsonl } from './corpus.mts';
import { faultEnv, Otel, Tunnel } from './faults.mts';
import { type Block, type Json, rebuild } from './form.mts';
import { Publisher, Recorder, redactEmails } from './publish.mts';
import { flatTail, select } from './select.mts';
import { lastSeq, modelsByTurn, openTower, type Tower, towerMessages } from './tower.mts';

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'proof-20');
const SEEDS = join(STATE, 'seeds');
const BODIES_ROOT = join(STATE, 'api-bodies');
const RAW_ROOT = join(STATE, 'raw');
const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const QUIET_MS = 3000;
const SETTLE_MS = 300;
const RECHECK_MS = [300, 1000, 3000];

type Fault = 'kill-first-byte' | 'kill-mid-stream' | 'abort-first-byte' | 'abort-mid-stream';
interface Step {
  prompt: string;
  midTurn?: string[];
  fault?: Fault;
}

interface Scenario {
  files: Record<string, string>;
  steps: Step[];
  options: Partial<HarnessOptions>;
  env?: Record<string, string>;
}

const SCENARIOS: Record<string, Scenario> = {
  // Thinking and a slow Bash round with a mid-turn message (a reminder that,
  // without system turns, goes inside the tool result); a subagent on the
  // same model; a retry before the first byte and one mid-stream; an abort
  // before the first byte and one mid-stream; one more prompt. The first
  // prompt goes without waiting for the account's connectors, so their tools
  // join mid-conversation (tool_addition on Opus and Fable).
  main: {
    files: { 'note.txt': 'AMBER 2020' },
    steps: [
      {
        prompt: 'Work out, carefully, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7. Then run this exact Bash command, once: `sleep 6; cat note.txt`. Reply with the number and the command output, nothing else.',
        midTurn: ['One more thing: after the output, add the word PINEAPPLE on its own line.'],
      },
      { prompt: 'Use the Agent tool, with subagent_type general-purpose, to have a subagent run the Bash command `cat note.txt` and report what it printed. Then reply with that output only.' },
      { prompt: 'Reply with the word RETRY only.', fault: 'kill-first-byte' },
      { prompt: 'Write the numbers one to twenty in words, one per line, nothing else.', fault: 'kill-mid-stream' },
      { prompt: 'Reply with the word ABORTED only.', fault: 'abort-first-byte' },
      { prompt: 'Write the numbers one to forty in words, one per line, nothing else.', fault: 'abort-mid-stream' },
      { prompt: 'Reply with the word OK only.' },
    ],
    options: { tools: ['Bash', 'Agent'], allowedTools: ['Bash', 'Agent'] },
  },
  // The output limit (proof 6's max-tokens-hit): Claude Code's "Output token
  // limit hit" meta messages, and thinking-only responses dropped from the
  // history.
  limit: {
    files: {},
    steps: [{ prompt: 'Write a 2,000-word short story about a lighthouse keeper. Start writing straight away, with no preamble.' }],
    options: { tools: ['Bash'], allowedTools: ['Bash'] },
    env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '256' },
  },
};

const RESUME_STEPS: Step[] = [{ prompt: 'Reply with the word OK only.' }];

export const SOURCES = ['full', 'A', 'A-silent', 'A-silent-sc'] as const;
export type Source = (typeof SOURCES)[number];

const short = (model: string): string => model.replace(/^claude-/, '').replace(/[^A-Za-z0-9]/g, '');
const seedName = (model: string, scenario: string): string => `p20-${short(model)}-${scenario}`;
const resumeName = (model: string): string => `p20-${short(model)}-resume`;
const workDir = (name: string): string => join(HARNESS_STATE, 'work', name);

function resetConfigDir(name: string): string {
  const r = spawnSync('pnpm', ['-s', 'reset-config-dir', name], { cwd: PACKAGE, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`reset-config-dir ${name} refused (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function writeFiles(name: string, files: Record<string, string>): void {
  const dir = workDir(name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    writeFileSync(join(dir, f), `${text}\n`);
  }
}

function brief(e: Json): Json {
  return { type: e.type, sub: (e.attachment as Json | undefined)?.type ?? e.subtype, uuid: e.uuid, isMeta: e.isMeta };
}

class RawLog {
  readonly path: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
  }
  write(v: unknown): void {
    appendFileSync(this.path, `${JSON.stringify(v)}\n`);
  }
}

// ---------------------------------------------------------------------------
// Request files, as Claude Code writes them (every source: the selector
// decides).

interface SeenFile {
  file: string;
  body: Json;
  seenAt: string;
  seenMs: number;
  mtimeMs: number;
}

class WireWatch {
  readonly dir: string;
  readonly seen = new Set<string>();
  readonly onSeen: (f: SeenFile) => void;
  readonly onSettled: (f: SeenFile) => void;
  readonly settling: Promise<void>[] = [];
  timer: NodeJS.Timeout | undefined;
  constructor(dir: string, onSeen: WireWatch['onSeen'], onSettled: WireWatch['onSettled']) {
    this.dir = dir;
    this.onSeen = onSeen;
    this.onSettled = onSettled;
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), 20);
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.poll();
    await Promise.all(this.settling);
  }
  poll(): void {
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith('.request.json') && !this.seen.has(f))
      .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (const { f, t } of files) {
      let body: Json;
      try {
        body = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Json;
      } catch {
        return; // still being written
      }
      this.seen.add(f);
      const s: SeenFile = { file: f, body, seenAt: stamp(), seenMs: Date.now(), mtimeMs: t };
      this.onSeen(s);
      this.settling.push(
        new Promise((resolve) => {
          setTimeout(() => {
            this.onSettled(s);
            resolve();
          }, SETTLE_MS);
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Stores

class SeedStore implements SessionStore {
  readonly pub: Publisher;
  readonly rec = new Recorder('store-appends.jsonl');
  raw: RawLog | undefined;
  sessionId: string | undefined;
  constructor(pub: Publisher) {
    this.pub = pub;
  }
  toJSON(): Json {
    return { store: 'seed', convId: this.pub.convId };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.rec.write({ ts: stamp(), key, count: entries.length, entries });
    this.raw?.write({ ts: stamp(), key, entries });
    if (key.subpath) {
      return;
    }
    if (this.sessionId === undefined) {
      this.sessionId = key.sessionId;
      this.pub.convId = key.sessionId;
    }
    await this.pub.append(entries as Json[]);
  }
  async load(): Promise<SessionStoreEntry[] | null> {
    return null;
  }
}

class ResumeStore implements SessionStore {
  readonly source: (key: SessionKey) => Promise<{ entries: Json[] | null; detail: Json }>;
  readonly rec = new Recorder('store-appends.jsonl');
  readonly loadRec = new Recorder('store-load.jsonl');
  readonly loadedRec = new Recorder('loaded-entries.jsonl');
  constructor(source: ResumeStore['source']) {
    this.source = source;
  }
  toJSON(): Json {
    return { store: 'resume', appends: 'recorded only' };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.rec.write({ ts: stamp(), key, count: entries.length, entries });
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const { entries, detail } = await this.source(key);
    this.loadRec.write({ ts: stamp(), key, returned: entries === null ? null : entries.length, ...detail, entries: entries?.map(brief) });
    for (const e of entries ?? []) {
      this.loadedRec.write(e);
    }
    return entries as SessionStoreEntry[] | null;
  }
}

// ---------------------------------------------------------------------------
// Driving

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

interface Armed {
  fault: Fault;
  step: number;
}

interface Drive {
  armed: Armed | undefined;
  trigger: (how: string, detail: Json) => void;
}

async function drive(run: Run, steps: Step[], log: (s: string) => void, events: Recorder, d: Drive, onMain: (event: Json) => void, firstDelayMs = 0): Promise<void> {
  let index = 0;
  let resultSeen = false;
  let midTurnSent = false;
  let quiet: NodeJS.Timeout | undefined;
  let line = 0;
  const runStep = (): void => {
    const step = steps[index];
    if (!step) {
      log('quiet after last step; end');
      run.end();
      return;
    }
    log(`step ${index + 1}: send ${JSON.stringify(step.prompt)}${step.fault ? ` with fault ${step.fault}` : ''}`);
    events.write({ ts: stamp(), step: index + 1, send: step.prompt, fault: step.fault });
    midTurnSent = false;
    d.armed = step.fault ? { fault: step.fault, step: index + 1 } : undefined;
    run.send(user(step.prompt));
  };
  const advance = (): void => {
    quiet = undefined;
    resultSeen = false;
    index += 1;
    runStep();
  };
  if (firstDelayMs > 0) {
    log(`waiting ${firstDelayMs} ms before the first step`);
    await new Promise((r) => setTimeout(r, firstDelayMs));
  }
  runStep();
  for await (const message of run.messages()) {
    line += 1;
    if (quiet) {
      clearTimeout(quiet);
      quiet = undefined;
    }
    const m = message as SDKMessage & Json;
    if (m.type === 'stream_event' && m.parent_tool_use_id === null) {
      const ev = m.event as unknown as Json;
      onMain(ev);
      if (ev.type === 'message_start') {
        events.write({ ts: stamp(), sdkLine: line, messageStart: (ev.message as Json).id });
      }
      if (d.armed && d.armed.fault.endsWith('mid-stream') && ev.type === 'content_block_delta' && (ev.delta as Json).type === 'text_delta') {
        d.trigger('first text delta', { sdkLine: line });
      }
    }
    if (m.type === 'system' && m.subtype === 'api_retry') {
      events.write({ ts: stamp(), sdkLine: line, apiRetry: { attempt: m.attempt, max_retries: m.max_retries, retry_delay_ms: m.retry_delay_ms, error_status: m.error_status, error: m.error, no_response: m.no_response } });
      log(`sdk line ${line}: api_retry attempt ${String(m.attempt)} status ${String(m.error_status)}`);
    }
    if (m.type === 'system' && m.subtype === 'init') {
      events.write({ ts: stamp(), sdkLine: line, init: { session_id: m.session_id, model: m.model, tools: m.tools } });
    }
    const step = steps[index];
    if (step?.midTurn && !midTurnSent && m.type === 'assistant' && m.parent_tool_use_id === null && ((m.message as unknown as Json).content as Block[]).some((b) => b.type === 'tool_use')) {
      midTurnSent = true;
      for (const text of step.midTurn) {
        log(`sdk line ${line}: tool_use seen; mid-turn send ${JSON.stringify(text)}`);
        events.write({ ts: stamp(), sdkLine: line, midTurn: text });
        run.send(user(text));
      }
    }
    if (m.type === 'result') {
      log(`sdk line ${line}: result ${String(m.subtype)}`);
      events.write({ ts: stamp(), sdkLine: line, result: m.subtype, is_error: m.is_error });
    }
    if (m.type === 'result' || resultSeen) {
      resultSeen = true;
      quiet = setTimeout(advance, QUIET_MS);
    }
  }
  if (quiet) {
    clearTimeout(quiet);
  }
}

const approveAll =
  (events: Recorder): CanUseTool =>
  async (toolName, input) => {
    events.write({ ts: stamp(), canUseTool: toolName, input });
    return { behavior: 'allow', updatedInput: input };
  };

function bodiesDirFor(tag: string): string {
  const dir = join(BODIES_ROOT, `${stamp().replace(/[:.]/g, '')}-${tag}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function options(model: string, store: SessionStore, bodiesDir: string, approvals: Recorder, s: Scenario, fault: Record<string, string>): HarnessOptions {
  return {
    model,
    canUseTool: approveAll(approvals),
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    sessionStore: store,
    sessionStoreFlush: 'eager',
    ...s.options,
    env: { ...process.env, ...(s.env ?? {}), ...fault, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  };
}

function copyBodies(from: string, runDir: string): void {
  const to = join(runDir, 'api-bodies');
  mkdirSync(to, { recursive: true });
  for (const entry of existsSync(from) ? readdirSync(from) : []) {
    if (entry === 'latest') {
      continue;
    }
    writeFileSync(join(to, entry), redactEmails(redact(readFileSync(join(from, entry), 'utf8')).text));
  }
}

function makeLog(rec: Recorder): (s: string) => void {
  return (s: string): void => {
    const line = `${stamp()} ${s}`;
    process.stdout.write(`${redactEmails(line)}\n`);
    rec.write(line);
  };
}

export interface SeedRecord {
  scenario: string;
  sessionId: string;
  convA: string;
  model: string;
  seedRun: string;
  seedName: string;
  rawAppends: string;
  bodies: string;
  upto: number;
}

// ---------------------------------------------------------------------------

export async function seed(model: string, scenarioName: string): Promise<void> {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`no scenario ${scenarioName}`);
  }
  const name = seedName(model, scenarioName);
  const reset = resetConfigDir(name);
  writeFiles(name, scenario.files);
  const tower = await openTower();
  const pub = new Publisher(tower, 'pending', 'A');
  const store = new SeedStore(pub);
  const bodies = bodiesDirFor(`seed-${short(model)}-${scenarioName}`);
  const tunnel = new Tunnel();
  const otel = new Otel();
  const fault = faultEnv(await tunnel.start(), await otel.start());
  const signals = new Recorder('signals.jsonl');
  const files = new Recorder('request-files.jsonl');
  const faults = new Recorder('faults.jsonl');
  const otelRec = new Recorder('otel-events.jsonl');
  const events = new Recorder('proof-events.jsonl');
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  tunnel.onEvent = (e) => faults.write({ tunnel: e });
  otel.onEvent = (e) => otelRec.write(e);
  const d: Drive = { armed: undefined, trigger: () => {} };
  let run: Run | undefined;
  d.trigger = (how, detail) => {
    const armed = d.armed;
    if (!armed || !run) {
      return;
    }
    d.armed = undefined;
    const at = stamp();
    if (armed.fault.startsWith('kill')) {
      const n = tunnel.kill(`${armed.fault} on ${how}`);
      faults.write({ at, step: armed.step, fault: armed.fault, how, ...detail, tunnelsReset: n });
    } else {
      faults.write({ at, step: armed.step, fault: armed.fault, how, ...detail, interrupt: 'sent' });
      void run.interrupt().then(
        (r) => faults.write({ at: stamp(), step: armed.step, interruptReturned: r ?? null }),
        (err: unknown) => faults.write({ at: stamp(), step: armed.step, interruptError: String(err) }),
      );
    }
  };
  const handle = (f: SeenFile, attempt: number): void => {
    void pub.serial(async () => {
      const body = f.body as Json & { messages: never[] };
      const v = select(body as never, { model, main: pub.main, pending: () => pub.pendingEntries(), accepted: pub.accepted as never });
      const at = stamp();
      const row: Json = { at, file: f.file, attempt, seenAt: f.seenAt, fileMtime: new Date(f.mtimeMs).toISOString(), model: body.model, thread: (body.thread as Json | undefined)?.type ?? null, main: v.main, retry: v.retry, reason: v.reason, anchor: v.anchor, resent: v.resent, prevId: v.prevId, prevIdSays: v.prevIdSays, proof16Says: v.proof16Says };
      if (!v.main) {
        const again = v.anchor !== '' && attempt < RECHECK_MS.length;
        signals.write({ ...row, recheck: again ? RECHECK_MS[attempt] : null });
        if (again) {
          setTimeout(() => handle(f, attempt + 1), RECHECK_MS[attempt]);
        }
        return;
      }
      if (v.retry) {
        signals.write({ ...row, turnId: pub.currentTurn });
        return;
      }
      const a = v.attribution;
      if (!a) {
        return;
      }
      pub.accepted.push({ anchor: v.anchor, tail: flatTail(body as never) });
      const turnId = randomUUID();
      pub.requestTaken(turnId);
      // Entries appended well before the request that it didn't carry stop
      // blocking; later requests can't claim them (recorded).
      const release = a.unplaced.filter((e) => (pub.findAppended(String(e.uuid))?.ms ?? Infinity) < f.mtimeMs - SETTLE_MS);
      signals.write({ ...row, turnId, placed: a.messages.map((m) => ({ role: m.role, entries: m.ccEntries.filter((c) => c.spans.length > 0).map((c) => c.uuid) })), uncovered: a.uncovered, unplaced: a.unplaced.map(brief), notes: a.notes, released: release.map(brief) });
      void pub.resolve(a.messages, turnId, `request-file ${f.file}`, f.seenAt, f.seenMs, release, { reason: 'not in the request that followed it' });
    });
  };
  const wire = new WireWatch(
    bodies,
    (f) => {
      files.write({ file: f.file, seenAt: f.seenAt, fileMtime: new Date(f.mtimeMs).toISOString(), model: f.body.model, thread: f.body.thread ?? null, diagnostics: f.body.diagnostics ?? null, messages: (f.body.messages as unknown[]).length, max_tokens: f.body.max_tokens, betas: f.body.betas });
      // A first-byte fault fires on the first request file on the model after
      // the step's prompt (the proof checks afterwards that it was a main
      // request).
      if (d.armed?.fault.endsWith('first-byte') && f.body.model === model) {
        d.trigger('request file seen', { file: f.file, sinceMtimeMs: Date.now() - f.mtimeMs });
      }
    },
    (f) => handle(f, 0),
  );
  const logFn = { log: (_s: string): void => {} };
  run = startRun({ name, options: options(model, store, bodies, approvals, scenario, fault) });
  const rawAppends = join(RAW_ROOT, `${run.id}-store-appends.jsonl`);
  store.raw = new RawLog(rawAppends);
  const rawOtel = new RawLog(join(RAW_ROOT, `${run.id}-otel.jsonl`));
  const otelKeep = otel.onEvent;
  otel.onEvent = (e) => {
    otelKeep(e);
    rawOtel.write(e);
  };
  for (const r of [store.rec, pub.rec, pub.timing, signals, files, faults, otelRec, events, logRec, approvals]) {
    r.attach(run.dir);
  }
  logFn.log = makeLog(logRec);
  const log = logFn.log;
  log(`run dir: ${run.dir}; seed ${scenarioName} on ${model}; reset ${reset}; bodies ${bodies}; tunnel ${tunnel.port}; otel ${otel.port}`);
  wire.start();
  await drive(run, scenario.steps, log, events, d, (ev) => void pub.streamEvent(ev));
  try {
    await run.done;
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  await wire.stop();
  await new Promise((r) => setTimeout(r, RECHECK_MS.reduce((a, b) => a + b, 0) + SETTLE_MS * 2));
  await pub.chain;
  await pub.finish();
  // The OTEL batch interval is 200 ms; give the last export time to land.
  await new Promise((r) => setTimeout(r, 1500));
  await Promise.all([tunnel.stop(), otel.stop()]);
  const upto = await lastSeq(tower);
  const sessionId = store.sessionId;
  if (!sessionId) {
    throw new Error('seed: nothing was appended');
  }
  const rec: SeedRecord = { scenario: scenarioName, sessionId, convA: pub.convId, model, seedRun: run.dir, seedName: name, rawAppends, bodies, upto };
  mkdirSync(SEEDS, { recursive: true });
  writeFileSync(join(SEEDS, `${sessionId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  writeFileSync(join(run.dir, 'seed.json'), `${JSON.stringify(rec, null, 2)}\n`);
  copyBodies(bodies, run.dir);
  log(`conversation ${sessionId}; A published ${pub.published} on ${pub.convId}; last seq ${upto}`);
  process.stdout.write(`SEED ${sessionId} ${run.dir}\n`);
  await tower.nc.drain();
}

// ---------------------------------------------------------------------------

function rawEntries(rec: SeedRecord): Json[] {
  return readJsonl(rec.rawAppends)
    .filter((a) => !(a.key as SessionKey).subpath)
    .flatMap((a) => a.entries as Json[]);
}

export async function resume(model: string, source: Source, sessionId: string): Promise<void> {
  const seedPath = join(SEEDS, `${sessionId}.json`);
  if (!existsSync(seedPath)) {
    throw new Error(`no seed recorded for ${sessionId} (${seedPath})`);
  }
  const seedRec = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedRecord;
  const scenario = SCENARIOS[seedRec.scenario] as Scenario;
  const name = resumeName(model);
  const reset = resetConfigDir(name);
  writeFiles(name, scenario.files);
  const cwd = workDir(name);
  let tower: Tower | undefined;
  let load: ResumeStore['source'];
  if (source === 'full') {
    const entries = rawEntries(seedRec);
    load = async (key) => ({ entries: key.subpath ? null : entries, detail: { source, entries: entries.length } });
  } else {
    const t = await openTower();
    tower = t;
    // -silent: every no-block attachment; -silent-sc: only session_context.
    const withSilent = source === 'A-silent' ? true : source === 'A-silent-sc' ? new Set(['session_context']) : false;
    load = async (key) => {
      if (key.subpath) {
        return { entries: null, detail: { source, note: 'subagent transcript: nothing on tower for it' } };
      }
      const messages = await towerMessages(t, seedRec.convA, seedRec.upto);
      if (messages.length === 0) {
        return { entries: null, detail: { source, convId: seedRec.convA, messages: 0 } };
      }
      const entries = rebuild(messages, await modelsByTurn(t, seedRec.convA, seedRec.upto), cwd, key.sessionId, withSilent);
      return { entries, detail: { source, convId: seedRec.convA, withSilent: withSilent instanceof Set ? [...withSilent] : withSilent, upto: seedRec.upto, messages: messages.length } };
    };
  }
  const firstDelayMs = Number(process.env.PROOF20_FIRST_DELAY_MS ?? 20000);
  const store = new ResumeStore(load);
  const bodies = bodiesDirFor(`resume-${short(model)}-${seedRec.scenario}-${source}`);
  const tunnel = new Tunnel();
  const otel = new Otel();
  const fault = faultEnv(await tunnel.start(), await otel.start());
  const otelRec = new Recorder('otel-events.jsonl');
  otel.onEvent = (e) => otelRec.write(e);
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  const events = new Recorder('proof-events.jsonl');
  const run = startRun({ name, options: { ...options(model, store, bodies, approvals, scenario, fault), resume: sessionId } });
  for (const r of [store.rec, store.loadRec, store.loadedRec, otelRec, logRec, approvals, events]) {
    r.attach(run.dir);
  }
  const log = makeLog(logRec);
  writeFileSync(join(run.dir, 'resume.json'), `${JSON.stringify({ source, model, firstDelayMs, cwd: run.cwd, sessionId, seedRun: seedRec.seedRun, upto: seedRec.upto, reset }, null, 2)}\n`);
  log(`run dir: ${run.dir}; resume ${source}; session ${sessionId}; reset ${reset}`);
  const d: Drive = { armed: undefined, trigger: () => {} };
  await drive(run, RESUME_STEPS, log, events, d, () => {}, firstDelayMs);
  try {
    await run.done;
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  await new Promise((r) => setTimeout(r, 1500));
  await Promise.all([tunnel.stop(), otel.stop()]);
  copyBodies(bodies, run.dir);
  log('done');
  process.stdout.write(`RESUME ${source} ${run.dir}\n`);
  await tower?.nc.drain();
}
