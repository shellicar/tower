// Live runs: a seed conversation published by both approaches at once, each
// onto its own tower conversation, and resumes from Claude Code's full
// record and from each tower conversation alone.
//
// TODO: undecided (proof mechanism, not a proposal): A publishes under
// Claude Code's session id, B under a fresh uuid, so both can run on one
// seed; load() maps the session id to the right tower conversation.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CanUseTool, createSdkMcpServer, type SDKMessage, type SDKUserMessage, type SessionKey, type SessionStore, type SessionStoreEntry, tool } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { redact, stamp } from '../../src/record.mts';
import { attribute } from './by-body.mts';
import { predict, settingsForModel } from './by-fold.mts';
import { groups, mainRequests, readJsonl } from './corpus.mts';
import { type ApiMessage, type Block, isCarrier, isToolResults, type Json, messageId, rebuild } from './form.mts';
import { Publisher, Recorder } from './publish.mts';
import { lastSeq, modelsByTurn, openTower, type Tower, towerMessages, tsNow } from './tower.mts';

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'proof-16');
const SEEDS = join(STATE, 'seeds');
const BODIES_ROOT = join(STATE, 'api-bodies');
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'smoke-plugin');

const QUIET_MS = 3000;
// How long after a request file appears before A matches it: the eager
// store gets each entry within about 2 ms (proof 3).
const SETTLE_MS = 300;

type Step = { prompt: string; midTurn?: string[] } | { setCwd: string } | { dropMcp: true };

interface Scenario {
  seedName: string;
  resumeName: string;
  files: Record<string, Record<string, string>>;
  steps: Step[];
  options: (model: string) => Partial<HarnessOptions>;
  // Stamp every message the proof sends with origin { kind: 'human' }, as the
  // SDK says a host wrapping keyboard input must.
  stampHuman?: boolean;
}

const work = (name: string): string => join(HARNESS_STATE, 'work', name);

const probeServer = () => {
  const cfg = createSdkMcpServer({
    name: 'probe',
    version: '1.0.0',
    tools: [tool('probe_echo', 'Returns the word PROBE.', {}, async () => ({ content: [{ type: 'text', text: 'PROBE' }] }))],
  });
  // The harness records options as JSON; the server instance is circular.
  Object.defineProperty(cfg.instance, 'toJSON', { value: () => '[McpServer instance]' });
  return cfg;
};

const SCENARIOS: Record<string, Scenario> = {
  // Proof 14's seed: thinking and a Bash round; set_cwd; a slow Bash round
  // with a mid-turn message.
  main: {
    seedName: 'semantic-a',
    resumeName: 'semantic-b',
    files: { [work('semantic-a')]: { 'note.txt': 'AMBER 1111' }, [work('semantic-b')]: { 'note.txt': 'BIRCH 2222' } },
    steps: [
      {
        prompt:
          'Work out, carefully, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7. Then run this exact Bash command, once: `cat note.txt`. Reply with the number and the command output, nothing else.',
      },
      { setCwd: work('semantic-b') },
      {
        prompt: 'Run this exact Bash command, once: `sleep 8; cat note.txt`. Reply with its output only.',
        midTurn: ['One more thing: after the output, add the word PINEAPPLE on its own line.'],
      },
    ],
    options: () => ({}),
  },
  // The same mid-turn message twice during one tool round: two entries with
  // identical rendered text in one request.
  dup: {
    seedName: 'semantic-dup',
    resumeName: 'semantic-dup',
    files: { [work('semantic-dup')]: { 'note.txt': 'CEDAR 3333' } },
    steps: [
      {
        prompt: 'Run this exact Bash command, once: `sleep 8; cat note.txt`. Reply with its output only.',
        midTurn: ['Also add the word KIWI on its own line at the end.', 'Also add the word KIWI on its own line at the end.'],
      },
    ],
    options: () => ({}),
  },
  // Attachment types proof 14 didn't reach: a plugin skill (skill_listing),
  // the Agent tool (agent_listing_delta), an SDK MCP server dropped
  // mid-conversation (mcp_dropped_tools_delta?), deferred tools.
  types: {
    seedName: 'semantic-types',
    resumeName: 'semantic-types',
    files: { [work('semantic-types')]: { 'note.txt': 'DAHLIA 4444' } },
    steps: [{ prompt: 'Run this exact Bash command, once: `cat note.txt`. Reply with its output only.' }, { dropMcp: true }, { prompt: 'Reply with the word OK only.' }],
    options: () => ({
      tools: ['Bash', 'Agent'],
      allowedTools: ['Bash', 'Agent'],
      plugins: [{ type: 'local', path: PLUGIN_DIR }],
      mcpServers: { probe: probeServer() },
    }),
  },
  // The same without a tool list: Claude Code's default tools (ToolSearch,
  // deferred tools, the Skill tool), so skill_listing and deferred_tools_delta
  // can appear.
  types2: {
    seedName: 'semantic-types2',
    resumeName: 'semantic-types2',
    files: { [work('semantic-types2')]: { 'note.txt': 'ELM 5555' } },
    steps: [{ prompt: 'Run this exact Bash command, once: `cat note.txt`. Reply with its output only.' }, { dropMcp: true }, { prompt: 'Reply with the word OK only.' }],
    options: () => ({
      tools: undefined,
      allowedTools: ['Bash'],
      plugins: [{ type: 'local', path: PLUGIN_DIR }],
      mcpServers: { probe: probeServer() },
    }),
  },
  // A stdio MCP server with a tool whose schema the API would reject.
  types3: {
    seedName: 'semantic-types3',
    resumeName: 'semantic-types3',
    files: { [work('semantic-types3')]: { 'note.txt': 'FIR 6666' } },
    steps: [{ prompt: 'Run this exact Bash command, once: `cat note.txt`. Reply with its output only.' }, { prompt: 'Reply with the word OK only.' }],
    options: () => ({
      mcpServers: { badschema: { type: 'stdio', command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), 'bad-schema-mcp.mjs')] } },
    }),
  },
  // A mid-turn message stamped as the human's: Claude Code's human-turn
  // queued_command route (humanTurn), which folds it into the user message.
  human: {
    seedName: 'semantic-human',
    resumeName: 'semantic-human',
    files: { [work('semantic-human')]: { 'note.txt': 'GINKGO 7777' } },
    steps: [
      {
        prompt: 'Run this exact Bash command, once: `sleep 8; cat note.txt`. Reply with its output only.',
        midTurn: ['One more thing: after the output, add the word PINEAPPLE on its own line.'],
      },
    ],
    options: () => ({}),
    stampHuman: true,
  },
};

const RESUME_STEPS: Step[] = [{ prompt: 'Reply with the word OK only.' }];

function writeFiles(s: Scenario): void {
  for (const [dir, files] of Object.entries(s.files)) {
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), `${text}\n`);
    }
  }
}

function brief(e: Json): Json {
  return { type: e.type, sub: (e.attachment as Json | undefined)?.type ?? e.subtype, uuid: e.uuid, isMeta: e.isMeta };
}

// ---------------------------------------------------------------------------
// A's signal: a main-thread request body, as Claude Code writes it.

class WireWatch {
  readonly dir: string;
  readonly model: string;
  readonly onRequest: (file: string, body: Json, seenAt: string, seenMs: number) => void;
  readonly seen = new Set<string>();
  readonly settling: Promise<void>[] = [];
  timer: NodeJS.Timeout | undefined;
  constructor(dir: string, model: string, onRequest: WireWatch['onRequest']) {
    this.dir = dir;
    this.model = model;
    this.onRequest = onRequest;
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
      // Main thread only: the model asked for, with a thread (proof 14).
      if (body.model === this.model && body.thread !== undefined) {
        const seenAt = stamp();
        const seenMs = Date.now();
        this.settling.push(
          new Promise((resolve) => {
            setTimeout(() => {
              this.onRequest(f, { ...body, fileMtimeMs: t }, seenAt, seenMs);
              resolve();
            }, SETTLE_MS);
          }),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stores

class SeedStore implements SessionStore {
  readonly publishers: Publisher[];
  readonly rec = new Recorder('store-appends.jsonl');
  sessionId: string | undefined;
  readonly onSession: (sessionId: string) => void;
  constructor(publishers: Publisher[], onSession: (sessionId: string) => void) {
    this.publishers = publishers;
    this.onSession = onSession;
  }
  toJSON(): Json {
    return { store: 'seed', publishers: this.publishers.map((p) => ({ label: p.label, convId: p.convId })) };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.rec.write({ ts: stamp(), key, count: entries.length, entries });
    if (key.subpath) {
      return;
    }
    if (this.sessionId === undefined) {
      this.sessionId = key.sessionId;
      this.onSession(key.sessionId);
    }
    await Promise.all(this.publishers.map((p) => p.append(entries as Json[])));
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
// Driving (proof 14's drive(), with several mid-turn messages and an MCP drop)

let STAMP_HUMAN = false;
function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...(STAMP_HUMAN ? { origin: { kind: 'human' } } : {}) };
}

async function setCwd(run: Run, path: string): Promise<Json> {
  const request = (run.query as unknown as { request: (r: Json) => Promise<unknown> }).request.bind(run.query);
  const first = (await request({ subtype: 'set_cwd', path })) as { response?: { status?: string; directory?: string } };
  if (first?.response?.status === 'needs_trust') {
    const second = await request({ subtype: 'set_cwd', path, trust_accepted: true, trusted_directory: first.response.directory });
    return { first, second };
  }
  return { first };
}

interface Hooks {
  onStreamEvent?: (event: Json, at: string, ms: number) => void;
  onResult?: () => Promise<void>;
}

async function drive(run: Run, steps: Step[], log: (s: string) => void, hooks: Hooks, firstDelayMs = 0): Promise<void> {
  let index = 0;
  let resultSeen = false;
  let midTurnSent = false;
  let quiet: NodeJS.Timeout | undefined;
  let line = 0;
  const events = new Recorder('proof-events.jsonl');
  events.attach(run.dir);
  const runStep = async (): Promise<void> => {
    for (;;) {
      const step = steps[index];
      if (!step) {
        log('quiet after last step; end');
        run.end();
        return;
      }
      if ('setCwd' in step) {
        log(`step ${index + 1}: set_cwd ${step.setCwd}`);
        const result = await setCwd(run, step.setCwd).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
        events.write({ ts: stamp(), step: index + 1, setCwd: step.setCwd, result });
        index += 1;
        continue;
      }
      if ('dropMcp' in step) {
        log(`step ${index + 1}: setMcpServers({})`);
        const result = await run.query.setMcpServers({}).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
        events.write({ ts: stamp(), step: index + 1, setMcpServers: {}, result });
        log(`setMcpServers result: ${JSON.stringify(result)}`);
        index += 1;
        continue;
      }
      log(`step ${index + 1}: send ${JSON.stringify(step.prompt)}`);
      events.write({ ts: stamp(), step: index + 1, send: step.prompt });
      midTurnSent = false;
      run.send(user(step.prompt));
      return;
    }
  };
  const advance = async (): Promise<void> => {
    quiet = undefined;
    resultSeen = false;
    await hooks.onResult?.();
    index += 1;
    await runStep();
  };
  if (firstDelayMs > 0) {
    log(`waiting ${firstDelayMs} ms before the first step`);
    await new Promise((r) => setTimeout(r, firstDelayMs));
  }
  await runStep();
  for await (const message of run.messages()) {
    line += 1;
    if (quiet) {
      clearTimeout(quiet);
      quiet = undefined;
    }
    record(message, line, events);
    if (message.type === 'stream_event') {
      hooks.onStreamEvent?.(message.event as unknown as Json, stamp(), Date.now());
    }
    const step = steps[index];
    if (step && 'midTurn' in step && step.midTurn && !midTurnSent && message.type === 'assistant' && (message.message.content as unknown as Block[]).some((b) => b.type === 'tool_use')) {
      midTurnSent = true;
      for (const text of step.midTurn) {
        log(`sdk line ${line}: tool_use seen; mid-turn send ${JSON.stringify(text)}`);
        events.write({ ts: stamp(), sdkLine: line, midTurn: text });
        run.send(user(text));
      }
    }
    if (message.type === 'result') {
      log(`sdk line ${line}: result ${message.subtype}`);
    }
    if (message.type === 'result' || resultSeen) {
      resultSeen = true;
      quiet = setTimeout(() => void advance(), QUIET_MS);
    }
  }
  if (quiet) {
    clearTimeout(quiet);
  }
}

function record(message: SDKMessage, line: number, events: Recorder): void {
  if (message.type === 'system' && message.subtype === 'init') {
    events.write({ ts: stamp(), sdkLine: line, init: { cwd: message.cwd, session_id: message.session_id, model: message.model } });
  } else if (message.type === 'assistant') {
    for (const b of message.message.content as unknown as Block[]) {
      if (b.type === 'text') {
        events.write({ ts: stamp(), sdkLine: line, text: b.text });
      } else if (b.type === 'tool_use') {
        events.write({ ts: stamp(), sdkLine: line, toolUse: b.name, input: b.input });
      }
    }
  } else if (message.type === 'stream_event' && (message.event as unknown as Json).type === 'message_start') {
    events.write({ ts: stamp(), sdkLine: line, messageStart: ((message.event as unknown as Json).message as Json).id });
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

function baseOptions(model: string, store: SessionStore, bodiesDir: string, approvals: Recorder, extra: Partial<HarnessOptions>): HarnessOptions {
  return {
    model,
    tools: ['Bash'],
    allowedTools: ['Bash'],
    canUseTool: approveAll(approvals),
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    sessionStore: store,
    sessionStoreFlush: 'eager',
    ...extra,
    env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodiesDir}` },
  };
}

function copyBodies(from: string, runDir: string): void {
  const to = join(runDir, 'api-bodies');
  mkdirSync(to, { recursive: true });
  for (const entry of existsSync(from) ? readdirSync(from) : []) {
    if (entry === 'latest') {
      continue;
    }
    writeFileSync(join(to, entry), redact(readFileSync(join(from, entry), 'utf8')).text);
  }
}

function makeLog(rec: Recorder): (s: string) => void {
  return (s: string): void => {
    const line = `${stamp()} ${s}`;
    process.stdout.write(`${line}\n`);
    rec.write(line);
  };
}

export interface SeedRecord {
  scenario: string;
  sessionId: string;
  convA: string;
  convB: string;
  model: string;
  seedRun: string;
  upto: number;
}

// ---------------------------------------------------------------------------

export async function seed(model: string, scenarioName: string): Promise<void> {
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`no scenario ${scenarioName}`);
  }
  writeFiles(scenario);
  STAMP_HUMAN = scenario.stampHuman === true;
  const tower = await openTower();
  const convB = randomUUID();
  // A's conversation id is the session id, known at the first append.
  const pubA = new Publisher(tower, 'pending', 'A');
  const pubB = new Publisher(tower, convB, 'B');
  const store = new SeedStore([pubA, pubB], (sessionId) => {
    pubA.convId = sessionId;
  });
  const bodies = bodiesDirFor(`seed-${scenarioName}`);
  const signals = new Recorder('signals.jsonl');
  const settings = settingsForModel(model);
  // A: a request file appeared.
  const wire = new WireWatch(bodies, model, (file, body, seenAt, seenMs) => {
    void pubA.serial(async () => {
      const pending = pubA.pendingEntries();
      const a = attribute(body as { messages: ApiMessage[] }, pending);
      const turnId = randomUUID();
      pubA.requestTurns.push(turnId);
      const fileMs = Number(body.fileMtimeMs);
      // Entries appended well before the request that it didn't carry stop
      // blocking; later requests can't claim them (recorded).
      const release = a.unplaced.filter((e) => (pubA.findAppended(String(e.uuid))?.ms ?? Infinity) < fileMs - SETTLE_MS);
      signals.write({ at: stamp(), approach: 'A', signal: 'request-file', file, seenAt, fileMtime: new Date(fileMs).toISOString(), pending: pending.map(brief), placed: a.messages.map((m) => ({ role: m.role, entries: m.ccEntries.map((c) => c.uuid) })), uncovered: a.uncovered, unplaced: a.unplaced.map(brief), notes: a.notes });
      // resolve() queues behind this task on the same chain.
      void pubA.resolve(a.messages, turnId, 'request-file', seenAt, seenMs, release, { reason: 'not in the request that followed it' });
    });
  });
  // B: the response to a request has started (the SDK's stream, not the body).
  const onStreamEvent = (event: Json, at: string, ms: number): void => {
    void pubA.streamEvent(event);
    void pubB.streamEvent(event);
    if (event.type !== 'message_start') {
      return;
    }
    const msgId = String((event.message as Json).id);
    void pubB.serial(async () => {
      const pending = pubB.pendingEntries();
      const p = predict(pending, settings);
      const turnId = randomUUID();
      pubB.turnByMsgId.set(msgId, turnId);
      signals.write({ at: stamp(), approach: 'B', signal: 'message_start', msgId, streamAt: at, pending: pending.map(brief), placed: p.messages.map((m) => ({ role: m.role, entries: m.ccEntries.map((c) => c.uuid) })), rules: p.rules, predicted: p.messages });
      void pubB.resolve(p.messages, turnId, 'message_start', at, ms);
    });
  };
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  const run = startRun({ name: scenario.seedName, options: baseOptions(model, store, bodies, approvals, scenario.options(model)) });
  for (const r of [store.rec, pubA.rec, pubA.timing, pubB.rec, pubB.timing, signals, logRec, approvals]) {
    r.attach(run.dir);
  }
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}; seed ${scenarioName}; B's conversation ${convB}; fold settings ${JSON.stringify(settings)}`);
  wire.start();
  await drive(run, scenario.steps, log, {
    onStreamEvent,
    onResult: async () => {
      await Promise.all([pubA.closeQuery('completed'), pubB.closeQuery('completed')]);
    },
  });
  try {
    await run.done;
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  await wire.stop();
  await new Promise((r) => setTimeout(r, SETTLE_MS * 2));
  await Promise.all([pubA.chain, pubB.chain]);
  await Promise.all([pubA.finish(), pubB.finish()]);
  const upto = await lastSeq(tower);
  const sessionId = store.sessionId;
  if (!sessionId) {
    throw new Error('seed: nothing was appended');
  }
  const rec: SeedRecord = { scenario: scenarioName, sessionId, convA: pubA.convId, convB, model, seedRun: run.dir, upto };
  mkdirSync(SEEDS, { recursive: true });
  writeFileSync(join(SEEDS, `${sessionId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  writeFileSync(join(run.dir, 'seed.json'), `${JSON.stringify(rec, null, 2)}\n`);
  copyBodies(bodies, run.dir);
  log(`conversation ${sessionId}; A published ${pubA.published} on ${pubA.convId}, B ${pubB.published} on ${convB}; last seq ${upto}`);
  await tower.nc.drain();
}

// ---------------------------------------------------------------------------

export const SOURCES = ['full', 'full-fold-true', 'full-no-snapshot', 'A', 'B', 'A-silent', 'B-silent'] as const;
export type Source = (typeof SOURCES)[number];

function seedEntries(seedRun: string): Json[] {
  return readJsonl(join(seedRun, 'store-appends.jsonl'))
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
  writeFiles(scenario);
  STAMP_HUMAN = scenario.stampHuman === true;
  const cwd = work(scenario.resumeName);
  let tower: Tower | undefined;
  let load: ResumeStore['source'];
  if (source.startsWith('full')) {
    let entries = seedEntries(seedRec.seedRun);
    if (source === 'full-fold-true') {
      // Claude Code reads reminderFold back from the last prompt_snapshot.
      entries = entries.map((e) => ((e.attachment as Json | undefined)?.type === 'prompt_snapshot' ? { ...e, attachment: { ...(e.attachment as Json), reminderFold: true } } : e));
    } else if (source === 'full-no-snapshot') {
      entries = entries.filter((e) => (e.attachment as Json | undefined)?.type !== 'prompt_snapshot');
    }
    load = async (key) => ({ entries: key.subpath ? null : entries, detail: { source, entries: entries.length } });
  } else {
    const t = await openTower();
    tower = t;
    const convId = source.startsWith('A') ? seedRec.convA : seedRec.convB;
    const withSilent = source.endsWith('-silent');
    load = async (key) => {
      if (key.subpath) {
        return { entries: null, detail: { source, note: 'subagent transcript: nothing on tower for it' } };
      }
      const messages = await towerMessages(t, convId, seedRec.upto);
      if (messages.length === 0) {
        return { entries: null, detail: { source, convId, messages: 0 } };
      }
      const entries = rebuild(messages, await modelsByTurn(t, convId, seedRec.upto), cwd, key.sessionId, withSilent);
      return { entries, detail: { source, convId, withSilent, upto: seedRec.upto, messages: messages.length } };
    };
  }
  const firstDelayMs = Number(process.env.PROOF16_FIRST_DELAY_MS ?? 0);
  const store = new ResumeStore(load);
  const bodies = bodiesDirFor(`resume-${seedRec.scenario}-${source}`);
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  const run = startRun({ name: scenario.resumeName, options: { ...baseOptions(model, store, bodies, approvals, scenario.options(model)), resume: sessionId } });
  for (const r of [store.rec, store.loadRec, store.loadedRec, logRec, approvals]) {
    r.attach(run.dir);
  }
  const log = makeLog(logRec);
  writeFileSync(join(run.dir, 'resume.json'), `${JSON.stringify({ source, firstDelayMs, cwd: run.cwd, sessionId, seedRun: seedRec.seedRun, upto: seedRec.upto }, null, 2)}\n`);
  log(`run dir: ${run.dir}; resume ${source}; cwd ${run.cwd}; session ${sessionId}`);
  await drive(run, RESUME_STEPS, log, {}, firstDelayMs);
  try {
    await run.done;
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  copyBodies(bodies, run.dir);
  log('done');
  await tower?.nc.drain();
}

// ---------------------------------------------------------------------------
// Republish a recorded seed offline: the same forms each approach builds
// (A from the logged bodies, B from the entries), onto fresh tower
// conversations, so a load() variant can be tried on a seed that was
// published before it existed. No timing: the run is over.

export async function republish(seedRun: string): Promise<void> {
  const seedRecPath = join(seedRun, 'seed.json');
  const old = JSON.parse(readFileSync(seedRecPath, 'utf8')) as SeedRecord;
  const entries = seedEntries(seedRun);
  const requests = mainRequests(seedRun);
  const tower = await openTower();
  const out: Json = {};
  for (const label of ['A', 'B'] as const) {
    const convId = randomUUID();
    const pub = new Publisher(tower, convId, `${label}-republished`);
    pub.rec.attach(seedRun);
    const settings = settingsForModel(old.model);
    let carry: Json[] = [];
    for (const g of groups(entries, requests)) {
      const turnId = randomUUID();
      const forms = label === 'A' ? attribute(g.request.body, [...carry, ...g.pending.filter((e) => !carry.includes(e))]) : undefined;
      carry = forms?.unplaced ?? [];
      const messages = forms ? forms.messages : predict(g.pending, settings).messages;
      const silent = g.pending.filter((e) => e.type === 'attachment' && !isCarrier(e));
      if (messages[0] && silent.length > 0) {
        const order = new Map(entries.map((e, i) => [String(e.uuid), i]));
        const at = (u: string): number => order.get(u) ?? Number.MAX_SAFE_INTEGER;
        messages[0].ccEntries = [...messages[0].ccEntries, ...silent.map((e) => ({ uuid: String(e.uuid), type: 'attachment' as const, attachment: e.attachment as Json, spans: [] }))].sort((x, y) => at(x.uuid) - at(y.uuid));
      }
      const byUuid = new Map(g.pending.map((e) => [String(e.uuid), e]));
      let queryId = pub.queryId;
      for (const m of messages) {
        const prompt = m.ccEntries.find((c) => c.type === 'user' && !c.isMeta && !isToolResults((byUuid.get(c.uuid)?.message as Json | undefined)?.content));
        if (prompt) {
          queryId = randomUUID();
          pub.queryId = queryId;
        }
        await pub.publish('changes.message', { ts: tsNow(), instanceId: pub.instanceId, id: messageId(m), queryId, turnId, role: m.role, ...(prompt ? { from: { kind: 'human' } } : {}), content: m.content, ccEntries: m.ccEntries });
      }
      for (const e of entries.filter((x) => x.type === 'assistant' && (x.message as Json).id === g.request.messageId)) {
        await pub.publish('changes.message', { ts: tsNow(), instanceId: pub.instanceId, id: String(e.uuid), queryId, turnId, role: 'assistant', from: { kind: 'agent' }, content: (e.message as Json).content });
      }
      const u = (g.request.response?.usage as Json | undefined) ?? {};
      const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
      await pub.publish('telemetry.usage', { ts: tsNow(), queryId, turnId, service: 'anthropic.messages', model: g.request.model, inputTokens: num(u.input_tokens), cacheCreationTokens: num(u.cache_creation_input_tokens), cacheReadTokens: num(u.cache_read_input_tokens), outputTokens: num(u.output_tokens) });
    }
    out[label === 'A' ? 'convA' : 'convB'] = convId;
  }
  const upto = await lastSeq(tower);
  const rec: SeedRecord = { ...old, convA: String(out.convA), convB: String(out.convB), upto };
  writeFileSync(join(SEEDS, `${old.sessionId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  writeFileSync(join(seedRun, 'seed-republished.json'), `${JSON.stringify({ ...rec, was: old }, null, 2)}\n`);
  process.stdout.write(`republished ${old.sessionId}: A on ${String(out.convA)}, B on ${String(out.convB)}; last seq ${upto}\n`);
  await tower.nc.drain();
}
