// Proof 9: can Claude Code resume from tower's NATS spec (Stephen, 26 Sep:
// "its not "can it use nats" … its CAN IT USE THE NATS SPEC"; "if it just
// does its own shit it is NOT INTEGRATING WITH THE NATS BUS"; "the whole
// fucking point is what does it need?"; "this needs to cover NATS only and
// hybrid").
//
// Decided by Stephen: the participant resumes through the SDK's session
// store; what's published on `changes` is exactly what the model sees; a
// tower message's id is Claude Code's own id; the conversation id is the
// session id.
//
// The store's append() publishes what Claude Code commits onto tower's own
// subjects, shaped by docs/spec/conversation.md and checked against its
// normative schemas (transcribed below) before every publish:
//
//   conv.v2.{sessionId}.changes.message   one per user/assistant message
//   conv.v2.{sessionId}.changes.query     the query closure, reason completed
//   conv.v2.{sessionId}.telemetry.usage   one per usage frame (stream events)
//
// on tower's test broker (127.0.0.1:31416), into the streams mvp/stream-init.sh
// sets up (changes.> and telemetry.usage land in conv-approval).
//
// Two grains, because one tower message = one Claude Code entry or one API
// message is not decided:
//
//   entry   every user/assistant transcript entry is one tower message; its
//           id is the entry's uuid.
//   api     consecutive entries of one API message are one tower message:
//           assistant entries sharing message.id, consecutive user entries
//           (a prompt, or a round's tool results).
//
// And every non-message entry (attachments, queue operations, titles, cost
// state, ...) goes to a local file, the hybrid's other half, each line
// anchored to the tower message it followed.
//
// load() is one of:
//
//   nats           NATS only: every entry rebuilt from tower's subjects, one
//                  per tower message, by a build from BUILDS below. strict is
//                  {type: role, uuid: id, parentUuid: the message before it,
//                  timestamp: ts, message: {role, content}} and nothing else;
//                  derived adds message.model (from telemetry.usage, by
//                  turnId) and message.id (the turnId); the others take one
//                  thing away or put one thing in, to show what each does.
//   hybrid         the messages rebuilt by the build, merged with the local
//                  file's non-message entries at their anchors.
//   hybrid-fields  as hybrid, and the local file also holds each message
//                  entry's fields the spec doesn't carry (message.model,
//                  message.id, requestId, ...), put back on the rebuilt
//                  message.
//
// TODO: undecided. Everything below that shapes the mapping is the easiest
// thing that runs, built for this proof, none of it the participant's design:
// the api grain's tower id (the first entry's uuid) and when it commits (when
// an entry of another API message arrives, or the query ends); queryId (a
// fresh uuid per prompt entry) and turnId (a fresh uuid per prompt, and per
// round of tool results, found through the tool_use ids); instanceId (a
// fresh uuid per process); ts (the time of publishing, not the entry's
// timestamp); a string content becoming one text block; from {kind: human}
// on the proof's own prompts; usage required token fields 0 when a frame
// omits them (as bridge does); no attachment, turn.started, turn.ended or
// tool.use publishing; the local file's layout and anchors; where
// hybrid-fields draws the line; the builds' use of telemetry and turnId.
//
// Modes (from mvp/claude-code-harness/):
//
//   seed <model> <entry|api>
//       One Claude Code, three queries: a code word to remember; thinking and
//       two parallel Reads of files the proof deletes afterwards; a plain
//       reply. Prints the conversation (session) id.
//
//   resume <model> <nats|hybrid|hybrid-fields> <build> <sessionId> <1|2>
//       Resumes through that load(); the resumed run's own entries are
//       published the same way (same grain as the seed). Step 1 asks from
//       memory for the code word and both files, then gives a second code
//       word. Step 2 (a second resume) asks for both words and both files.
//
//   variant <model> <nats|hybrid|hybrid-fields> <build> <sessionId>
//       Resumes from the conversation as the seed left it (tower reads stop
//       at the stream sequence the seed ended on; the local file is read
//       whole, so run hybrid variants before any resume of that seed) and
//       asks the step-1 question. Appends are recorded, never published.
//
//   --summarise <run dir> [...]

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { type JetStreamClient, type JetStreamManager, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

type Json = Record<string, unknown>;
type Block = Json & { type: string };

const NAME = 'resume-spec';
const STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'proof-9');
const HYBRID_FILE_ROOT = join(STATE, 'hybrid-file');
const SEEDS = join(STATE, 'seeds');
const BODIES_ROOT = join(STATE, 'api-bodies');

// Tower's test broker, never 4222.
const NATS_URL = '127.0.0.1:31416';
// What mvp/stream-init.sh names the stream that captures conv.v2.*.changes.>
// and conv.v2.*.telemetry.usage (AUDIT_STREAM). The proof refuses to run if
// the broker routes those subjects anywhere else.
const AUDIT_STREAM = 'conv-approval';
// The service name bridge publishes (mvp/crates/bridge/src/agent.rs:792).
const SERVICE = 'anthropic.messages';

const QUIET_MS = 3000;

const CODE_WORD_1 = 'PERIWINKLE';
const CODE_WORD_2 = 'TANGERINE';
const NOTES: Record<string, string> = { 'note-8.txt': 'MARIGOLD 4417', 'note-9.txt': 'HEMLOCK 2203' };

const SEED_STEPS = [
  `Remember the code word ${CODE_WORD_1} for later. Reply with OK and nothing else.`,
  'Let N be the number of primes below 20; work it out before you act. Then read note-N.txt and note-M.txt from the working directory, where M is N+1, with the Read tool: both in one message, as two parallel tool calls. Reply with their contents only, on one line, separated by " / ".',
  'Reply with the word DONE and nothing else.',
];
const Q1 = 'Answer from memory, without using any tools: what code word did I ask you to remember, and what did the two files you read contain? Reply on one line as: <code word> | <file 1 contents> / <file 2 contents>';
const GIVE_2 = `Remember a second code word, ${CODE_WORD_2}. Reply with OK and nothing else.`;
const Q2 = 'Answer from memory, without using any tools: which two code words did I ask you to remember, in order, and what did the two files you read contain? Reply on one line as: <word 1> <word 2> | <file 1 contents> / <file 2 contents>';

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
    msgId: msg?.id,
    model: msg?.model,
    timestamp: e.timestamp,
    blocks,
  };
}

// ISO 8601 with the machine's own UTC offset, as the spec's examples write
// it (2026-07-07T21:00:00+10:00).
function tsNow(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const local = new Date(d.getTime() + off * 60_000).toISOString().replace('Z', '');
  return `${local}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// The spec's normative schemas (docs/spec/conversation.md, Message schemas),
// transcribed by hand: the repo has no zod, and adding it is not this
// proof's call. Strict about the spec's own fields, loose about the rest,
// as z.looseObject is.

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function checkFields(body: Json, fields: Record<string, 'string' | 'string?' | 'int' | 'int?' | 'ts' | 'sender?' | 'blocks' | 'record?'>): string[] {
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
              ? typeof v === 'object' && v !== null && typeof (v as Json).kind === 'string' && ((v as Json).userId === undefined || typeof (v as Json).userId === 'string')
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

const SCHEMAS: Record<string, Record<string, 'string' | 'string?' | 'int' | 'int?' | 'ts' | 'sender?' | 'blocks' | 'record?'>> = {
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

// ---------------------------------------------------------------------------
// The broker

interface Tower {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

async function openTower(): Promise<Tower> {
  const nc = await connect({ servers: NATS_URL, name: 'proof-9-resume-spec' });
  const jsm = await jetstreamManager(nc);
  // The streams are tower's own, set up by stream-init.sh; this proof creates
  // none. Where they route the subjects it publishes is checked, not assumed.
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

// Every message on the filter (a wildcard allowed), in stream order, up to
// and including `upto` if given.
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

// ---------------------------------------------------------------------------
// The publisher: what Claude Code commits, onto tower's subjects.

type Grain = 'entry' | 'api';

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

// The fields of a message entry the spec's message doesn't carry.
function uncarried(e: Json): Json {
  const { type: _t, uuid: _u, parentUuid: _p, timestamp: _ts, message, ...rest } = e;
  const { role: _r, content: _c, ...msgRest } = (message ?? {}) as Json;
  return { ...rest, message: msgRest };
}

interface OpenMessage {
  id: string;
  role: string;
  queryId: string;
  turnId: string;
  msgId: string | undefined;
  content: Block[];
}

function hybridFileFor(sessionId: string): string {
  return join(HYBRID_FILE_ROOT, `${sessionId}.jsonl`);
}

class Publisher {
  readonly tower: Tower;
  readonly grain: Grain;
  readonly instanceId = randomUUID();
  readonly rec = new Recorder('published.jsonl');
  sessionId: string | undefined;
  queryId: string | undefined;
  // The turn the next assistant message with an unseen message id belongs to.
  currentTurn: string | undefined;
  // The tower id the next local-file line anchors to.
  anchor: string | null = null;
  // The api grain's open messages, in the order they publish: a prompt, an
  // assistant message, the tool results that answer it. Claude Code commits
  // a parallel round interleaved (tool_use, its result, the next tool_use,
  // its result), so the assistant message stays open across its results.
  prompt: OpenMessage | undefined;
  assistant: OpenMessage | undefined;
  results: OpenMessage | undefined;
  readonly turnByMsgId = new Map<string, { queryId: string; turnId: string }>();
  // The turn a message's tool results open (the next round), by message id.
  readonly nextTurnByMsgId = new Map<string, string>();
  readonly msgIdByToolUse = new Map<string, string>();
  readonly pendingUsage = new Map<string, Json[]>();
  lastMsgId: string | undefined;
  lastModel: string | undefined;
  published = 0;
  // Serialises append() and the proof's own calls (closeQuery, usage), which
  // arrive on different channels.
  chain: Promise<void> = Promise.resolve();

  constructor(tower: Tower, grain: Grain) {
    this.tower = tower;
    this.grain = grain;
  }

  toJSON(): Json {
    return { publisher: this.grain, instanceId: this.instanceId };
  }

  // A resumed run continues where the record stands.
  resumeFrom(sessionId: string, lastId: string | null): void {
    this.sessionId = sessionId;
    this.anchor = lastId;
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

  fileLine(line: Json): void {
    if (!this.sessionId) {
      return;
    }
    const path = hybridFileFor(this.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  }

  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    return this.serial(async () => {
      if (key.subpath) {
        // A subagent's transcript: not this proof's (none is started).
        this.rec.write({ at: stamp(), skipped: 'subagent transcript', key, count: entries.length });
        return;
      }
      this.sessionId ??= key.sessionId;
      for (const e of entries as Json[]) {
        if (modelSide(e)) {
          await this.message(e);
        } else {
          this.fileLine({ kind: 'entry', after: this.anchor, entry: e });
        }
      }
    });
  }

  // Which query and turn an entry belongs to. A prompt opens a query and a
  // turn; a tool result belongs to the turn after the one whose tool_use it
  // answers; an assistant entry belongs to its message id's turn, or, for a
  // new message id, to the turn the last user-role entry opened.
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
    if (this.grain === 'entry') {
      await this.publishMessage({ id: uuid, role, queryId, turnId, msgId, content });
      this.anchor = uuid;
      this.fileLine({ kind: 'fields', id: uuid, entryUuid: uuid, fields: uncarried(e) });
    } else {
      let into: OpenMessage;
      if (role === 'assistant') {
        if (this.assistant && this.assistant.msgId === msgId) {
          this.assistant.content.push(...content);
        } else {
          await this.flush();
          this.assistant = { id: uuid, role, queryId, turnId, msgId, content };
        }
        into = this.assistant;
      } else if (isToolResults(content)) {
        if (this.results) {
          this.results.content.push(...content);
        } else {
          this.results = { id: uuid, role, queryId, turnId, msgId, content };
        }
        into = this.results;
      } else {
        await this.flush();
        this.prompt = { id: uuid, role, queryId, turnId, msgId, content };
        into = this.prompt;
      }
      this.anchor = (this.results ?? this.assistant ?? this.prompt ?? into).id;
      this.fileLine({ kind: 'fields', id: into.id, entryUuid: uuid, fields: uncarried(e) });
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

  // The api grain commits a message once an entry arrives that can't belong
  // to it (another message id, a prompt), or the query ends.
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

  // One usage frame from the stream: message_start carries the model and the
  // first usage; message_delta the closing usage. A frame waits until its
  // message's turn is known (the assistant entry names the message id).
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
    const cc = usage.cache_creation as Json | undefined;
    if (cc && typeof cc.ephemeral_5m_input_tokens === 'number') {
      body.cacheCreation5mTokens = cc.ephemeral_5m_input_tokens;
    }
    if (cc && typeof cc.ephemeral_1h_input_tokens === 'number') {
      body.cacheCreation1hTokens = cc.ephemeral_1h_input_tokens;
    }
    const otd = usage.output_tokens_details as Json | undefined;
    if (otd && typeof otd.thinking_tokens === 'number') {
      body.thinkingTokens = otd.thinking_tokens;
    }
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

// ---------------------------------------------------------------------------
// The loaders: what load() returns, rebuilt from tower's subjects.

interface Folded {
  // Latest revision per message id, in the order the ids first appeared.
  messages: Json[];
  tipMoves: number;
  revisions: number;
  queries: Json[];
  lastSeq: number;
}

async function foldChanges(tower: Tower, sessionId: string, upto?: number): Promise<Folded> {
  const stored = await readStream(tower, `conv.v2.${sessionId}.changes.>`, upto);
  const byId = new Map<string, Json>();
  const order: string[] = [];
  let tipMoves = 0;
  let revisions = 0;
  const queries: Json[] = [];
  const prefix = `conv.v2.${sessionId}.changes.`;
  for (const s of stored) {
    const leaf = s.subject.slice(prefix.length);
    if (leaf === 'message') {
      const id = String(s.body.id);
      if (!byId.has(id)) {
        order.push(id);
      }
      byId.set(id, s.body);
    } else if (leaf === 'revision') {
      revisions += 1;
      const prev = byId.get(String(s.body.messageId));
      if (prev) {
        byId.set(String(s.body.messageId), { ...prev, content: s.body.content });
      }
    } else if (leaf === 'tip.moved') {
      // None are published by this proof; a linear conversation is assumed.
      tipMoves += 1;
    } else if (leaf === 'query') {
      queries.push(s.body);
    }
  }
  return { messages: order.map((id) => byId.get(id) as Json), tipMoves, revisions, queries, lastSeq: stored.at(-1)?.seq ?? 0 };
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

interface BuildOptions {
  // Where an assistant message's message.model comes from: nowhere (the spec
  // message has no model), telemetry.usage joined by turnId, the resuming
  // run's own model, or a model that isn't the one that answered.
  model: 'none' | 'usage' | 'own' | 'other' | 'literal';
  literal?: string;
  // Whether an assistant message gets a message.id: none (the spec message
  // has none), or its turnId (a turn's assistant blocks are one API message).
  msgId: 'none' | 'turn';
  timestamp: boolean;
  parentUuid: boolean;
  usage?: Map<string, string>;
  ownModel?: string;
}

const OTHER_MODEL = 'claude-haiku-4-5';

// One entry per tower message: the spec's fields, and nothing else.
function buildEntries(messages: Json[], opts: BuildOptions): Json[] {
  let prev: string | null = null;
  return messages.map((m) => {
    const message: Json = { role: m.role, content: m.content };
    if (m.role === 'assistant') {
      const model = opts.model === 'usage' ? opts.usage?.get(String(m.turnId)) : opts.model === 'own' ? opts.ownModel : opts.model === 'other' ? OTHER_MODEL : opts.model === 'literal' ? opts.literal : undefined;
      if (model) {
        message.model = model;
      }
      if (opts.msgId === 'turn') {
        message.id = m.turnId;
      }
    }
    const entry: Json = { type: m.role, uuid: m.id };
    if (opts.parentUuid) {
      entry.parentUuid = prev;
    }
    if (opts.timestamp) {
      entry.timestamp = m.ts;
    }
    entry.message = message;
    prev = String(m.id);
    return entry;
  });
}

interface FileSide {
  entries: { after: string | null; entry: Json }[];
  fields: Map<string, Json>;
}

function readFileSide(sessionId: string): FileSide {
  const path = hybridFileFor(sessionId);
  const out: FileSide = { entries: [], fields: new Map() };
  if (!existsSync(path)) {
    return out;
  }
  for (const line of readJsonl(path)) {
    if (line.kind === 'entry') {
      out.entries.push({ after: (line.after as string | null) ?? null, entry: line.entry as Json });
    } else if (line.kind === 'fields' && line.id === line.entryUuid) {
      // A message's fields are its first entry's (the api grain's id).
      out.fields.set(String(line.id), line.fields as Json);
    }
  }
  return out;
}

interface Merged {
  entries: Json[];
  stats: Json;
}

// The hybrid: the local file's entries at their anchors, then every entry's
// parentUuid pointed at the entry before it (a file entry keeps its own when
// that entry is present).
function mergeHybrid(messages: Json[], file: FileSide, withFields: boolean): Merged {
  const byAnchor = new Map<string | null, Json[]>();
  for (const f of file.entries) {
    byAnchor.set(f.after, [...(byAnchor.get(f.after) ?? []), f.entry]);
  }
  const out: Json[] = [...(byAnchor.get(null) ?? [])];
  byAnchor.delete(null);
  let fieldsApplied = 0;
  for (const m of messages) {
    if (withFields) {
      const fields = file.fields.get(String(m.uuid));
      if (fields) {
        const { message: msgFields, ...top } = fields;
        Object.assign(m, { ...top, ...m, message: { ...(msgFields as Json), ...(m.message as Json) } });
        fieldsApplied += 1;
      }
    }
    out.push(m);
    const extra = byAnchor.get(String(m.uuid));
    if (extra) {
      out.push(...extra);
      byAnchor.delete(String(m.uuid));
    }
  }
  const orphans = [...byAnchor.values()].flat();
  out.push(...orphans);
  const have = new Set(out.map((e) => e.uuid).filter((u): u is string => typeof u === 'string'));
  const rebuilt = new Set(messages.map((m) => m.uuid));
  let last: string | null = null;
  let relinked = 0;
  for (const e of out) {
    if (typeof e.uuid !== 'string') {
      continue;
    }
    const keep = !rebuilt.has(e.uuid) && (e.parentUuid === null || (typeof e.parentUuid === 'string' && have.has(e.parentUuid)));
    if (!keep && e.parentUuid !== last) {
      e.parentUuid = last;
      relinked += 1;
    }
    last = e.uuid;
  }
  return { entries: out, stats: { towerMessages: messages.length, fileEntries: file.entries.length, fieldsApplied, orphans: orphans.length, relinked } };
}

type LoadOption = 'nats' | 'hybrid' | 'hybrid-fields';

// The store a resumed run gets: load() from tower (and the local file), and
// append() through the publisher.
class TowerStore implements SessionStore {
  readonly tower: Tower;
  readonly publisher: Publisher | undefined;
  readonly option: LoadOption;
  readonly build: BuildOptions;
  readonly upto: number | undefined;
  readonly rec = new Recorder('store-appends.jsonl');
  readonly loadRec = new Recorder('store-load.jsonl');
  readonly loadedRec = new Recorder('loaded-entries.jsonl');
  loadGate: Promise<void> = Promise.resolve();
  constructor(tower: Tower, publisher: Publisher | undefined, option: LoadOption, build: BuildOptions, upto?: number) {
    this.tower = tower;
    this.publisher = publisher;
    this.option = option;
    this.build = build;
    this.upto = upto;
  }
  toJSON(): Json {
    return { store: this.option, build: { ...this.build, usage: undefined }, upto: this.upto, publisher: this.publisher?.toJSON() ?? 'appends recorded only' };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.rec.write({ ts: stamp(), key, count: entries.length, entries });
    await this.publisher?.append(key, entries);
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    await this.loadGate;
    const started = stamp();
    if (key.subpath) {
      this.loadRec.write({ ts: stamp(), key, count: null, note: 'subagent transcript: nothing on tower for it' });
      return null;
    }
    const folded = await foldChanges(this.tower, key.sessionId, this.upto);
    if (folded.messages.length === 0) {
      this.loadRec.write({ ts: stamp(), started, key, count: null });
      return null;
    }
    const build = { ...this.build };
    if (build.model === 'usage') {
      build.usage = await usageModels(this.tower, key.sessionId, this.upto);
    }
    const rebuilt = buildEntries(folded.messages, build);
    let entries = rebuilt;
    let hybrid: Json | undefined;
    if (this.option !== 'nats') {
      const merged = mergeHybrid(rebuilt, readFileSide(key.sessionId), this.option === 'hybrid-fields');
      entries = merged.entries;
      hybrid = merged.stats;
    }
    const last = folded.messages.at(-1);
    this.publisher?.resumeFrom(key.sessionId, last ? String(last.id) : null);
    this.loadRec.write({
      ts: stamp(),
      started,
      key,
      option: this.option,
      build: { ...build, usage: build.usage ? Object.fromEntries(build.usage) : undefined },
      tower: { messages: folded.messages.length, queries: folded.queries.length, revisions: folded.revisions, tipMoves: folded.tipMoves, lastSeq: folded.lastSeq, upto: this.upto },
      hybrid,
      count: entries.length,
      entries: entries.map(brief),
    });
    for (const e of entries) {
      this.loadedRec.write(e);
    }
    return entries as SessionStoreEntry[];
  }
}

// The seed's store: publishes, and keeps a raw copy of every entry (for the
// summary's comparison only; no load() reads it).
class SeedStore implements SessionStore {
  readonly publisher: Publisher;
  readonly rec = new Recorder('store-appends.jsonl');
  constructor(publisher: Publisher) {
    this.publisher = publisher;
  }
  toJSON(): Json {
    return { store: 'seed', publisher: this.publisher.toJSON() };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.rec.write({ ts: stamp(), key, count: entries.length, entries });
    await this.publisher.append(key, entries);
  }
  async load(): Promise<SessionStoreEntry[] | null> {
    return null;
  }
}

// ---------------------------------------------------------------------------
// How load() rebuilds each message from tower's record.

const BUILDS: Record<string, { what: string; build: BuildOptions }> = {
  strict: { what: 'the spec fields only: type (role), uuid (id), parentUuid (the message before), timestamp (ts), message {role, content}', build: { model: 'none', msgId: 'none', timestamp: true, parentUuid: true } },
  'model-usage': { what: 'strict, plus message.model on assistant messages from telemetry.usage, joined by turnId', build: { model: 'usage', msgId: 'none', timestamp: true, parentUuid: true } },
  'model-own': { what: "strict, plus message.model on assistant messages set to the resuming run's own model (not from the record)", build: { model: 'own', msgId: 'none', timestamp: true, parentUuid: true } },
  'model-other': { what: `strict, plus message.model on assistant messages set to ${OTHER_MODEL}, a model that did not answer`, build: { model: 'other', msgId: 'none', timestamp: true, parentUuid: true } },
  'msgid-turn': { what: 'strict, plus message.id on assistant messages set to their turnId', build: { model: 'none', msgId: 'turn', timestamp: true, parentUuid: true } },
  derived: { what: 'everything tower carries that resume uses: strict, plus message.model from telemetry.usage by turnId, plus message.id from turnId', build: { model: 'usage', msgId: 'turn', timestamp: true, parentUuid: true } },
  'derived-own': { what: "derived, but message.model set to the resuming run's own model (not from the record)", build: { model: 'own', msgId: 'turn', timestamp: true, parentUuid: true } },
  'derived-other': { what: `derived, but message.model set to ${OTHER_MODEL}, a model that did not answer`, build: { model: 'other', msgId: 'turn', timestamp: true, parentUuid: true } },
  'derived-synthetic': { what: "derived, but message.model set to '<synthetic>' (what Claude Code writes on messages it made up itself)", build: { model: 'literal', literal: '<synthetic>', msgId: 'turn', timestamp: true, parentUuid: true } },
  'derived-junk': { what: "derived, but message.model set to 'x', not a model at all", build: { model: 'literal', literal: 'x', msgId: 'turn', timestamp: true, parentUuid: true } },
  'derived-nomodel': { what: 'derived without message.model (message.id from turnId only)', build: { model: 'none', msgId: 'turn', timestamp: true, parentUuid: true } },
  'no-timestamp': { what: 'derived without timestamp (ts not mapped)', build: { model: 'usage', msgId: 'turn', timestamp: false, parentUuid: true } },
  'no-parent': { what: 'derived without parentUuid (order not mapped to a chain)', build: { model: 'usage', msgId: 'turn', timestamp: true, parentUuid: false } },
};

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

// Sends each step once the previous one has a result and the stream has
// been quiet for QUIET_MS; the query is closed on tower then. Ends the input
// after the last.
async function drive(run: Run, steps: string[], log: (s: string) => void, publisher: Publisher | undefined): Promise<void> {
  let index = 0;
  let resultSeen = false;
  let quiet: NodeJS.Timeout | undefined;
  let line = 0;
  const send = (): void => {
    log(`send step ${index + 1}: ${JSON.stringify(steps[index])}`);
    run.send(user(steps[index] ?? ''));
  };
  const advance = async (): Promise<void> => {
    quiet = undefined;
    resultSeen = false;
    if (publisher) {
      await publisher.closeQuery('completed');
      log('query closed on tower (changes.query, completed)');
    }
    index += 1;
    if (index < steps.length) {
      send();
    } else {
      log('quiet after last step; end');
      run.end();
    }
  };
  send();
  for await (const message of run.messages()) {
    line += 1;
    if (quiet) {
      clearTimeout(quiet);
      quiet = undefined;
    }
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

function bodiesDirFor(tag: string): string {
  const dir = join(BODIES_ROOT, `${stamp().replace(/[:.]/g, '')}-${tag.slice(0, 80)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseOptions(model: string, store: SessionStore, bodiesDir: string): HarnessOptions {
  return {
    model,
    tools: ['Read'],
    allowedTools: ['Read'],
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
  grain: Grain;
  model: string;
  seedRun: string;
  upto: number;
}

function seedRecord(sessionId: string): SeedRecord {
  const path = join(SEEDS, `${sessionId}.json`);
  if (!existsSync(path)) {
    throw new Error(`no seed recorded for ${sessionId} (${path})`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SeedRecord;
}

// ---------------------------------------------------------------------------
// Modes

async function seed(model: string, grain: Grain): Promise<void> {
  const tower = await openTower();
  const publisher = new Publisher(tower, grain);
  const store = new SeedStore(publisher);
  const bodies = bodiesDirFor(`seed-${grain}`);
  const logRec = new Recorder('proof-log.txt');
  const run = startRun({ name: NAME, options: baseOptions(model, store, bodies) });
  store.rec.attach(run.dir);
  publisher.rec.attach(run.dir);
  logRec.attach(run.dir);
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}; grain ${grain}; instanceId ${publisher.instanceId}`);
  for (const [file, text] of Object.entries(NOTES)) {
    writeFileSync(join(run.cwd, file), `${text}\n`);
  }
  await drive(run, SEED_STEPS, log, publisher);
  // Gone before any resume, so a resume can only answer from what it loaded.
  for (const file of Object.keys(NOTES)) {
    rmSync(join(run.cwd, file), { force: true });
  }
  log(`removed ${Object.keys(NOTES).join(', ')} from the working directory`);
  await publisher.chain;
  const upto = await lastSeq(tower);
  const sessionId = publisher.sessionId;
  if (!sessionId) {
    throw new Error('seed: nothing was appended');
  }
  const record: SeedRecord = { sessionId, grain, model, seedRun: run.dir, upto };
  mkdirSync(SEEDS, { recursive: true });
  writeFileSync(join(SEEDS, `${sessionId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(run.dir, 'seed.json'), `${JSON.stringify(record, null, 2)}\n`);
  log(`conversation ${sessionId}; ${publisher.published} messages published; ${AUDIT_STREAM} last seq ${upto}`);
  await finish(run, bodies, log);
  await tower.nc.drain();
}

async function resumeRun(model: string, sessionId: string, tag: string, option: LoadOption, build: BuildOptions, publish: boolean, upto: number | undefined, steps: string[], info: Json): Promise<void> {
  const seedRec = seedRecord(sessionId);
  const tower = await openTower();
  const publisher = publish ? new Publisher(tower, seedRec.grain) : undefined;
  const store = new TowerStore(tower, publisher, option, { ...build, ownModel: model }, upto);
  let release: () => void = () => {};
  store.loadGate = new Promise((r) => {
    release = r;
  });
  const bodies = bodiesDirFor(tag);
  const logRec = new Recorder('proof-log.txt');
  const run = startRun({ name: NAME, options: { ...baseOptions(model, store, bodies), resume: sessionId } });
  for (const r of [store.rec, store.loadRec, store.loadedRec, logRec]) {
    r.attach(run.dir);
  }
  publisher?.rec.attach(run.dir);
  const log = makeLog(logRec);
  writeFileSync(join(run.dir, 'resume.json'), `${JSON.stringify({ ...info, sessionId, grain: seedRec.grain, seedRun: seedRec.seedRun, upto, publish }, null, 2)}\n`);
  log(`run dir: ${run.dir}`);
  log(`${tag}: conversation ${sessionId} (${seedRec.grain} grain); notes in the working directory: ${Object.keys(NOTES).filter((f) => existsSync(join(run.cwd, f))).join(', ') || 'none'}`);
  release();
  await drive(run, steps, log, publisher);
  await publisher?.chain;
  if (publisher) {
    log(`${publisher.published} messages published`);
  }
  await finish(run, bodies, log);
  await tower.nc.drain();
}

// ---------------------------------------------------------------------------
// Summary

type ApiMessage = { role: string; content: string | Block[] };

function canon(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Json;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => k !== 'cache_control' && obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const REMINDER = /<system-reminder>/;

function describeBlocks(content: string | Block[]): string {
  if (typeof content === 'string') {
    return `"${content.slice(0, 60).replace(/\n/g, '\\n')}"`;
  }
  return content
    .map((b) => {
      if (b.type === 'text') {
        const t = String(b.text);
        const reminder = REMINDER.test(t) ? `system-reminder(${(t.match(/<system-reminder>/g) ?? []).length}) ` : '';
        return `text ${reminder}"${t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().slice(0, 50).replace(/\n/g, '\\n')}"(${t.length})`;
      }
      if (b.type === 'tool_use') {
        return `tool_use ${String(b.name)} ${JSON.stringify(b.input).slice(-40)}`;
      }
      if (b.type === 'tool_result') {
        return `tool_result ${JSON.stringify(b.content).slice(0, 40)}`;
      }
      return String(b.type);
    })
    .join(' | ');
}

function describeApiMessage(m: ApiMessage): string {
  return `${m.role}: ${describeBlocks(m.content)}`;
}

interface MainRequest {
  file: string;
  line: number;
  body: Json & { messages: ApiMessage[]; thread?: Json };
  response: Json | undefined;
}

function mainRequests(runDir: string): MainRequest[] {
  const dir = join(runDir, 'api-bodies');
  const index = join(dir, 'index.jsonl');
  if (!existsSync(index)) {
    return [];
  }
  return readJsonl(index)
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.query_source === 'sdk')
    .map(({ e, i }) => {
      const resp = join(dir, String(e.response_file));
      return {
        file: `api-bodies/${String(e.request_file)}`,
        line: i + 1,
        body: JSON.parse(readFileSync(join(dir, String(e.request_file)), 'utf8')) as MainRequest['body'],
        response: existsSync(resp) ? (JSON.parse(readFileSync(resp, 'utf8')) as Json) : undefined,
      };
    });
}

// The conversation the model had been sent by the end of a run: a thread
// `create` (or none) carries every message; a `continue` only the new ones.
function finalContext(reqs: MainRequest[]): ApiMessage[] {
  let state: ApiMessage[] = [];
  for (const r of reqs) {
    const cont = r.body.thread?.type === 'continue';
    state = cont ? [...state, ...r.body.messages] : [...r.body.messages];
    if (r.response) {
      state = [...state, { role: 'assistant', content: r.response.content as Block[] }];
    }
  }
  return state;
}

// For comparing: string content is one text block; cache_control and a
// response's tool_use `caller` are not content; thinking text is redacted in
// the bodies Claude Code logs, so thinking compares by its signature.
function normalBlocks(content: string | Block[]): Block[] {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return blocks.map((b) => {
    if (b.type === 'thinking') {
      return { type: b.type, signature: b.signature };
    }
    const { cache_control: _c, caller: _k, ...rest } = b;
    return rest as Block;
  });
}

function countThinking(msgs: ApiMessage[]): number {
  return msgs.reduce((n, m) => n + (typeof m.content === 'string' ? 0 : m.content.filter((b) => b.type === 'thinking').length), 0);
}

function countReminders(msgs: ApiMessage[]): number {
  let n = 0;
  for (const m of msgs) {
    for (const b of typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content) {
      if (b.type === 'text') {
        n += (String(b.text).match(/<system-reminder>/g) ?? []).length;
      }
    }
  }
  return n;
}

// The published record as API messages: consecutive same-role tower messages
// are one API message, as the API itself merges them.
function publishedAsApi(published: Json[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const p of published) {
    if (!String(p.subject).endsWith('.changes.message')) {
      continue;
    }
    const body = p.body as Json;
    const last = out.at(-1);
    if (last && last.role === body.role) {
      (last.content as Block[]).push(...(body.content as Block[]));
    } else {
      out.push({ role: String(body.role), content: [...(body.content as Block[])] });
    }
  }
  return out;
}

// The published record grouped the spec's way: a turn is a user-role message
// in and an assistant message out, so each turn (in order of first
// appearance) gives its user-role content, then its assistant content.
function publishedByTurn(published: Json[]): ApiMessage[] {
  const turns: string[] = [];
  const parts = new Map<string, { user: Block[]; assistant: Block[] }>();
  for (const p of published) {
    if (!String(p.subject).endsWith('.changes.message')) {
      continue;
    }
    const body = p.body as Json;
    const t = String(body.turnId);
    if (!parts.has(t)) {
      turns.push(t);
      parts.set(t, { user: [], assistant: [] });
    }
    const slot = parts.get(t) as { user: Block[]; assistant: Block[] };
    (body.role === 'assistant' ? slot.assistant : slot.user).push(...(body.content as Block[]));
  }
  const out: ApiMessage[] = [];
  for (const t of turns) {
    const slot = parts.get(t) as { user: Block[]; assistant: Block[] };
    if (slot.user.length > 0) {
      out.push({ role: 'user', content: slot.user });
    }
    if (slot.assistant.length > 0) {
      out.push({ role: 'assistant', content: slot.assistant });
    }
  }
  return out;
}

// What the model saw, minus what `changes` can't be expected to carry as a
// user/assistant block: system-role messages, and system-reminder text blocks.
function modelSideOnly(ctx: ApiMessage[]): { kept: ApiMessage[]; dropped: string[] } {
  const kept: ApiMessage[] = [];
  const dropped: string[] = [];
  ctx.forEach((m, i) => {
    if (m.role !== 'user' && m.role !== 'assistant') {
      dropped.push(`[${i}] a ${m.role}-role message: ${describeBlocks(m.content)}`);
      return;
    }
    const blocks = normalBlocks(m.content).filter((b) => {
      if (b.type === 'text' && REMINDER.test(String(b.text)) && String(b.text).trim().startsWith('<system-reminder>')) {
        dropped.push(`[${i}] ${m.role} text block, ${String(b.text).length} chars: ${String(b.text).replace(/\n/g, '\\n').slice(0, 90)}`);
        return false;
      }
      return true;
    });
    const last = kept.at(-1);
    if (last && last.role === m.role) {
      (last.content as Block[]).push(...blocks);
    } else if (blocks.length > 0) {
      kept.push({ role: m.role, content: blocks });
    }
  });
  return { kept, dropped };
}

function summarise(runDir: string): string {
  const out: string[] = [];
  const w = (s = ''): void => {
    out.push(s);
  };
  w(`# ${runDir}`);
  const resumeInfo = existsSync(join(runDir, 'resume.json')) ? (JSON.parse(readFileSync(join(runDir, 'resume.json'), 'utf8')) as Json) : undefined;
  const seedInfo = existsSync(join(runDir, 'seed.json')) ? (JSON.parse(readFileSync(join(runDir, 'seed.json'), 'utf8')) as Json) : undefined;
  w(`what: ${resumeInfo ? JSON.stringify(resumeInfo) : `seed ${JSON.stringify(seedInfo ?? {})}`}`);

  // What load() returned.
  const loadPath = join(runDir, 'store-load.jsonl');
  const loads = existsSync(loadPath) ? readJsonl(loadPath) : [];
  const loadedUuids = new Set<string>();
  for (const l of loads) {
    const entries = (l.entries as Json[]) ?? [];
    for (const e of entries) {
      if (typeof e.uuid === 'string') {
        loadedUuids.add(e.uuid);
      }
    }
    const counts = new Map<string, number>();
    for (const e of entries) {
      const k = `${String(e.type)}${e.sub ? `/${String(e.sub)}` : ''}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    w(`load() at ${String(l.ts)}: ${String(l.count)} entries; tower ${JSON.stringify(l.tower ?? null)}${l.hybrid ? `; hybrid ${JSON.stringify(l.hybrid)}` : ''} (store-load.jsonl)`);
    w(`  ${[...counts].map(([k, n]) => `${k}×${n}`).join(', ')}`);
    const models = entries.filter((e) => e.type === 'assistant').map((e) => e.model ?? '-');
    w(`  assistant message.model: ${JSON.stringify(models)}`);
  }

  // The SDK's view.
  w();
  w('== sdk-messages.jsonl');
  const sdk = readJsonl(join(runDir, 'sdk-messages.jsonl'));
  sdk.forEach((s, i) => {
    const m = s.message as SDKMessage;
    if (m.type === 'system' && m.subtype === 'init') {
      w(`  line ${i + 1}: init session_id=${m.session_id} model=${m.model}`);
    }
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text') {
          w(`  line ${i + 1}: assistant text ${JSON.stringify(b.text)}`);
        } else if (b.type === 'tool_use') {
          w(`  line ${i + 1}: assistant tool_use ${b.name} ${JSON.stringify(b.input)}`);
        } else if (b.type === 'thinking') {
          w(`  line ${i + 1}: assistant thinking ${JSON.stringify(String(b.thinking).slice(0, 80))}`);
        }
      }
    }
    if (m.type === 'result') {
      w(`  line ${i + 1}: result ${m.subtype}${m.subtype === 'success' ? ` ${JSON.stringify(m.result)}` : ` ${JSON.stringify((m as Json).errors ?? null)}`} session_id=${m.session_id}`);
    }
    if (m.type === 'system' && m.subtype !== 'init') {
      w(`  line ${i + 1}: system/${m.subtype}`);
    }
  });

  // What was published on tower.
  const pubPath = join(runDir, 'published.jsonl');
  const published = existsSync(pubPath) ? readJsonl(pubPath) : [];
  if (published.length > 0 || existsSync(pubPath)) {
    w();
    w('== published.jsonl: what went onto tower, in order');
    const invalid = published.filter((p) => p.INVALID);
    w(`  ${published.length} lines; ${invalid.length} failed the spec schema`);
    published.forEach((p, i) => {
      const b = (p.body ?? {}) as Json;
      const subject = String(p.subject ?? '');
      const leaf = subject.split('.').slice(3).join('.');
      if (leaf === 'changes.message') {
        w(`  line ${i + 1} seq ${String(p.seq)} ${leaf} id=${String(b.id).slice(0, 8)} q=${String(b.queryId).slice(0, 8)} t=${String(b.turnId).slice(0, 8)} ${String(b.role)} from=${JSON.stringify(b.from ?? null)} [${describeBlocks(b.content as Block[])}]`);
      } else if (leaf === 'changes.query') {
        w(`  line ${i + 1} seq ${String(p.seq)} ${leaf} q=${String(b.queryId).slice(0, 8)} reason=${String(b.reason)}`);
      } else if (leaf === 'telemetry.usage') {
        w(`  line ${i + 1} seq ${String(p.seq)} ${leaf} q=${String(b.queryId).slice(0, 8)} t=${String(b.turnId).slice(0, 8)} model=${String(b.model)} in=${String(b.inputTokens)} out=${String(b.outputTokens)}`);
      } else {
        w(`  line ${i + 1} ${JSON.stringify(p).slice(0, 160)}`);
      }
    });
  }

  // Where the run's own entries hang.
  const appendsPath = join(runDir, 'store-appends.jsonl');
  const appends = existsSync(appendsPath) ? readJsonl(appendsPath) : [];
  const appended: Json[] = appends.flatMap((a) => a.entries as Json[]);
  if (resumeInfo) {
    w();
    w(`== store-appends.jsonl: ${appends.length} append() calls, ${appended.length} entries; the user/assistant ones:`);
    appended.forEach((e, i) => {
      if (e.type === 'user' || e.type === 'assistant') {
        const parent = typeof e.parentUuid === 'string' ? (loadedUuids.has(e.parentUuid) ? ' (parent: a LOADED entry)' : appended.some((x) => x.uuid === e.parentUuid) ? ' (parent: this run)' : ' (parent: NOT FOUND)') : ' (no parent)';
        w(`  #${i + 1} ${JSON.stringify(brief(e))}${parent}`);
      }
    });
  }

  // What the model was sent.
  w();
  w('== main-thread API requests (api-bodies/index.jsonl, query_source sdk)');
  const reqs = mainRequests(runDir);
  for (const r of reqs) {
    w(`  index line ${r.line} ${r.file}: thread=${JSON.stringify(r.body.thread ?? null)} messages=${r.body.messages.length} thinking blocks=${countThinking(r.body.messages)} reminders=${countReminders(r.body.messages)}`);
  }

  if (seedInfo) {
    // The baseline goal: what's on changes is exactly what the model sees.
    const ctx = finalContext(reqs);
    const { kept, dropped } = modelSideOnly(ctx);
    const byOrder = publishedAsApi(published).map((m) => ({ role: m.role, content: normalBlocks(m.content) }));
    const byTurn = publishedByTurn(published).map((m) => ({ role: m.role, content: normalBlocks(m.content) }));
    w();
    w(`== changes against what the model saw: the seed's final context (${ctx.length} API messages) and the published changes.message record`);
    w(`  what the model saw that is not a user/assistant content block (${dropped.length}):`);
    for (const d of dropped) {
      w(`    ${d}`);
    }
    const compare = (label: string, pub: ApiMessage[]): void => {
      w(`  -- ${label} (${pub.length} API messages)`);
      const n = Math.max(kept.length, pub.length);
      let same = 0;
      for (let i = 0; i < n; i += 1) {
        const a = kept[i];
        const b = pub[i];
        if (a && b && canon(a) === canon(b)) {
          same += 1;
          w(`  [${i}] same   ${describeApiMessage(b)}`);
        } else {
          w(`  [${i}] model: ${a ? describeApiMessage(a) : '(none)'}`);
          w(`  [${i}] tower: ${b ? describeApiMessage(b) : '(none)'}`);
        }
      }
      w(`  ${same} of ${n} identical (thinking compared by signature: the logged bodies redact its text)`);
    };
    compare('in publication order, consecutive same-role messages merged', byOrder);
    compare('grouped by turnId: each turn its user-role content, then its assistant content', byTurn);
  }

  const first = reqs[0];
  if (first && resumeInfo) {
    w();
    w(`== the first request after resume (${first.file}), message by message`);
    first.body.messages.forEach((m, i) => w(`  [${i}] ${describeApiMessage(m)}`));
    const seedRun = String(resumeInfo.seedRun);
    const seedReqs = mainRequests(seedRun);
    const seedCtx = finalContext(seedReqs);
    const cont = first.body.thread?.type === 'continue';
    w();
    w(`== against the seed: the context the seed's model had by its last reply (${seedCtx.length} messages, thinking blocks ${countThinking(seedCtx)}, reminders ${countReminders(seedCtx)}); this request: thinking blocks ${countThinking(first.body.messages)}, reminders ${countReminders(first.body.messages)}`);
    if (cont) {
      w(`  this request CONTINUES a server-side thread from ${String((first.body.thread as Json).previous_message_id)}: it carries only ${first.body.messages.length} new message(s), so what load() returned is not what the model saw`);
    } else {
      const sent = first.body.messages;
      const n = Math.max(seedCtx.length, sent.length);
      let same = 0;
      for (let i = 0; i < n; i += 1) {
        const a = seedCtx[i];
        const b = sent[i];
        const equal = a && b && a.role === b.role && canon(normalBlocks(a.content)) === canon(normalBlocks(b.content));
        if (equal) {
          same += 1;
          w(`  [${i}] same   ${describeApiMessage(b)}`);
        } else {
          w(`  [${i}] seed:  ${a ? describeApiMessage(a) : '(none)'}`);
          w(`  [${i}] sent:  ${b ? describeApiMessage(b) : '(none)'}`);
        }
      }
      w(`  ${same} of the seed's ${seedCtx.length} messages sent identically (thinking by signature; cache_control and caller ignored; string content = one text block); the request has ${sent.length}`);
      // The same, with what changes doesn't carry set aside on both sides.
      const seedSide = modelSideOnly(seedCtx).kept;
      const sentSide = modelSideOnly(sent).kept;
      let sameSide = 0;
      const diffs: string[] = [];
      seedSide.forEach((a, i) => {
        const b = sentSide[i];
        if (b && canon(a) === canon(b)) {
          sameSide += 1;
        } else {
          diffs.push(`  [${i}] seed: ${describeApiMessage(a)}\n  [${i}] sent: ${b ? describeApiMessage(b) : '(none)'}`);
        }
      });
      w(`  user/assistant content only (system-role messages and system-reminder blocks set aside on both sides): ${sameSide} of the seed's ${seedSide.length} identical${diffs.length > 0 ? '; differing:' : ''}`);
      for (const d of diffs) {
        w(d);
      }
    }
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const OPTIONS: LoadOption[] = ['nats', 'hybrid', 'hybrid-fields'];
const usage = `usage:
  node proofs/resume-spec.mts seed <model> <entry|api>
  node proofs/resume-spec.mts resume <model> <${OPTIONS.join('|')}> <build> <sessionId> <1|2>
  node proofs/resume-spec.mts variant <model> <${OPTIONS.join('|')}> <build> <sessionId>
  node proofs/resume-spec.mts --summarise <run dir> [...]
builds: ${Object.keys(BUILDS).join(', ')}
`;
const [model, optionArg, buildArg, sessionArg, stepArg] = rest;
const option = optionArg as LoadOption;
const build = buildArg ? BUILDS[buildArg] : undefined;
if (mode === '--summarise' && rest.length > 0) {
  for (const dir of rest) {
    const text = summarise(dir);
    writeFileSync(join(dir, 'summary.txt'), text);
    process.stdout.write(text);
  }
} else if (mode === 'seed' && rest[0] && (rest[1] === 'entry' || rest[1] === 'api')) {
  await seed(rest[0], rest[1]);
} else if (mode === 'resume' && model && OPTIONS.includes(option) && build && sessionArg && (stepArg === '1' || stepArg === '2')) {
  // Resumes that publish their own entries: the conversation grows.
  await resumeRun(model, sessionArg, `${option}-${buildArg}-${stepArg}`, option, build.build, true, undefined, stepArg === '1' ? [Q1, GIVE_2] : [Q2], { option, build: buildArg, what: build.what, step: Number(stepArg) });
} else if (mode === 'variant' && model && OPTIONS.includes(option) && build && sessionArg) {
  // From the conversation as the seed left it; appends recorded, never published.
  const seedRec = seedRecord(sessionArg);
  await resumeRun(model, sessionArg, `variant-${option}-${buildArg}`, option, build.build, false, seedRec.upto, [Q1], { variant: `${option} ${buildArg}`, option, build: buildArg, what: build.what });
} else {
  process.stderr.write(usage);
  process.exit(2);
}
