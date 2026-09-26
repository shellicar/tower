// Proof 13: resuming after a working-directory change (Stephen, 26 Sep: "we
// need a proof for this specifically / test if resume resumes with the cwd
// changed when using set_cwd / with restoring from nats, my question should
// be, should cwd changes be persisted or not? they arent technically part of
// the conversation, but the tool use only makes sense with it, ie relative
// paths").
//
// A seed conversation runs Bash with relative paths in folder A, is moved to
// folder B with the binary's set_cwd (proof 4), and runs Bash with relative
// paths again. It is then resumed through a sessionStore, from a file (proof
// 8's layout) and from tower's conv.v2 subjects alone (proof 9's publisher
// and NATS-only load), with the SDK's cwd set to A and to B.
//
// The folders are the harness's own per-proof working directories: the
// harness sets cwd from the run's name, so a run named resume-cwd-a runs in
// A and one named resume-cwd-b runs in B. The harness itself is unchanged.
//
//   A = ~/.local/state/tower-claude-code-harness/work/resume-cwd-a
//   B = ~/.local/state/tower-claude-code-harness/work/resume-cwd-b
//
// Both hold note.txt with different contents, and one file only that folder
// has, rewritten before every run and kept on disk: what a relative path
// prints shows which folder it resolved against.
//
// Modes (from mvp/claude-code-harness/):
//
//   seed <model>
//       In A: one Bash command with relative paths. set_cwd to B (idle,
//       needs_trust then trust_accepted). In B: the same with B's file. The
//       store is a tee: proof 8's FileStore (every entry, under
//       <projectKey>/<sessionId>.jsonl) and proof 9's publisher (api grain)
//       onto tower. Every append's SessionKey is recorded.
//
//   control <model>
//       The seed's steps, then the resume questions asked live in the same
//       process: what a model that never resumed says and does.
//
//   resume <model> <file|tower|whole|tower-env|tower-cwd> <a|b> <sessionId>
//       Resumes the seed in A or B. Appends are recorded, never stored or
//       published, so every resume starts from the seed. Asks RESUME_STEPS.
//         file       a fresh copy of the seed's file store, loaded by the
//                    key the SDK asks for
//         tower      proof 9's NATS-only load, build `derived`, reading tower
//                    up to the stream sequence the seed ended on
//         whole      every entry the seed's store was given, from every
//                    projectKey, in append order (what a store keyed by
//                    session id alone would hold)
//         tower-env  tower, plus the seed's attachment/environment entries
//                    put back where they were (what tower does not carry)
//         tower-cwd  tower-env with those entries cut to the working
//                    directory alone
//
//   --summarise <run dir>
//   --cache <resume run dir> <seed run dir>
//       What the resume's requests read from and wrote to the prompt cache,
//       and where its first request first differs from the seed's context.
//
// TODO: undecided. The store layouts (file keyed by projectKey/sessionId;
// tower subjects keyed by session id), the api grain, the derived build and
// every mapping choice inside the publisher are proof 8's and proof 9's
// easiest-thing-that-runs, copied here, none of them the participant's design.

import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { CanUseTool, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { type JetStreamClient, type JetStreamManager, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

type Json = Record<string, unknown>;
type Block = Json & { type: string };

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'proof-13');
const SEEDS = join(STATE, 'seeds');
const SEED_FILE_STORES = join(STATE, 'seed-file-stores');
const RESUME_FILE_STORES = join(STATE, 'resume-file-stores');
const BODIES_ROOT = join(STATE, 'api-bodies');

// Names the harness turns into working directories (harness.mts, WORK_ROOT).
const NAME_A = 'resume-cwd-a';
const NAME_B = 'resume-cwd-b';
const DIR_A = join(HARNESS_STATE, 'work', NAME_A);
const DIR_B = join(HARNESS_STATE, 'work', NAME_B);

const FILES: Record<string, Record<string, string>> = {
  [DIR_A]: { 'note.txt': 'AMBER 1111', 'only-a.txt': 'ASPEN 3333' },
  [DIR_B]: { 'note.txt': 'BIRCH 2222', 'only-b.txt': 'BASALT 4444' },
};

// Tower's test broker, never 4222.
const NATS_URL = '127.0.0.1:31416';
const AUDIT_STREAM = 'conv-approval';
const SERVICE = 'anthropic.messages';

const QUIET_MS = 3000;

type Step = { prompt: string } | { setCwd: string };

const SEED_STEPS: Step[] = [
  { prompt: 'Run this exact Bash command, once: `pwd; cat note.txt; cat only-a.txt`. Reply with its output only.' },
  { setCwd: DIR_B },
  { prompt: 'Run this exact Bash command, once: `pwd; cat note.txt; cat only-b.txt`. Reply with its output only.' },
];

const RESUME_STEPS: Step[] = [
  {
    prompt:
      'Answer from memory, without using any tools. Line 1: your current working directory. Then one line for each Bash command you ran earlier in this conversation: the directory it ran in, and what `cat note.txt` printed.',
  },
  { prompt: 'Using Bash, show me the current contents of the note.txt file that your very first command in this conversation read. Reply with the exact command you ran and its output.' },
  { prompt: 'Using Bash, show me the current contents of the note.txt file that your second command in this conversation read. Reply with the exact command you ran and its output.' },
  { prompt: 'Run `pwd` with Bash and reply with its output only.' },
];

// ---------------------------------------------------------------------------
// Recording

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

function readJsonl(path: string): Json[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

function brief(e: Json): Json {
  const msg = e.message as Json | undefined;
  const content = msg?.content;
  const blocks = typeof content === 'string' ? ['string'] : Array.isArray(content) ? content.map((b: Json) => String(b.type)) : undefined;
  return {
    type: e.type,
    sub: (e.attachment as Json | undefined)?.type ?? e.subtype ?? e.operation,
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    cwd: e.cwd,
    isMeta: e.isMeta,
    msgId: msg?.id,
    blocks,
  };
}

function writeFiles(): void {
  for (const [dir, files] of Object.entries(FILES)) {
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), `${text}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Proof 8's file store (branch proof-8-resume-store,
// mvp/claude-code-harness/proofs/resume-store.mts:157-177), unchanged in
// layout: <root>/<projectKey>/<sessionId>.jsonl.

function fileFor(root: string, key: SessionKey): string {
  const dir = join(root, key.projectKey);
  return key.subpath ? join(dir, key.sessionId, `${key.subpath}.jsonl`) : join(dir, `${key.sessionId}.jsonl`);
}

class FileStore implements SessionStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const path = fileFor(this.root, key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const path = fileFor(this.root, key);
    return existsSync(path) ? (readJsonl(path) as SessionStoreEntry[]) : null;
  }
}

// ---------------------------------------------------------------------------
// Proof 9's tower publishing and loading (branch proof-9-resume-spec,
// mvp/claude-code-harness/proofs/resume-spec.mts:182-310, 349-617, 619-713,
// 793-861), cut to the api grain and the NATS-only load: no hybrid file.

function tsNow(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const local = new Date(d.getTime() + off * 60_000).toISOString().replace('Z', '');
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
type FieldKind = 'string' | 'string?' | 'int' | 'int?' | 'ts' | 'sender?' | 'blocks' | 'record?';

function checkFields(body: Json, fields: Record<string, FieldKind>): string[] {
  const errors: string[] = [];
  for (const [name, kind] of Object.entries(fields)) {
    const v = body[name];
    const optional = kind.endsWith('?');
    if (v === undefined) {
      if (!optional) {
        errors.push(`${name}: missing`);
      }
      continue;
    }
    const base = kind.replace('?', '');
    const ok =
      base === 'string'
        ? typeof v === 'string'
        : base === 'int'
          ? Number.isInteger(v)
          : base === 'ts'
            ? typeof v === 'string' && TS.test(v)
            : base === 'sender'
              ? typeof v === 'object' && v !== null && typeof (v as Json).kind === 'string'
              : base === 'blocks'
                ? Array.isArray(v) && v.every((b) => typeof b === 'object' && b !== null && typeof (b as Json).type === 'string')
                : base === 'record'
                  ? typeof v === 'object' && v !== null && !Array.isArray(v)
                  : false;
    if (!ok) {
      errors.push(`${name}: not a valid ${base}`);
    }
  }
  return errors;
}

const SCHEMAS: Record<string, Record<string, FieldKind>> = {
  'changes.message': { ts: 'ts', instanceId: 'string?', id: 'string', queryId: 'string', turnId: 'string', role: 'string', from: 'sender?', content: 'blocks' },
  'changes.query': { ts: 'ts', instanceId: 'string?', queryId: 'string', reason: 'string' },
  'telemetry.usage': {
    ts: 'ts',
    queryId: 'string',
    turnId: 'string',
    service: 'string',
    model: 'string',
    inputTokens: 'int',
    cacheCreationTokens: 'int',
    cacheReadTokens: 'int',
    outputTokens: 'int',
    cacheCreation5mTokens: 'int?',
    cacheCreation1hTokens: 'int?',
    thinkingTokens: 'int?',
    serverToolUse: 'record?',
  },
};

interface Tower {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

async function openTower(): Promise<Tower> {
  const nc = await connect({ servers: NATS_URL, name: 'proof-13-resume-cwd' });
  const jsm = await jetstreamManager(nc);
  for (const probe of ['conv.v2.probe.changes.message', 'conv.v2.probe.changes.query', 'conv.v2.probe.telemetry.usage']) {
    const found = await jsm.streams.find(probe);
    if (found !== AUDIT_STREAM) {
      throw new Error(`${probe} is captured by ${found}, not ${AUDIT_STREAM}: the broker's streams are not what mvp/stream-init.sh sets up`);
    }
  }
  return { nc, js: jetstream(nc), jsm };
}

async function lastSeq(tower: Tower): Promise<number> {
  return (await tower.jsm.streams.info(AUDIT_STREAM)).state.last_seq;
}

interface Stored {
  seq: number;
  subject: string;
  body: Json;
}

async function readStream(tower: Tower, filter: string, upto?: number): Promise<Stored[]> {
  const info = await tower.jsm.streams.info(AUDIT_STREAM, { subjects_filter: filter });
  const count = Object.values(info.state.subjects ?? {}).reduce((a, n) => a + n, 0);
  if (count === 0) {
    return [];
  }
  const consumer = await tower.js.consumers.get(AUDIT_STREAM, { filter_subjects: filter });
  const out: Stored[] = [];
  const messages = await consumer.consume();
  for await (const m of messages) {
    if (upto !== undefined && m.seq > upto) {
      break;
    }
    out.push({ seq: m.seq, subject: m.subject, body: m.json() as Json });
    if (m.info.pending === 0) {
      break;
    }
  }
  await messages.close();
  return out;
}

function modelSide(e: Json): boolean {
  return e.type === 'user' || e.type === 'assistant';
}

function toBlocks(content: unknown): Block[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return (content as Block[]).map((b) => ({ ...b }));
}

function isToolResults(blocks: Block[]): boolean {
  return blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
}

interface OpenMessage {
  id: string;
  role: string;
  queryId: string;
  turnId: string;
  msgId: string | undefined;
  content: Block[];
}

class Publisher {
  readonly tower: Tower;
  readonly instanceId = randomUUID();
  readonly rec = new Recorder('published.jsonl');
  sessionId: string | undefined;
  queryId: string | undefined;
  currentTurn: string | undefined;
  prompt: OpenMessage | undefined;
  assistant: OpenMessage | undefined;
  results: OpenMessage | undefined;
  readonly turnByMsgId = new Map<string, { queryId: string; turnId: string }>();
  readonly nextTurnByMsgId = new Map<string, string>();
  readonly msgIdByToolUse = new Map<string, string>();
  readonly pendingUsage = new Map<string, Json[]>();
  lastMsgId: string | undefined;
  lastModel: string | undefined;
  published = 0;
  // Entries not published (not user/assistant), recorded so the summary can
  // say what a tower-only resume never had.
  readonly notPublished = new Recorder('not-published.jsonl');
  chain: Promise<void> = Promise.resolve();

  constructor(tower: Tower) {
    this.tower = tower;
  }

  serial(fn: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(fn, fn);
    return this.chain;
  }

  async publish(leaf: string, body: Json): Promise<void> {
    const errors = checkFields(body, SCHEMAS[leaf] ?? {});
    const subject = `conv.v2.${this.sessionId}.${leaf}`;
    if (errors.length > 0) {
      this.rec.write({ at: stamp(), subject, INVALID: errors, body });
      throw new Error(`${subject} fails the spec schema: ${errors.join('; ')}`);
    }
    const ack = await this.tower.js.publish(subject, JSON.stringify(body));
    this.published += 1;
    this.rec.write({ at: stamp(), seq: ack.seq, subject, body });
  }

  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    return this.serial(async () => {
      if (key.subpath) {
        this.rec.write({ at: stamp(), skipped: 'subagent transcript', key, count: entries.length });
        return;
      }
      this.sessionId ??= key.sessionId;
      for (const e of entries as Json[]) {
        if (modelSide(e)) {
          await this.message(e);
        } else {
          this.notPublished.write({ at: stamp(), key, entry: brief(e) });
        }
      }
    });
  }

  place(role: string, content: Block[], msgId: string | undefined): { queryId: string; turnId: string } {
    if (role === 'user' && !isToolResults(content)) {
      this.queryId = randomUUID();
      this.currentTurn = randomUUID();
    } else if (role === 'user') {
      const answered = this.msgIdByToolUse.get(String(content[0]?.tool_use_id));
      const next = answered ? (this.nextTurnByMsgId.get(answered) ?? randomUUID()) : randomUUID();
      if (answered) {
        this.nextTurnByMsgId.set(answered, next);
      }
      this.currentTurn = next;
    }
    this.queryId ??= randomUUID();
    this.currentTurn ??= randomUUID();
    if (role === 'assistant' && msgId) {
      const known = this.turnByMsgId.get(msgId);
      if (known) {
        return known;
      }
      const placed = { queryId: this.queryId, turnId: this.currentTurn };
      this.turnByMsgId.set(msgId, placed);
      for (const b of content) {
        if (b.type === 'tool_use') {
          this.msgIdByToolUse.set(String(b.id), msgId);
        }
      }
      return placed;
    }
    return { queryId: this.queryId, turnId: this.currentTurn };
  }

  async message(e: Json): Promise<void> {
    const msg = e.message as Json;
    const role = String(msg.role);
    const content = toBlocks(msg.content);
    const msgId = typeof msg.id === 'string' ? msg.id : undefined;
    const { queryId, turnId } = this.place(role, content, msgId);
    if (role === 'assistant' && msgId) {
      for (const b of content) {
        if (b.type === 'tool_use') {
          this.msgIdByToolUse.set(String(b.id), msgId);
        }
      }
    }
    const uuid = String(e.uuid);
    if (role === 'assistant') {
      if (this.assistant && this.assistant.msgId === msgId) {
        this.assistant.content.push(...content);
      } else {
        await this.flush();
        this.assistant = { id: uuid, role, queryId, turnId, msgId, content };
      }
    } else if (isToolResults(content)) {
      if (this.results) {
        this.results.content.push(...content);
      } else {
        this.results = { id: uuid, role, queryId, turnId, msgId, content };
      }
    } else {
      await this.flush();
      this.prompt = { id: uuid, role, queryId, turnId, msgId, content };
    }
    if (role === 'assistant' && msgId) {
      await this.drainUsage(msgId);
    }
  }

  async publishMessage(m: OpenMessage): Promise<void> {
    const body: Json = { ts: tsNow(), instanceId: this.instanceId, id: m.id, queryId: m.queryId, turnId: m.turnId, role: m.role };
    if (m.role === 'assistant') {
      body.from = { kind: 'agent' };
    } else if (!isToolResults(m.content)) {
      body.from = { kind: 'human' };
    }
    body.content = m.content;
    await this.publish('changes.message', body);
  }

  async flush(): Promise<void> {
    const open = [this.prompt, this.assistant, this.results];
    this.prompt = undefined;
    this.assistant = undefined;
    this.results = undefined;
    for (const m of open) {
      if (m) {
        await this.publishMessage(m);
      }
    }
  }

  closeQuery(reason: string): Promise<void> {
    return this.serial(async () => {
      await this.flush();
      if (this.queryId) {
        await this.publish('changes.query', { ts: tsNow(), instanceId: this.instanceId, queryId: this.queryId, reason });
      }
    });
  }

  streamEvent(event: Json): Promise<void> {
    return this.serial(async () => {
      if (event.type === 'message_start') {
        const m = event.message as Json;
        this.lastMsgId = String(m.id);
        this.lastModel = String(m.model);
        this.queueUsage(this.lastMsgId, this.lastModel, m.usage as Json);
      } else if (event.type === 'message_delta' && this.lastMsgId && this.lastModel) {
        this.queueUsage(this.lastMsgId, this.lastModel, event.usage as Json);
      } else {
        return;
      }
      if (this.lastMsgId && this.turnByMsgId.has(this.lastMsgId)) {
        await this.drainUsage(this.lastMsgId);
      }
    });
  }

  queueUsage(msgId: string, model: string, usage: Json | undefined): void {
    if (!usage) {
      return;
    }
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const body: Json = {
      service: SERVICE,
      model,
      inputTokens: num(usage.input_tokens),
      cacheCreationTokens: num(usage.cache_creation_input_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      outputTokens: num(usage.output_tokens),
    };
    this.pendingUsage.set(msgId, [...(this.pendingUsage.get(msgId) ?? []), body]);
  }

  async drainUsage(msgId: string): Promise<void> {
    const turn = this.turnByMsgId.get(msgId);
    const frames = this.pendingUsage.get(msgId) ?? [];
    if (!turn || frames.length === 0) {
      return;
    }
    this.pendingUsage.delete(msgId);
    for (const f of frames) {
      await this.publish('telemetry.usage', { ts: tsNow(), queryId: turn.queryId, turnId: turn.turnId, ...f });
    }
  }
}

async function foldMessages(tower: Tower, sessionId: string, upto?: number): Promise<{ messages: Json[]; lastSeq: number }> {
  const stored = await readStream(tower, `conv.v2.${sessionId}.changes.>`, upto);
  const byId = new Map<string, Json>();
  const order: string[] = [];
  const prefix = `conv.v2.${sessionId}.changes.`;
  for (const s of stored) {
    if (s.subject.slice(prefix.length) === 'message') {
      const id = String(s.body.id);
      if (!byId.has(id)) {
        order.push(id);
      }
      byId.set(id, s.body);
    }
  }
  return { messages: order.map((id) => byId.get(id) as Json), lastSeq: stored.at(-1)?.seq ?? 0 };
}

async function usageModels(tower: Tower, sessionId: string, upto?: number): Promise<Map<string, string>> {
  const stored = await readStream(tower, `conv.v2.${sessionId}.telemetry.usage`, upto);
  const byTurn = new Map<string, string>();
  for (const s of stored) {
    if (!byTurn.has(String(s.body.turnId))) {
      byTurn.set(String(s.body.turnId), String(s.body.model));
    }
  }
  return byTurn;
}

// Proof 9's build `derived`: the spec fields, plus message.model from
// telemetry.usage by turnId, plus message.id from turnId.
function buildDerived(messages: Json[], usage: Map<string, string>): Json[] {
  let prev: string | null = null;
  return messages.map((m) => {
    const message: Json = { role: m.role, content: m.content };
    if (m.role === 'assistant') {
      const model = usage.get(String(m.turnId));
      if (model) {
        message.model = model;
      }
      message.id = m.turnId;
    }
    const entry: Json = { type: m.role, uuid: m.id, parentUuid: prev, timestamp: m.ts, message };
    prev = String(m.id);
    return entry;
  });
}

// ---------------------------------------------------------------------------
// The stores each mode runs with.

class SeedStore implements SessionStore {
  readonly file: FileStore;
  readonly publisher: Publisher;
  readonly rec = new Recorder('store-appends.jsonl');
  constructor(file: FileStore, publisher: Publisher) {
    this.file = file;
    this.publisher = publisher;
  }
  toJSON(): Json {
    return { store: 'seed tee', file: this.file.root, publisher: { grain: 'api', instanceId: this.publisher.instanceId } };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.rec.write({ ts: stamp(), key, count: entries.length, entries });
    await this.file.append(key, entries);
    await this.publisher.append(key, entries);
  }
  async load(): Promise<SessionStoreEntry[] | null> {
    return null;
  }
}

// A resumed run's store: load() from the chosen source; append() recorded
// only, so the seed's record is never changed.
class ResumeStore implements SessionStore {
  readonly source: (key: SessionKey) => Promise<{ entries: SessionStoreEntry[] | null; detail: Json }>;
  readonly rec = new Recorder('store-appends.jsonl');
  readonly loadRec = new Recorder('store-load.jsonl');
  readonly loadedRec = new Recorder('loaded-entries.jsonl');
  constructor(source: (key: SessionKey) => Promise<{ entries: SessionStoreEntry[] | null; detail: Json }>) {
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
    this.loadRec.write({ ts: stamp(), key, returned: entries === null ? null : entries.length, ...detail, entries: entries?.map((e) => brief(e as Json)) });
    for (const e of entries ?? []) {
      this.loadedRec.write(e);
    }
    return entries;
  }
}

// ---------------------------------------------------------------------------
// Driving

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function makeLog(rec: Recorder): (s: string) => void {
  return (s: string): void => {
    const line = `${stamp()} ${s}`;
    process.stdout.write(`${line}\n`);
    rec.write(line);
  };
}

// set_cwd is not on the SDK's public surface; the binary handles it
// (2.1.282) and the Query's private request() sends any control request
// (proof 4, live.mts:411-423).
async function setCwd(run: Run, path: string): Promise<Json> {
  const request = (run.query as unknown as { request: (r: Json) => Promise<unknown> }).request.bind(run.query);
  const first = (await request({ subtype: 'set_cwd', path })) as { response?: { status?: string; directory?: string } };
  if (first?.response?.status === 'needs_trust') {
    const second = await request({ subtype: 'set_cwd', path, trust_accepted: true, trusted_directory: first.response.directory });
    return { first, second };
  }
  return { first };
}

// Each step runs once the previous prompt has a result and the stream has
// been quiet for QUIET_MS; a set_cwd step runs then too (idle), and the next
// step follows straight after it.
async function drive(run: Run, steps: Step[], log: (s: string) => void, publisher: Publisher | undefined): Promise<void> {
  let index = 0;
  let resultSeen = false;
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
        try {
          const result = await setCwd(run, step.setCwd);
          events.write({ ts: stamp(), step: index + 1, setCwd: step.setCwd, result });
          log(`set_cwd result: ${JSON.stringify(result)}`);
        } catch (err) {
          events.write({ ts: stamp(), step: index + 1, setCwd: step.setCwd, error: err instanceof Error ? err.message : String(err) });
          log(`set_cwd error: ${err instanceof Error ? err.message : String(err)}`);
        }
        index += 1;
        continue;
      }
      log(`step ${index + 1}: send ${JSON.stringify(step.prompt)}`);
      events.write({ ts: stamp(), step: index + 1, send: step.prompt });
      run.send(user(step.prompt));
      return;
    }
  };
  const advance = async (): Promise<void> => {
    quiet = undefined;
    resultSeen = false;
    if (publisher) {
      await publisher.closeQuery('completed');
    }
    index += 1;
    await runStep();
  };
  await runStep();
  for await (const message of run.messages()) {
    line += 1;
    if (quiet) {
      clearTimeout(quiet);
      quiet = undefined;
    }
    record(message, line, events);
    if (message.type === 'stream_event' && publisher) {
      void publisher.streamEvent(message.event as unknown as Json);
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
  } else if (message.type === 'user' && Array.isArray(message.message.content)) {
    for (const b of message.message.content as unknown as Block[]) {
      if (b.type === 'tool_result') {
        events.write({ ts: stamp(), sdkLine: line, toolResult: b.content });
      }
    }
  }
}

// Every tool is allowed and recorded: the proof is about where commands run,
// not whether they're approved.
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

function baseOptions(model: string, store: SessionStore, bodiesDir: string, approvals: Recorder): HarnessOptions {
  return {
    model,
    tools: ['Bash'],
    allowedTools: ['Bash'],
    canUseTool: approveAll(approvals),
    thinking: { type: 'adaptive', display: 'summarized' },
    includePartialMessages: true,
    sessionStore: store,
    sessionStoreFlush: 'eager',
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

async function finish(run: Run, bodiesDir: string, log: (s: string) => void): Promise<void> {
  try {
    await run.done;
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  copyBodies(bodiesDir, run.dir);
  log('done');
  const text = summarise(run.dir);
  writeFileSync(join(run.dir, 'summary.txt'), text);
  process.stdout.write(`\n${text}`);
}

interface SeedRecord {
  sessionId: string;
  model: string;
  seedRun: string;
  fileStore: string;
  upto: number;
}

// ---------------------------------------------------------------------------
// Modes

async function seed(model: string, control: boolean): Promise<void> {
  writeFiles();
  const tower = await openTower();
  const publisher = new Publisher(tower);
  const tag = control ? 'control' : 'seed';
  const fileRoot = join(SEED_FILE_STORES, `${stamp().replace(/[:.]/g, '')}-${tag}`);
  const store = new SeedStore(new FileStore(fileRoot), publisher);
  const bodies = bodiesDirFor(tag);
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  const run = startRun({ name: NAME_A, options: baseOptions(model, store, bodies, approvals) });
  for (const r of [store.rec, publisher.rec, publisher.notPublished, logRec, approvals]) {
    r.attach(run.dir);
  }
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}; ${tag}; A=${DIR_A} B=${DIR_B}; file store ${fileRoot}`);
  await drive(run, control ? [...SEED_STEPS, ...RESUME_STEPS] : SEED_STEPS, log, publisher);
  await publisher.chain;
  const upto = await lastSeq(tower);
  const sessionId = publisher.sessionId;
  if (!sessionId) {
    throw new Error('seed: nothing was appended');
  }
  const rec: SeedRecord = { sessionId, model, seedRun: run.dir, fileStore: fileRoot, upto };
  if (!control) {
    mkdirSync(SEEDS, { recursive: true });
    writeFileSync(join(SEEDS, `${sessionId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  }
  writeFileSync(join(run.dir, 'seed.json'), `${JSON.stringify(rec, null, 2)}\n`);
  log(`conversation ${sessionId}; ${publisher.published} messages published; ${AUDIT_STREAM} last seq ${upto}`);
  await finish(run, bodies, log);
  await tower.nc.drain();
}

type Source = 'file' | 'tower' | 'whole' | 'tower-env' | 'tower-cwd';
const SOURCES: Source[] = ['file', 'tower', 'whole', 'tower-env', 'tower-cwd'];

// Every main-transcript entry the seed's store was given, in append order,
// whatever projectKey it came under.
function seedEntries(seedRun: string): Json[] {
  return readJsonl(join(seedRun, 'store-appends.jsonl'))
    .filter((a) => !(a.key as SessionKey).subpath)
    .flatMap((a) => a.entries as Json[]);
}

// tower-env: the tower rebuild with the seed's attachment/environment entries
// put back after the tower message they followed, and the chain relinked.
// TODO: undecided. This asks what tower would have to carry for the model to
// be told its directory on resume; it is not a proposal for how. The
// environment entries come from the seed's own record, not from tower.
// tower-cwd: as tower-env, but each environment entry keeps only the working
// directory (the one value attachment.attached/moved carry): its snapshot
// reduced to workingDirectory, its changes to workingDirectory changes.
function cwdOnly(e: Json): Json {
  const att = e.attachment as Json;
  const snapshot = att.snapshot as Json;
  const changes = ((att.changes as Json[] | undefined) ?? []).filter((c) => c.field === 'workingDirectory');
  const reduced: Json = { type: 'environment', snapshot: { workingDirectory: snapshot.workingDirectory } };
  if (att.changes !== undefined) {
    reduced.changes = changes;
  }
  return { ...e, attachment: reduced };
}

function withEnvironment(rebuilt: Json[], seed: Json[], reduce: (e: Json) => Json = (e) => ({ ...e })): { entries: Json[]; inserted: number } {
  const towerIds = new Set(rebuilt.map((e) => String(e.uuid)));
  const after = new Map<string, Json[]>();
  let anchor: string | undefined;
  for (const e of seed) {
    if (modelSide(e) && towerIds.has(String(e.uuid))) {
      anchor = String(e.uuid);
    } else if (e.type === 'attachment' && (e.attachment as Json | undefined)?.type === 'environment' && anchor) {
      after.set(anchor, [...(after.get(anchor) ?? []), reduce(e)]);
    }
  }
  const out: Json[] = [];
  let inserted = 0;
  for (const m of rebuilt) {
    out.push(m);
    for (const env of after.get(String(m.uuid)) ?? []) {
      out.push(env);
      inserted += 1;
    }
  }
  let prev: string | null = null;
  for (const e of out) {
    e.parentUuid = prev;
    prev = String(e.uuid);
  }
  return { entries: out, inserted };
}

async function resume(model: string, source: Source, where: 'a' | 'b', sessionId: string): Promise<void> {
  writeFiles();
  const seedPath = join(SEEDS, `${sessionId}.json`);
  if (!existsSync(seedPath)) {
    throw new Error(`no seed recorded for ${sessionId} (${seedPath})`);
  }
  const seedRec = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedRecord;
  const tag = `${source}-${where}`;
  let tower: Tower | undefined;
  let load: ResumeStore['source'];
  let fileRoot: string | undefined;
  if (source === 'file') {
    fileRoot = join(RESUME_FILE_STORES, `${stamp().replace(/[:.]/g, '')}-${tag}`);
    cpSync(seedRec.fileStore, fileRoot, { recursive: true });
    const file = new FileStore(fileRoot);
    const root = fileRoot;
    load = async (key) => {
      const path = fileFor(root, key);
      const present = readdirSync(root).map((pk) => ({ projectKey: pk, files: readdirSync(join(root, pk)).filter((f) => f.endsWith('.jsonl')).map((f) => ({ file: f, lines: readFileSync(join(root, pk, f), 'utf8').split('\n').filter(Boolean).length })) }));
      return { entries: await file.load(key), detail: { source: 'file', path: relative(root, path), exists: existsSync(path), storeHolds: present } };
    };
  } else if (source === 'whole') {
    // What a store keyed by session id alone would hold: every entry, from
    // both projectKeys, in the order they were appended.
    const entries = seedEntries(seedRec.seedRun);
    load = async (key) => ({ entries: key.subpath ? null : (entries as SessionStoreEntry[]), detail: { source: 'whole', note: 'every seed append, all projectKeys, in order' } });
  } else {
    const t = await openTower();
    tower = t;
    load = async (key) => {
      if (key.subpath) {
        return { entries: null, detail: { source: 'tower', note: 'subagent transcript: nothing on tower for it' } };
      }
      const folded = await foldMessages(t, key.sessionId, seedRec.upto);
      if (folded.messages.length === 0) {
        return { entries: null, detail: { source: 'tower', upto: seedRec.upto, messages: 0 } };
      }
      const rebuilt = buildDerived(folded.messages, await usageModels(t, key.sessionId, seedRec.upto));
      const detail: Json = { source, build: 'derived', upto: seedRec.upto, lastSeq: folded.lastSeq, messages: folded.messages.length };
      if (source === 'tower-env' || source === 'tower-cwd') {
        const { entries, inserted } = withEnvironment(rebuilt, seedEntries(seedRec.seedRun), source === 'tower-cwd' ? cwdOnly : undefined);
        return { entries: entries as SessionStoreEntry[], detail: { ...detail, environmentEntriesInserted: inserted } };
      }
      return { entries: rebuilt as SessionStoreEntry[], detail };
    };
  }
  const store = new ResumeStore(load);
  const bodies = bodiesDirFor(tag);
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  const run = startRun({ name: where === 'a' ? NAME_A : NAME_B, options: { ...baseOptions(model, store, bodies, approvals), resume: sessionId } });
  for (const r of [store.rec, store.loadRec, store.loadedRec, logRec, approvals]) {
    r.attach(run.dir);
  }
  const log = makeLog(logRec);
  writeFileSync(join(run.dir, 'resume.json'), `${JSON.stringify({ source, where, cwd: run.cwd, sessionId, seedRun: seedRec.seedRun, fileRoot, upto: seedRec.upto }, null, 2)}\n`);
  log(`run dir: ${run.dir}; resume ${tag}; cwd ${run.cwd}; session ${sessionId}`);
  await drive(run, RESUME_STEPS, log, undefined);
  await finish(run, bodies, log);
  await tower?.nc.drain();
}

// ---------------------------------------------------------------------------
// Summary: what the model was shown about its directory, where the notice
// lives in the transcript, and what each Bash command printed.

type ApiMessage = { role: string; content: string | Block[] };

const CWD_TEXT = /Primary working directory|working directory has changed|Environment update|resume-cwd-[ab]/;

function textsOf(content: string | Block[]): string[] {
  if (typeof content === 'string') {
    return [content];
  }
  return content.flatMap((b) => (b.type === 'text' ? [String(b.text)] : b.type === 'tool_result' ? [typeof b.content === 'string' ? b.content : JSON.stringify(b.content)] : []));
}

// The lines of a text that say something about the directory.
function cwdLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => CWD_TEXT.test(l))
    .map((l) => l.trim().slice(0, 400));
}

function describe(content: string | Block[]): string {
  if (typeof content === 'string') {
    return `string "${content.slice(0, 80).replace(/\n/g, '\\n')}"`;
  }
  return content
    .map((b) => {
      if (b.type === 'text') {
        const t = String(b.text);
        const n = (t.match(/<system-reminder>/g) ?? []).length;
        return `text${n ? ` reminders(${n})` : ''} "${t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().slice(0, 80).replace(/\n/g, '\\n')}"`;
      }
      if (b.type === 'tool_use') {
        return `tool_use ${String(b.name)} ${JSON.stringify((b.input as Json)?.command ?? b.input)}`;
      }
      if (b.type === 'tool_result') {
        return `tool_result ${JSON.stringify(b.content).slice(0, 120)}`;
      }
      return String(b.type);
    })
    .join(' | ');
}

function summarise(runDir: string): string {
  const out: string[] = [];
  const say = (s: string): void => {
    out.push(s);
  };
  say(`== ${runDir}`);
  const runJson = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as Json;
  say(`harness cwd (SDK options.cwd): ${String(runJson.cwd)}`);
  const claudeDir = join(runDir, 'claude');
  for (const n of existsSync(claudeDir) ? readdirSync(claudeDir).sort() : []) {
    const argv = JSON.parse(readFileSync(join(claudeDir, n, 'argv.json'), 'utf8')) as Json;
    const args = argv.argv as string[];
    const resumeAt = args.indexOf('--resume');
    say(`claude/${n}/argv.json: cwd ${String(argv.cwd)}${resumeAt >= 0 ? `; --resume ${args[resumeAt + 1]}` : ''}`);
  }
  for (const f of ['seed.json', 'resume.json']) {
    if (existsSync(join(runDir, f))) {
      say(`${f}: ${readFileSync(join(runDir, f), 'utf8').replace(/\s+/g, ' ')}`);
    }
  }

  // Where the store's entries were keyed, and which entries speak of the
  // directory.
  const appendsPath = join(runDir, 'store-appends.jsonl');
  if (existsSync(appendsPath)) {
    say('\n-- store appends (store-appends.jsonl): line, key, entries (type/sub, cwd)');
    readJsonl(appendsPath).forEach((a, i) => {
      const key = a.key as SessionKey;
      const entries = a.entries as Json[];
      say(`  line ${i + 1}: projectKey=${key.projectKey} session=${key.sessionId}${key.subpath ? ` subpath=${key.subpath}` : ''} count=${String(a.count)}`);
      entries.forEach((e, j) => {
        const b = brief(e);
        const hits = textsOf(((e.message as Json | undefined)?.content as string | Block[]) ?? JSON.stringify(e.attachment ?? '')).flatMap(cwdLines);
        const attachText = e.attachment ? cwdLines(JSON.stringify(e.attachment)) : [];
        say(`    [${j}] ${String(b.type)}${b.sub ? `/${String(b.sub)}` : ''}${b.isMeta ? ' isMeta' : ''} uuid=${String(b.uuid ?? '-').slice(0, 8)} cwd=${String(b.cwd ?? '-')}${b.blocks ? ` blocks=${JSON.stringify(b.blocks)}` : ''}`);
        for (const h of [...hits, ...attachText]) {
          say(`        says: ${h}`);
        }
      });
    });
  }
  const notPub = join(runDir, 'not-published.jsonl');
  if (existsSync(notPub)) {
    say('\n-- entries not published on tower (not-published.jsonl)');
    readJsonl(notPub).forEach((n, i) => {
      const e = n.entry as Json;
      say(`  line ${i + 1}: ${String(e.type)}${e.sub ? `/${String(e.sub)}` : ''} uuid=${String(e.uuid ?? '-').slice(0, 8)}`);
    });
  }
  const pub = join(runDir, 'published.jsonl');
  if (existsSync(pub)) {
    say('\n-- published on tower (published.jsonl)');
    readJsonl(pub).forEach((p, i) => {
      const body = p.body as Json;
      if (String(p.subject).endsWith('changes.message')) {
        say(`  line ${i + 1}: seq ${String(p.seq)} ${String(body.role)} id=${String(body.id).slice(0, 8)} ${describe(body.content as Block[])}`);
        for (const h of textsOf(body.content as Block[]).flatMap(cwdLines)) {
          say(`        says: ${h}`);
        }
      }
    });
  }
  const loadPath = join(runDir, 'store-load.jsonl');
  if (existsSync(loadPath)) {
    say('\n-- load() (store-load.jsonl)');
    readJsonl(loadPath).forEach((l, i) => {
      const { entries: _e, ...rest } = l;
      say(`  line ${i + 1}: ${JSON.stringify(rest)}`);
    });
  }

  // What the model was sent, request by request (main thread only).
  const index = join(runDir, 'api-bodies', 'index.jsonl');
  if (existsSync(index)) {
    say('\n-- main-thread requests (api-bodies/index.jsonl): directory text the model was shown, and new messages');
    let sent = 0;
    readJsonl(index).forEach((e, i) => {
      if (e.query_source !== 'sdk') {
        return;
      }
      const body = JSON.parse(readFileSync(join(runDir, 'api-bodies', String(e.request_file)), 'utf8')) as Json & { messages: ApiMessage[]; system?: Block[]; thread?: Json };
      const cont = (body.thread as Json | undefined)?.type === 'continue';
      say(`  index line ${i + 1}: ${String(e.request_file)} thread=${JSON.stringify(body.thread ?? null)} messages=${body.messages.length}`);
      for (const s of body.system ?? []) {
        for (const h of cwdLines(String(s.text ?? ''))) {
          say(`      system: ${h}`);
        }
      }
      // A thread `create` resends everything; only the tail is new.
      const from = cont ? 0 : sent === 0 ? 0 : Math.max(0, body.messages.length - 4);
      body.messages.forEach((m, j) => {
        const hits = textsOf(m.content).flatMap(cwdLines);
        if (j >= from || hits.length > 0) {
          say(`    messages[${j}] ${m.role}: ${describe(m.content)}`);
          for (const h of hits) {
            say(`        says: ${h}`);
          }
        }
      });
      const resp = join(runDir, 'api-bodies', String(e.response_file));
      if (existsSync(resp)) {
        const r = JSON.parse(readFileSync(resp, 'utf8')) as Json;
        say(`    response: ${describe((r.content as Block[]) ?? [])}`);
      }
      sent += 1;
    });
  }

  const events = join(runDir, 'proof-events.jsonl');
  if (existsSync(events)) {
    say('\n-- proof events (proof-events.jsonl)');
    readJsonl(events).forEach((ev, i) => {
      const { ts: _ts, ...rest } = ev;
      say(`  line ${i + 1}: ${JSON.stringify(rest).slice(0, 600)}`);
    });
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Cache: what a resume costs against the seed (Stephen, 26 Sep: "are they
// cache concerns, ie if you sent the conversation without them, is it a
// different cache prefix?"). Per main-thread request: thread, message count,
// and the response's usage. Then the seed's context as the model had it by
// its last reply (a thread `create` carries every message, a `continue` only
// the new ones, each response appended) against the resume's first request,
// message by message, to the first difference.

interface MainReq {
  line: number;
  file: string;
  ts: string;
  body: Json & { messages: ApiMessage[]; thread?: Json; system?: Block[] };
  usage: Json | undefined;
  content: Block[] | undefined;
}

function mainReqs(runDir: string): MainReq[] {
  const dir = join(runDir, 'api-bodies');
  return readJsonl(join(dir, 'index.jsonl')).flatMap((e, i) => {
    if (e.query_source !== 'sdk') {
      return [];
    }
    const resp = join(dir, String(e.response_file));
    const r = existsSync(resp) ? (JSON.parse(readFileSync(resp, 'utf8')) as Json) : undefined;
    return [
      {
        line: i + 1,
        file: String(e.request_file),
        ts: String(e.timestamp),
        body: JSON.parse(readFileSync(join(dir, String(e.request_file)), 'utf8')) as MainReq['body'],
        usage: r?.usage as Json | undefined,
        content: r?.content as Block[] | undefined,
      },
    ];
  });
}

// For comparing: string content is one text block; cache_control and a
// response's tool_use `caller` are not content; thinking text is redacted in
// the logged bodies, so thinking compares by its signature.
function norm(content: string | Block[]): string {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return JSON.stringify(
    blocks.map((b) => {
      if (b.type === 'thinking') {
        return { type: b.type, signature: b.signature };
      }
      const { cache_control: _c, caller: _k, ...kept } = b;
      return kept;
    }),
  );
}

function cacheReport(resumeDir: string, seedDir: string): string {
  const out: string[] = [];
  const say = (s: string): void => {
    out.push(s);
  };
  const table = (label: string, dir: string, reqs: MainReq[]): void => {
    say(`-- ${label}: ${dir}`);
    for (const r of reqs) {
      const u = r.usage ?? {};
      const cc = (u.cache_creation as Json | undefined) ?? {};
      say(
        `  api-bodies/index.jsonl line ${r.line} (${r.ts}) ${r.file}: thread=${JSON.stringify(r.body.thread ?? null)} messages=${r.body.messages.length} tools=${Array.isArray(r.body.tools) ? (r.body.tools as Json[]).length : 'absent'} system[0] ${String(r.body.system?.[0]?.text ?? '').length} chars | input ${String(u.input_tokens)} cache_read ${String(u.cache_read_input_tokens)} cache_write ${String(u.cache_creation_input_tokens)} (1h ${String(cc.ephemeral_1h_input_tokens)}, 5m ${String(cc.ephemeral_5m_input_tokens)}) prefix total ${Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0)}`,
      );
    }
  };
  const seedReqs = mainReqs(seedDir);
  const resReqs = mainReqs(resumeDir);
  table('seed', seedDir, seedReqs);
  table('resume', resumeDir, resReqs);
  let ctx: ApiMessage[] = [];
  for (const r of seedReqs) {
    ctx = (r.body.thread as Json | undefined)?.type === 'continue' ? [...ctx, ...r.body.messages] : [...r.body.messages];
    if (r.content) {
      ctx = [...ctx, { role: 'assistant', content: r.content }];
    }
  }
  const first = resReqs[0];
  if (!first) {
    return `${out.join('\n')}\n`;
  }
  say(`\n-- the seed's context by its last reply (${ctx.length} messages) against the resume's first request (index.jsonl line ${first.line}, ${first.body.messages.length} messages)`);
  const n = Math.max(ctx.length, first.body.messages.length);
  let differs = -1;
  for (let i = 0; i < n; i += 1) {
    const s = ctx[i];
    const r = first.body.messages[i];
    const same = s !== undefined && r !== undefined && s.role === r.role && norm(s.content) === norm(r.content);
    if (!same && differs < 0) {
      differs = i;
    }
    say(`  [${i}] ${same ? 'same' : 'DIFF'}`);
    say(`      seed:   ${s ? `${s.role}: ${describe(s.content)}` : '(none)'}`);
    if (!same) {
      say(`      resume: ${r ? `${r.role}: ${describe(r.content)}` : '(none)'}`);
    }
  }
  say(differs < 0 ? '  no difference' : `  first difference at messages[${differs}]`);
  const sys = (reqs: MainReq[]): string => JSON.stringify((reqs[0]?.body.system ?? []).slice(1));
  const tools = (reqs: MainReq[]): string => JSON.stringify(reqs[0]?.body.tools ?? null);
  say(`  system blocks after the first: ${sys(seedReqs) === sys(resReqs) ? 'same' : 'DIFFER'} as the seed's first request; tools: ${tools(seedReqs) === tools(resReqs) ? 'same' : 'DIFFER'}`);
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const usage = `usage:
  node proofs/resume-cwd.mts seed <model>
  node proofs/resume-cwd.mts control <model>
  node proofs/resume-cwd.mts resume <model> <file|tower|whole|tower-env|tower-cwd> <a|b> <sessionId>
  node proofs/resume-cwd.mts --summarise <run dir>
  node proofs/resume-cwd.mts --cache <resume run dir> <seed run dir>`;

if (mode === '--summarise' && rest[0]) {
  process.stdout.write(summarise(rest[0]));
} else if (mode === '--cache' && rest[0] && rest[1]) {
  process.stdout.write(cacheReport(rest[0], rest[1]));
} else if ((mode === 'seed' || mode === 'control') && rest[0]) {
  await seed(rest[0], mode === 'control');
} else if (mode === 'resume' && rest.length === 4 && SOURCES.includes(rest[1] as Source) && (rest[2] === 'a' || rest[2] === 'b')) {
  await resume(rest[0] as string, rest[1] as Source, rest[2], rest[3] as string);
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
}
