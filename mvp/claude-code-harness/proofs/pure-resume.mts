// Proof 14: is a resume from tower pure? (Stephen, 26 Sep: "test it and prove
// that replaying from tower doesnt (or shouldnt, as the *target*) change the
// cache prefix / because if it does, then the resume isn't pure"; "i can
// accept if its impure, but we should at least find out *why* or what
// prevents it from being pure, so i can make an informed decision").
//
// A seed conversation is published to tower as decided (26 Sep):
//   - each piece of a reply (thinking, text, each tool call) is its own
//     changes.message, with Claude Code's own id (the entry's uuid);
//   - turnId is one per API response;
//   - Claude Code's role "system" messages go on changes.message as sent,
//     with role system;
//   - user messages go on as the model saw them, reminder text included.
// It is then resumed through the session store, straight away, from
// Claude Code's full record and from tower, and the resumed first requests
// are compared piece by piece, with their prompt-cache reads.
//
// The seed: a prompt that makes the model think, with one Bash round; a
// set_cwd to a second folder (system messages mid-conversation); a prompt
// with a slow Bash round, and a message sent while that round runs (a
// mid-turn message).
//
// Modes (from mvp/claude-code-harness/):
//
//   seed <model>
//   resume <model> <source> <sessionId>
//       source:
//         full          every entry the seed's store was given, in append
//                       order, whatever projectKey it came under (Claude
//                       Code's own complete record; proof 13's `whole`)
//         tower         tower's changes.message alone, rebuilt into entries
//         tower-typed   tower, with each system message and each user
//                       message's folded parts rebuilt from the Claude Code
//                       entries published beside them on tower
//                       (changes.x-cc-entry)
//         tower-typed-min  tower, with only the attachment types whose
//                       absence changed the resumed tail (MIN_TYPED) rebuilt
//                       from changes.x-cc-entry; their text is stripped from
//                       the as-seen user message for Claude Code to fold in
//                       again
//         tower-payload-min  as tower-typed-min, but each typed entry is
//                       rebuilt from its `attachment` object alone plus
//                       tower's id, ts and text
//         tower-typed-all  tower-typed plus the entries the model never sees
//                       (prompt_snapshot, credential_org, ...), also from
//                       changes.x-cc-entry
//         tower-record  changes.x-cc-entry alone: the whole record, carried
//                       on tower
//       Appends are recorded, never stored or published. Environment:
//         PROOF14_FIRST_DELAY_MS  wait before the first prompt, so the
//                       account's claude.ai connectors have joined the tool
//                       list as they had by the seed's later requests
//         PROOF14_SHIFT_DATE      rewrite the loaded date attachment, standing
//                       in for a record written on an earlier day
//         PROOF14_SYSTEM_AS       the entry a tower system message is rebuilt
//                       into (SYSTEM_AS)
//   --compare <run dir A> <run dir B>
//       The two runs' first main-thread requests, piece by piece, raw JSON
//       with only cache_control stripped, and their usage.
//   --against-seed <resume run dir> <seed run dir>
//       The seed's context by its last reply against the resume's first
//       request.
//   --summarise <run dir>
//
// TODO: undecided, all of the following; each is the easiest thing that
// runs, for this proof only:
//   - Where the as-seen user message comes from. Claude Code composes it at
//     send time (the prompt entry, then attachment entries appended after
//     it, moved in front of it); no store entry holds it. Taken here from
//     the request body Claude Code writes under OTEL_LOG_RAW_API_BODIES.
//   - Timing. The as-seen user message is known only when the request goes
//     out, so an assistant piece written before then waits behind it
//     (tower's order would break otherwise). This departs from "published
//     the moment Claude Code writes it".
//   - Grain of system messages: one changes.message per attachment entry,
//     with its uuid and its `rendered` text, not one per API system message
//     (Claude Code folds several attachments into one).
//   - The id of a user message several entries fold into: the prompt's (or
//     the first tool_result's) uuid.
//   - turnId of user and system messages: the turn of the response to the
//     request that first carries them.
//   - The entry shape load() rebuilds a system message into (SYSTEM_AS).
//   - changes.x-cc-entry: every raw entry on tower beside changes.message.
//     A side channel for finding out what tower would have to carry, not a
//     proposal for how.

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CanUseTool, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { type JetStreamClient, type JetStreamManager, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

type Json = Record<string, unknown>;
type Block = Json & { type: string };

const HARNESS_STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const STATE = join(HARNESS_STATE, 'proof-14');
const SEEDS = join(STATE, 'seeds');
const BODIES_ROOT = join(STATE, 'api-bodies');

const NAME_A = 'pure-resume-a';
const NAME_B = 'pure-resume-b';
const DIR_A = join(HARNESS_STATE, 'work', NAME_A);
const DIR_B = join(HARNESS_STATE, 'work', NAME_B);
const FILES: Record<string, Record<string, string>> = {
  [DIR_A]: { 'note.txt': 'AMBER 1111' },
  [DIR_B]: { 'note.txt': 'BIRCH 2222' },
};

// Tower's test broker, never 4222.
const NATS_URL = '127.0.0.1:31416';
const AUDIT_STREAM = 'conv-approval';
const SERVICE = 'anthropic.messages';
// TODO: undecided (see the header).
const ENTRY_LEAF = 'changes.x-cc-entry';

const QUIET_MS = 3000;
// How long after a request body appears before it is matched against the
// entries: the eager store gets each entry within about 2 ms (proof 3).
const SETTLE_MS = 300;

type Step = { prompt: string; midTurn?: string } | { setCwd: string };

const SEED_STEPS: Step[] = [
  {
    prompt:
      'Work out, carefully, how many integers from 1 to 300 are divisible by 3 or by 5 but not by 7. Then run this exact Bash command, once: `cat note.txt`. Reply with the number and the command output, nothing else.',
  },
  { setCwd: DIR_B },
  {
    prompt: 'Run this exact Bash command, once: `sleep 8; cat note.txt`. Reply with its output only.',
    midTurn: 'One more thing: after the output, add the word PINEAPPLE on its own line.',
  },
];

const RESUME_STEPS: Step[] = [{ prompt: 'Reply with the word OK only.' }];

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
// Tower (proof 13's resume-cwd.mts:210-323, unchanged)

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
  },
};

interface Tower {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

async function openTower(): Promise<Tower> {
  const nc = await connect({ servers: NATS_URL, name: 'proof-14-pure-resume' });
  const jsm = await jetstreamManager(nc);
  for (const probe of ['conv.v2.probe.changes.message', 'conv.v2.probe.changes.query', 'conv.v2.probe.telemetry.usage', `conv.v2.probe.${ENTRY_LEAF}`]) {
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

// ---------------------------------------------------------------------------
// Content helpers

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return Array.isArray(content) ? (content as Block[]) : [];
}

function stripCacheControl(b: Block): Block {
  const { cache_control: _c, ...kept } = b;
  return kept as Block;
}

function isToolResults(content: unknown): boolean {
  const blocks = blocksOf(content);
  return blocks.length > 0 && blocks.some((b) => b.type === 'tool_result');
}

// An attachment entry's `rendered` field: what Claude Code sends for it
// (claude 2.1.282 uses it verbatim in place of re-rendering, Xle/M7o).
function renderedTexts(e: Json): string[] | undefined {
  const r = e.rendered;
  if (!Array.isArray(r) || r.length === 0) {
    return undefined;
  }
  return (r as Json[]).map((x) => (typeof x.content === 'string' ? x.content : blocksOf(x.content).map((b) => String(b.text ?? '')).join('')));
}

function textOfUser(content: unknown): string {
  return blocksOf(content)
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('');
}

// ---------------------------------------------------------------------------
// The publisher: tower's changes, at entry grain, as decided (header).

interface ApiMessage {
  role: string;
  content: string | Block[];
}

interface Item {
  entry: Json;
  kind: 'assistant' | 'user' | 'attachment' | 'other';
  queryId: string;
  resolved: boolean;
  body?: Json;
  placement?: Json;
}

class Publisher {
  readonly tower: Tower;
  readonly instanceId = randomUUID();
  readonly rec = new Recorder('published.jsonl');
  readonly placements = new Recorder('placements.jsonl');
  sessionId: string | undefined;
  queryId: string = randomUUID();
  readonly outbox: Item[] = [];
  readonly turnByMsgId = new Map<string, string>();
  readonly requestTurns: string[] = [];
  readonly pendingUsage = new Map<string, Json[]>();
  lastMsgId: string | undefined;
  lastModel: string | undefined;
  published = 0;
  requestsUsed: string[] = [];
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
        // The side channel: every raw entry, in append order (TODO above).
        await this.publish(ENTRY_LEAF, { ts: tsNow(), entry: e });
        const msg = e.message as Json | undefined;
        let kind: Item['kind'] = 'other';
        if (e.type === 'assistant') {
          kind = 'assistant';
        } else if (e.type === 'user') {
          kind = 'user';
          if (!e.isMeta && !isToolResults(msg?.content)) {
            this.queryId = randomUUID();
          }
        } else if (e.type === 'attachment' && renderedTexts(e)) {
          kind = 'attachment';
        }
        this.outbox.push({ entry: e, kind, queryId: this.queryId, resolved: kind === 'assistant' || kind === 'other' });
      }
      await this.drain();
    });
  }

  // A main-thread request body, as Claude Code wrote it: resolve every
  // pending user and attachment entry against what it actually sent.
  request(file: string, body: Json): Promise<void> {
    return this.serial(async () => {
      this.requestsUsed.push(file);
      const turnId = randomUUID();
      this.requestTurns.push(turnId);
      const api = (body.messages as ApiMessage[]).map((m, i) => ({ i, role: m.role, blocks: blocksOf(m.content).map(stripCacheControl) }));
      const lastIndex = (pred: (m: (typeof api)[number]) => boolean): number => {
        for (let i = api.length - 1; i >= 0; i -= 1) {
          if (pred(api[i] as (typeof api)[number])) {
            return i;
          }
        }
        return -1;
      };
      const groups = new Map<number, Item[]>();
      for (const item of this.outbox) {
        if (item.resolved) {
          continue;
        }
        const e = item.entry;
        const where: Json = { request: file };
        if (item.kind === 'user') {
          const content = (e.message as Json).content;
          let idx: number;
          if (isToolResults(content)) {
            const id = String(blocksOf(content).find((b) => b.type === 'tool_result')?.tool_use_id);
            idx = lastIndex((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === id));
          } else {
            const text = textOfUser(content).trim();
            idx = lastIndex((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'text' && String(b.text).trim() === text));
          }
          if (idx >= 0) {
            groups.set(idx, [...(groups.get(idx) ?? []), item]);
            where.placement = 'user';
            where.apiIndex = idx;
          } else {
            where.placement = 'unmatched';
            item.body = { role: 'user', content: blocksOf(content) };
          }
        } else if (item.kind === 'attachment') {
          const texts = (renderedTexts(e) ?? []).map((t) => t.trim());
          const inUser = lastIndex((m) => m.role === 'user' && texts.every((t) => m.blocks.some((b) => b.type === 'text' && String(b.text).trim() === t)));
          const inSystem = lastIndex((m) => m.role === 'system' && texts.every((t) => m.blocks.some((b) => b.type === 'text' && String(b.text).includes(t))));
          if (inUser >= 0) {
            groups.set(inUser, [...(groups.get(inUser) ?? []), item]);
            where.placement = 'user';
            where.apiIndex = inUser;
          } else {
            where.placement = inSystem >= 0 ? 'system' : 'unmatched';
            where.apiIndex = inSystem;
            item.body = { role: 'system', content: (renderedTexts(e) ?? []).map((t) => ({ type: 'text', text: t })) };
          }
        }
        item.placement = where;
        item.resolved = true;
        (item as Item & { turnId?: string }).turnId = turnId;
      }
      // One tower user message per API user message, as the model saw it,
      // under the prompt's (or first tool_result's) id; the other entries
      // folded into it publish nothing of their own.
      for (const [idx, items] of groups) {
        const principal =
          items.find((it) => it.kind === 'user' && !it.entry.isMeta && !isToolResults((it.entry.message as Json).content)) ??
          items.find((it) => it.kind === 'user' && isToolResults((it.entry.message as Json).content)) ??
          (items[0] as Item);
        const content = (api[idx] as (typeof api)[number]).blocks;
        const folded = items.filter((it) => it !== principal).map((it) => String(it.entry.uuid));
        // foldedEntries: the ids of the entries folded into this message, a
        // side channel like changes.x-cc-entry (TODO above).
        principal.body = { role: 'user', content, ...(isToolResults(content) ? {} : { from: { kind: 'human' } }), ...(folded.length > 0 ? { foldedEntries: folded } : {}) };
        for (const it of items) {
          if (it !== principal) {
            (it.placement as Json).foldedInto = principal.entry.uuid;
          }
        }
      }
      for (const item of this.outbox) {
        if (item.placement && !item.placement.logged) {
          this.placements.write({ at: stamp(), entry: brief(item.entry), ...item.placement });
          item.placement.logged = true;
        }
      }
      await this.drain();
    });
  }

  async drain(): Promise<void> {
    while (this.outbox.length > 0 && (this.outbox[0] as Item).resolved) {
      const item = this.outbox.shift() as Item;
      const e = item.entry;
      if (item.kind === 'assistant') {
        const msg = e.message as Json;
        const msgId = String(msg.id);
        let turnId = this.turnByMsgId.get(msgId);
        if (!turnId) {
          turnId = this.requestTurns.shift() ?? randomUUID();
          this.turnByMsgId.set(msgId, turnId);
        }
        await this.publish('changes.message', {
          ts: tsNow(),
          instanceId: this.instanceId,
          id: String(e.uuid),
          queryId: item.queryId,
          turnId,
          role: 'assistant',
          from: { kind: 'agent' },
          content: msg.content as Block[],
        });
        await this.drainUsage(msgId);
      } else if (item.body) {
        const turnId = (item as Item & { turnId?: string }).turnId ?? randomUUID();
        await this.publish('changes.message', { ts: tsNow(), instanceId: this.instanceId, id: String(e.uuid), queryId: item.queryId, turnId, ...item.body });
      }
    }
  }

  // Whatever is still pending when the seed ends was never sent: published
  // from the entries themselves, marked as such in placements.jsonl.
  finish(): Promise<void> {
    return this.serial(async () => {
      for (const item of this.outbox) {
        if (item.resolved) {
          continue;
        }
        const e = item.entry;
        item.body =
          item.kind === 'user' ? { role: 'user', content: blocksOf((e.message as Json).content) } : { role: 'system', content: (renderedTexts(e) ?? []).map((t) => ({ type: 'text', text: t })) };
        item.resolved = true;
        this.placements.write({ at: stamp(), entry: brief(e), placement: 'never sent' });
      }
      await this.drain();
    });
  }

  closeQuery(reason: string): Promise<void> {
    return this.serial(async () => {
      await this.publish('changes.query', { ts: tsNow(), instanceId: this.instanceId, queryId: this.queryId, reason });
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
    const turnId = this.turnByMsgId.get(msgId);
    const frames = this.pendingUsage.get(msgId) ?? [];
    if (!turnId || frames.length === 0) {
      return;
    }
    this.pendingUsage.delete(msgId);
    for (const f of frames) {
      await this.publish('telemetry.usage', { ts: tsNow(), queryId: this.queryId, turnId, ...f });
    }
  }
}

// Watches the directory Claude Code writes request bodies to
// (OTEL_LOG_RAW_API_BODIES) and hands each main-thread request to the
// publisher. A request file is written when the request goes out; the
// index line only once its response is done, so the files are watched.
class WireWatch {
  readonly dir: string;
  readonly model: string;
  readonly publisher: Publisher;
  readonly seen = new Set<string>();
  readonly settling: Promise<void>[] = [];
  timer: NodeJS.Timeout | undefined;
  constructor(dir: string, model: string, publisher: Publisher) {
    this.dir = dir;
    this.model = model;
    this.publisher = publisher;
  }
  start(): void {
    this.timer = setInterval(() => this.poll(), 50);
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
    for (const { f } of files) {
      let body: Json;
      try {
        body = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Json;
      } catch {
        return; // still being written; next poll
      }
      this.seen.add(f);
      if (body.model === this.model && body.thread !== undefined) {
        this.settling.push(
          new Promise((resolve) => {
            setTimeout(() => {
              void this.publisher.request(f, body).then(resolve, resolve);
            }, SETTLE_MS);
          }),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Loading from tower

async function foldMessages(tower: Tower, sessionId: string, upto: number): Promise<Json[]> {
  const stored = await readStream(tower, `conv.v2.${sessionId}.changes.message`, upto);
  const byId = new Map<string, Json>();
  const order: string[] = [];
  for (const s of stored) {
    const id = String(s.body.id);
    if (!byId.has(id)) {
      order.push(id);
    }
    byId.set(id, s.body);
  }
  return order.map((id) => byId.get(id) as Json);
}

async function towerEntries(tower: Tower, sessionId: string, upto: number): Promise<Json[]> {
  return (await readStream(tower, `conv.v2.${sessionId}.${ENTRY_LEAF}`, upto)).map((s) => s.body.entry as Json);
}

async function usageModels(tower: Tower, sessionId: string, upto: number): Promise<Map<string, string>> {
  const stored = await readStream(tower, `conv.v2.${sessionId}.telemetry.usage`, upto);
  const byTurn = new Map<string, string>();
  for (const s of stored) {
    if (!byTurn.has(String(s.body.turnId))) {
      byTurn.set(String(s.body.turnId), String(s.body.model));
    }
  }
  return byTurn;
}

// TODO: undecided. The entry a tower system message is rebuilt into. The
// easiest shape that Claude Code places as a role "system" message and sends
// verbatim: an attachment entry whose `rendered` holds tower's text (used in
// place of re-rendering, claude 2.1.282 Xle/M7o) under a type Claude Code
// places in a system message (any type outside its user-turn list:
// session_context, remote_session_change, instructions, ...).
const SYSTEM_AS = process.env.PROOF14_SYSTEM_AS ?? 'attachment:tower_system';

function systemEntry(m: Json): Json {
  const text = blocksOf(m.content).map((b) => String(b.text ?? ''));
  if (SYSTEM_AS === 'api_system') {
    return { type: 'api_system', message: { role: 'system', content: text.join('\n\n') } };
  }
  const type = SYSTEM_AS.split(':')[1] ?? 'tower_system';
  return { type: 'attachment', attachment: { type }, rendered: text.map((t) => ({ content: t })) };
}

// Proof 9's build `derived` (message.model from telemetry.usage by turnId,
// message.id from turnId, so the pieces of one reply share an id and Claude
// Code joins them into one API message), plus role system.
function rebuild(messages: Json[], usage: Map<string, string>, raw: Map<string, Json> | undefined, rawOrder: string[], cwd: string, sessionId: string): Json[] {
  const out: Json[] = [];
  for (const m of messages) {
    const common: Json = { uuid: m.id, timestamp: m.ts, isSidechain: false, sessionId, cwd };
    if (raw) {
      // tower-typed: a user or system message is rebuilt as the Claude Code
      // entries it stands for (its own and those folded into it, from
      // foldedEntries), taken from changes.x-cc-entry, in record order.
      const ids = [String(m.id), ...((m.foldedEntries as string[] | undefined) ?? [])].sort((x, y) => rawOrder.indexOf(x) - rawOrder.indexOf(y));
      if (m.role !== 'assistant' && ids.every((id) => raw.has(id))) {
        for (const id of ids) {
          out.push({ ...(raw.get(id) as Json) });
        }
        continue;
      }
    }
    if (m.role === 'system') {
      out.push({ ...common, ...systemEntry(m) });
    } else if (m.role === 'assistant') {
      const message: Json = { id: m.turnId, type: 'message', role: 'assistant', content: m.content };
      const model = usage.get(String(m.turnId));
      if (model) {
        message.model = model;
      }
      out.push({ ...common, type: 'assistant', message });
    } else {
      out.push({ ...common, type: 'user', message: { role: 'user', content: m.content } });
    }
  }
  return relink(out);
}

function relink(entries: Json[]): Json[] {
  let prev: string | null = null;
  for (const e of entries) {
    if (typeof e.uuid === 'string') {
      e.parentUuid = prev;
      prev = e.uuid;
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Stores

class SeedStore implements SessionStore {
  readonly publisher: Publisher;
  readonly rec = new Recorder('store-appends.jsonl');
  constructor(publisher: Publisher) {
    this.publisher = publisher;
  }
  toJSON(): Json {
    return { store: 'seed', publisher: { instanceId: this.publisher.instanceId } };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.rec.write({ ts: stamp(), key, count: entries.length, entries });
    await this.publisher.append(key, entries);
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

function makeLog(rec: Recorder): (s: string) => void {
  return (s: string): void => {
    const line = `${stamp()} ${s}`;
    process.stdout.write(`${line}\n`);
    rec.write(line);
  };
}

// set_cwd through the Query's private request() (proof 4, live.mts:411-423).
async function setCwd(run: Run, path: string): Promise<Json> {
  const request = (run.query as unknown as { request: (r: Json) => Promise<unknown> }).request.bind(run.query);
  const first = (await request({ subtype: 'set_cwd', path })) as { response?: { status?: string; directory?: string } };
  if (first?.response?.status === 'needs_trust') {
    const second = await request({ subtype: 'set_cwd', path, trust_accepted: true, trusted_directory: first.response.directory });
    return { first, second };
  }
  return { first };
}

async function drive(run: Run, steps: Step[], log: (s: string) => void, publisher: Publisher | undefined, firstDelayMs = 0): Promise<void> {
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
        log(`set_cwd result: ${JSON.stringify(result)}`);
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
    if (publisher) {
      await publisher.closeQuery('completed');
    }
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
    if (message.type === 'stream_event' && publisher) {
      void publisher.streamEvent(message.event as unknown as Json);
    }
    const step = steps[index];
    if (step && 'midTurn' in step && step.midTurn && !midTurnSent && message.type === 'assistant' && (message.message.content as unknown as Block[]).some((b) => b.type === 'tool_use')) {
      midTurnSent = true;
      log(`sdk line ${line}: tool_use seen; mid-turn send ${JSON.stringify(step.midTurn)}`);
      events.write({ ts: stamp(), sdkLine: line, midTurn: step.midTurn });
      run.send(user(step.midTurn));
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
      } else if (b.type === 'thinking') {
        events.write({ ts: stamp(), sdkLine: line, thinking: String(b.thinking ?? '').length });
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
  upto: number;
}

// ---------------------------------------------------------------------------
// Modes

async function seed(model: string): Promise<void> {
  writeFiles();
  const tower = await openTower();
  const publisher = new Publisher(tower);
  const store = new SeedStore(publisher);
  const bodies = bodiesDirFor('seed');
  const wire = new WireWatch(bodies, model, publisher);
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  const run = startRun({ name: NAME_A, options: baseOptions(model, store, bodies, approvals) });
  for (const r of [store.rec, publisher.rec, publisher.placements, logRec, approvals]) {
    r.attach(run.dir);
  }
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}; seed; A=${DIR_A} B=${DIR_B}`);
  wire.start();
  await drive(run, SEED_STEPS, log, publisher);
  try {
    await run.done;
  } catch {
    // reported by finish()
  }
  await wire.stop();
  await publisher.finish();
  await publisher.chain;
  const upto = await lastSeq(tower);
  const sessionId = publisher.sessionId;
  if (!sessionId) {
    throw new Error('seed: nothing was appended');
  }
  const rec: SeedRecord = { sessionId, model, seedRun: run.dir, upto };
  mkdirSync(SEEDS, { recursive: true });
  writeFileSync(join(SEEDS, `${sessionId}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  writeFileSync(join(run.dir, 'seed.json'), `${JSON.stringify({ ...rec, requestsUsed: publisher.requestsUsed }, null, 2)}\n`);
  log(`conversation ${sessionId}; ${publisher.published} published; ${AUDIT_STREAM} last seq ${upto}`);
  await finish(run, bodies, log);
  await tower.nc.drain();
}

type Source = 'full' | 'tower' | 'tower-typed' | 'tower-typed-min' | 'tower-payload-min' | 'tower-typed-all' | 'tower-record';
const SOURCES: Source[] = ['full', 'tower', 'tower-typed', 'tower-typed-min', 'tower-payload-min', 'tower-typed-all', 'tower-record'];

// tower-typed-min: only these attachment types come back typed (their
// absence changed the resumed tail in the tower run); every other user and
// system message stays tower's text. A user message's folded reminders of
// these types are stripped from its as-seen content and put back as their
// entries, for Claude Code to fold in again.
const MIN_TYPED = new Set(['session_context', 'remote_session_change', 'environment', 'model', 'date', 'mcp_instructions_delta']);

// payloadOnly (tower-payload-min): a typed entry is rebuilt from the raw
// entry's `attachment` object alone, with tower's own id, ts and text (the
// system message's content, or the block stripped from the user message),
// and none of the raw entry's other fields (cwd, version, gitBranch, ...).
function typedMin(messages: Json[], raw: Json[], rebuilt: Json[], payloadOnly: boolean): Json[] {
  const rawById = new Map(raw.filter((e) => typeof e.uuid === 'string').map((e) => [String(e.uuid), e]));
  const typed = (id: string): Json | undefined => {
    const e = rawById.get(id);
    return e?.type === 'attachment' && MIN_TYPED.has(String((e.attachment as Json).type)) ? e : undefined;
  };
  const fromPayload = (e: Json, ts: unknown, texts: string[], common: Json): Json =>
    payloadOnly ? { ...common, uuid: e.uuid, timestamp: ts, type: 'attachment', attachment: e.attachment, rendered: texts.map((t) => ({ content: t })) } : { ...e };
  const out: Json[] = [];
  for (const e of rebuilt) {
    const m = messages.find((x) => x.id === e.uuid);
    const common: Json = { isSidechain: e.isSidechain, sessionId: e.sessionId, cwd: e.cwd };
    if (m?.role === 'system') {
      const t = typed(String(m.id));
      out.push(t ? fromPayload(t, m.ts, blocksOf(m.content).map((b) => String(b.text)), common) : e);
      continue;
    }
    if (m?.role === 'user' && Array.isArray(m.foldedEntries)) {
      const folded = (m.foldedEntries as string[]).map(typed).filter((x): x is Json => x !== undefined);
      const blocks = blocksOf((e.message as Json).content);
      const own = new Map<Json, string[]>();
      for (const f of folded) {
        const wanted = (renderedTexts(f) ?? []).map((t) => t.trim());
        own.set(
          f,
          blocks.filter((b) => b.type === 'text' && wanted.includes(String(b.text).trim())).map((b) => String(b.text).trim()),
        );
      }
      const strip = new Set([...own.values()].flat());
      const content = blocks.filter((b) => !(b.type === 'text' && strip.has(String(b.text).trim())));
      out.push({ ...e, message: { ...(e.message as Json), content } });
      out.push(...folded.map((f) => fromPayload(f, m.ts, own.get(f) ?? [], common)));
      continue;
    }
    out.push(e);
  }
  return relink(out);
}

function seedEntries(seedRun: string): Json[] {
  return readJsonl(join(seedRun, 'store-appends.jsonl'))
    .filter((a) => !(a.key as SessionKey).subpath)
    .flatMap((a) => a.entries as Json[]);
}

async function resume(model: string, source: Source, sessionId: string): Promise<void> {
  writeFiles();
  const seedPath = join(SEEDS, `${sessionId}.json`);
  if (!existsSync(seedPath)) {
    throw new Error(`no seed recorded for ${sessionId} (${seedPath})`);
  }
  const seedRec = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedRecord;
  let tower: Tower | undefined;
  let load: ResumeStore['source'];
  if (source === 'full') {
    const entries = seedEntries(seedRec.seedRun);
    load = async (key) => ({ entries: key.subpath ? null : entries, detail: { source, note: 'every seed append, all projectKeys, in order' } });
  } else {
    const t = await openTower();
    tower = t;
    load = async (key) => {
      if (key.subpath) {
        return { entries: null, detail: { source, note: 'subagent transcript: nothing on tower for it' } };
      }
      const raw = await towerEntries(t, key.sessionId, seedRec.upto);
      if (source === 'tower-record') {
        return { entries: raw, detail: { source, upto: seedRec.upto, entries: raw.length } };
      }
      const messages = await foldMessages(t, key.sessionId, seedRec.upto);
      if (messages.length === 0) {
        return { entries: null, detail: { source, upto: seedRec.upto, messages: 0 } };
      }
      const rawOrder = raw.map((e) => String(e.uuid ?? ''));
      const rawById = source === 'tower-typed' || source === 'tower-typed-all' ? new Map(raw.filter((e) => typeof e.uuid === 'string').map((e) => [String(e.uuid), e])) : undefined;
      let entries = rebuild(messages, await usageModels(t, key.sessionId, seedRec.upto), rawById, rawOrder, DIR_B, key.sessionId);
      if (source === 'tower-typed-min' || source === 'tower-payload-min') {
        entries = typedMin(messages, raw, entries, source === 'tower-payload-min');
      }
      if (source === 'tower-typed-all') {
        // The entries the model never sees, put back where they were in the
        // record, after the entry they followed.
        const have = new Set(entries.map((e) => String(e.uuid)));
        const out: Json[] = [];
        const pending: Json[] = [];
        const after = new Map<string, Json[]>();
        let anchor: string | undefined;
        for (const e of raw) {
          const id = typeof e.uuid === 'string' ? e.uuid : undefined;
          if (id && have.has(id)) {
            anchor = id;
          } else if (anchor) {
            after.set(anchor, [...(after.get(anchor) ?? []), e]);
          } else {
            pending.push(e);
          }
        }
        out.push(...pending);
        for (const e of entries) {
          out.push(e, ...(after.get(String(e.uuid)) ?? []));
        }
        entries = relink(out.map((e) => ({ ...e })));
      }
      return { entries, detail: { source, systemAs: SYSTEM_AS, upto: seedRec.upto, messages: messages.length, raw: raw.length } };
    };
  }
  // PROOF14_SHIFT_DATE: rewrite every loaded date attachment (payload and
  // rendered text) to this date, standing in for a record written on an
  // earlier day.
  const shiftDate = process.env.PROOF14_SHIFT_DATE;
  if (shiftDate) {
    const inner = load;
    load = async (key) => {
      const { entries, detail } = await inner(key);
      const shifted = entries?.map((e) => {
        const att = e.attachment as Json | undefined;
        if (e.type !== 'attachment' || att?.type !== 'date') {
          return e;
        }
        const was = String(att.date);
        return { ...e, attachment: { ...att, date: shiftDate }, rendered: JSON.parse(JSON.stringify(e.rendered ?? null).split(was).join(shiftDate)) };
      });
      return { entries: shifted ?? null, detail: { ...detail, shiftDate } };
    };
  }
  // PROOF14_FIRST_DELAY_MS: wait before the first prompt, so the account's
  // claude.ai connectors have joined the tool list (as they had by the
  // seed's later requests) and the first request can be measured against
  // the seed's cached history.
  const firstDelayMs = Number(process.env.PROOF14_FIRST_DELAY_MS ?? 0);
  const store = new ResumeStore(load);
  const bodies = bodiesDirFor(`resume-${source}`);
  const logRec = new Recorder('proof-log.txt');
  const approvals = new Recorder('approvals.jsonl');
  const run = startRun({ name: NAME_B, options: { ...baseOptions(model, store, bodies, approvals), resume: sessionId } });
  for (const r of [store.rec, store.loadRec, store.loadedRec, logRec, approvals]) {
    r.attach(run.dir);
  }
  const log = makeLog(logRec);
  writeFileSync(join(run.dir, 'resume.json'), `${JSON.stringify({ source, systemAs: SYSTEM_AS, shiftDate, firstDelayMs, cwd: run.cwd, sessionId, seedRun: seedRec.seedRun, upto: seedRec.upto }, null, 2)}\n`);
  log(`run dir: ${run.dir}; resume ${source}; cwd ${run.cwd}; session ${sessionId}`);
  await drive(run, RESUME_STEPS, log, undefined, firstDelayMs);
  await finish(run, bodies, log);
  await tower?.nc.drain();
}

// ---------------------------------------------------------------------------
// Reading the runs

interface MainReq {
  line: number;
  file: string;
  body: Json & { messages: ApiMessage[]; system?: Block[]; tools?: Json[]; thread?: Json };
  usage: Json | undefined;
}

function mainReqs(runDir: string): MainReq[] {
  const dir = join(runDir, 'api-bodies');
  const index = join(dir, 'index.jsonl');
  if (!existsSync(index)) {
    return [];
  }
  return readJsonl(index).flatMap((e, i) => {
    if (e.query_source !== 'sdk') {
      return [];
    }
    const resp = join(dir, String(e.response_file));
    const r = existsSync(resp) ? (JSON.parse(readFileSync(resp, 'utf8')) as Json) : undefined;
    return [{ line: i + 1, file: String(e.request_file), body: JSON.parse(readFileSync(join(dir, String(e.request_file)), 'utf8')) as MainReq['body'], usage: r?.usage as Json | undefined }];
  });
}

function usageLine(r: MainReq): string {
  const u = r.usage ?? {};
  const total = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
  return `thread=${JSON.stringify(r.body.thread ?? null)} messages=${r.body.messages.length} tools=${Array.isArray(r.body.tools) ? r.body.tools.length : 'absent'} | input ${String(u.input_tokens)} cache_read ${String(u.cache_read_input_tokens)} cache_write ${String(u.cache_creation_input_tokens)} prefix total ${total}`;
}

function describe(content: string | Block[]): string {
  if (typeof content === 'string') {
    return `string "${content.slice(0, 90).replace(/\n/g, '\\n')}"`;
  }
  return content
    .map((b) => {
      if (b.type === 'text') {
        const t = String(b.text);
        const n = (t.match(/<system-reminder>/g) ?? []).length;
        return `text${n ? ` reminders(${n})` : ''} "${t
          .replace(/<system-reminder>\n?/g, '')
          .replace(/<\/system-reminder>/g, '')
          .trim()
          .slice(0, 70)
          .replace(/\n/g, '\\n')}"`;
      }
      if (b.type === 'tool_use') {
        return `tool_use ${String(b.name)} ${JSON.stringify((b.input as Json)?.command ?? b.input)}`;
      }
      if (b.type === 'tool_result') {
        return `tool_result ${JSON.stringify(b.content).slice(0, 60)}`;
      }
      if (b.type === 'thinking') {
        return `thinking sig=${String(b.signature).slice(0, 12)}`;
      }
      return String(b.type);
    })
    .join(' | ');
}

// Raw JSON with only cache_control stripped; thinking text is redacted in
// the logged bodies, so it compares by signature.
function rawKey(m: ApiMessage): string {
  const content =
    typeof m.content === 'string'
      ? m.content
      : m.content.map((b) => {
          const kept = stripCacheControl(b);
          if (kept.type === 'thinking') {
            const { thinking: _t, ...rest } = kept;
            return rest;
          }
          return kept;
        });
  return JSON.stringify({ role: m.role, content });
}

// The same, with string content as one text block: tells a shape difference
// from a content difference.
function looseKey(m: ApiMessage): string {
  return rawKey({ role: m.role, content: blocksOf(m.content) });
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return `at char ${i}: A …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 80))} | B …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 80))}`;
}

function compare(dirA: string, dirB: string): string {
  const out: string[] = [];
  const say = (s: string): void => {
    out.push(s);
  };
  const reqsA = mainReqs(dirA);
  const reqsB = mainReqs(dirB);
  for (const [label, dir, reqs] of [
    ['A', dirA, reqsA],
    ['B', dirB, reqsB],
  ] as const) {
    say(`-- ${label}: ${dir}`);
    for (const r of reqs) {
      say(`  api-bodies/index.jsonl line ${r.line} ${r.file}: ${usageLine(r)}`);
    }
  }
  const a = reqsA[0];
  const b = reqsB[0];
  if (!a || !b) {
    return `${out.join('\n')}\n`;
  }
  const sysKey = (r: MainReq): string => JSON.stringify((r.body.system ?? []).slice(1).map(stripCacheControl));
  say(`\n-- first requests: A ${a.file}, B ${b.file}`);
  say(`  system blocks after the billing header: ${sysKey(a) === sysKey(b) ? 'same' : `DIFFER ${firstDiff(sysKey(a), sysKey(b))}`}`);
  say(`  tools: ${JSON.stringify(a.body.tools ?? null) === JSON.stringify(b.body.tools ?? null) ? 'same' : 'DIFFER'}`);
  for (const k of ['thinking', 'context_management', 'output_config', 'max_tokens', 'betas']) {
    say(`  ${k}: ${JSON.stringify(a.body[k]) === JSON.stringify(b.body[k]) ? 'same' : `DIFFER A=${JSON.stringify(a.body[k])} B=${JSON.stringify(b.body[k])}`}`);
  }
  const n = Math.max(a.body.messages.length, b.body.messages.length);
  let first = -1;
  let looseOnly = 0;
  for (let i = 0; i < n; i += 1) {
    const ma = a.body.messages[i];
    const mb = b.body.messages[i];
    const same = ma !== undefined && mb !== undefined && rawKey(ma) === rawKey(mb);
    const loose = ma !== undefined && mb !== undefined && looseKey(ma) === looseKey(mb);
    if (!same && first < 0) {
      first = i;
    }
    if (!same && loose) {
      looseOnly += 1;
    }
    say(`  [${i}] ${same ? 'same' : loose ? 'SHAPE (string vs one text block)' : 'DIFF'}  A ${ma ? `${ma.role}: ${describe(ma.content)}` : '(none)'}`);
    if (!same) {
      say(`       B ${mb ? `${mb.role}: ${describe(mb.content)}` : '(none)'}`);
      if (ma && mb && !loose) {
        say(`       ${firstDiff(rawKey(ma), rawKey(mb))}`);
      }
    }
  }
  say(first < 0 ? '  messages identical' : `  first difference at messages[${first}]; ${looseOnly} differ in shape only`);
  return `${out.join('\n')}\n`;
}

// The seed's context as the model had it by its last reply: a thread
// `create` carries every message, a `continue` only the new ones; each
// response is appended. Compared with a resume's first request, message by
// message, as compare() does.
function againstSeed(resumeDir: string, seedDir: string): string {
  const out: string[] = [];
  const say = (s: string): void => {
    out.push(s);
  };
  const seedReqs = mainReqs(seedDir);
  let ctx: ApiMessage[] = [];
  for (const r of seedReqs) {
    ctx = r.body.thread?.type === 'continue' ? [...ctx, ...r.body.messages] : [...r.body.messages];
    const respFile = join(seedDir, 'api-bodies', String(readJsonl(join(seedDir, 'api-bodies', 'index.jsonl'))[r.line - 1]?.response_file));
    if (existsSync(respFile)) {
      // A response's tool_use carries `caller`, which Claude Code drops when
      // it sends the message back; the seed's last replies were never sent
      // back (thread continue), so it is dropped here.
      const content = ((JSON.parse(readFileSync(respFile, 'utf8')) as Json).content as Block[]).map((b) => {
        const { caller: _k, ...kept } = b;
        return kept as Block;
      });
      ctx = [...ctx, { role: 'assistant', content }];
    }
    say(`  seed index.jsonl line ${r.line} ${r.file}: ${usageLine(r)}`);
  }
  const first = mainReqs(resumeDir)[0];
  if (!first) {
    return `${out.join('\n')}\n`;
  }
  say(`  resume first request ${first.file}: ${usageLine(first)}`);
  say(`  tools: ${JSON.stringify(seedReqs.at(-1)?.body.tools ?? seedReqs.find((r) => r.body.tools)?.body.tools ?? null) === JSON.stringify(first.body.tools ?? null) ? 'same as the seed' : 'DIFFER from the seed'} (seed requests' tools counts: ${seedReqs.map((r) => (Array.isArray(r.body.tools) ? r.body.tools.length : 'absent')).join(', ')})`);
  let firstDiffAt = -1;
  for (let i = 0; i < Math.max(ctx.length, first.body.messages.length); i += 1) {
    const a = ctx[i];
    const b = first.body.messages[i];
    const same = a !== undefined && b !== undefined && rawKey(a) === rawKey(b);
    const loose = a !== undefined && b !== undefined && looseKey(a) === looseKey(b);
    if (!same && firstDiffAt < 0) {
      firstDiffAt = i;
    }
    say(`  [${i}] ${same ? 'same' : loose ? 'SHAPE (string vs one text block)' : 'DIFF'}  seed ${a ? `${a.role}: ${describe(a.content)}` : '(none)'}${same ? '' : `\n       resume ${b ? `${b.role}: ${describe(b.content)}` : '(none)'}`}`);
  }
  say(firstDiffAt < 0 ? '  no difference' : `  first difference at messages[${firstDiffAt}] (seed context has ${ctx.length} messages)`);
  return `${out.join('\n')}\n`;
}

function summarise(runDir: string): string {
  const out: string[] = [];
  const say = (s: string): void => {
    out.push(s);
  };
  say(`== ${runDir}`);
  for (const f of ['seed.json', 'resume.json']) {
    if (existsSync(join(runDir, f))) {
      say(`${f}: ${readFileSync(join(runDir, f), 'utf8').replace(/\s+/g, ' ')}`);
    }
  }
  const placements = join(runDir, 'placements.jsonl');
  if (existsSync(placements)) {
    say('\n-- where each user and attachment entry was found in the request that carried it (placements.jsonl)');
    readJsonl(placements).forEach((p, i) => {
      const e = p.entry as Json;
      say(`  line ${i + 1}: ${String(e.type)}${e.sub ? `/${String(e.sub)}` : ''}${e.isMeta ? ' isMeta' : ''} ${String(e.uuid).slice(0, 8)} -> ${String(p.placement)}${p.apiIndex !== undefined ? ` messages[${String(p.apiIndex)}]` : ''}${p.foldedInto ? ` folded into ${String(p.foldedInto).slice(0, 8)}` : ''}${p.request ? ` (${String(p.request).slice(0, 8)})` : ''}`);
    });
  }
  const pub = join(runDir, 'published.jsonl');
  if (existsSync(pub)) {
    say('\n-- changes.message published (published.jsonl)');
    readJsonl(pub).forEach((p, i) => {
      const body = p.body as Json;
      if (String(p.subject).endsWith('changes.message')) {
        say(`  line ${i + 1}: seq ${String(p.seq)} ${String(body.role)} ${String(body.id).slice(0, 8)} turn ${String(body.turnId).slice(0, 8)} ${describe(body.content as Block[])}`);
      }
    });
  }
  const loadPath = join(runDir, 'store-load.jsonl');
  if (existsSync(loadPath)) {
    say('\n-- load() (store-load.jsonl)');
    readJsonl(loadPath).forEach((l, i) => {
      const { entries, ...rest } = l;
      say(`  line ${i + 1}: ${JSON.stringify(rest)}`);
      for (const e of (entries as Json[] | undefined) ?? []) {
        say(`      ${String(e.type)}${e.sub ? `/${String(e.sub)}` : ''}${e.isMeta ? ' isMeta' : ''} ${String(e.uuid ?? '-').slice(0, 8)}${e.blocks ? ` ${JSON.stringify(e.blocks)}` : ''}`);
      }
    });
  }
  const reqs = mainReqs(runDir);
  if (reqs.length > 0) {
    say('\n-- main-thread requests (api-bodies/index.jsonl, query_source sdk)');
    for (const r of reqs) {
      say(`  line ${r.line} ${r.file}: ${usageLine(r)}`);
      r.body.messages.forEach((m, j) => {
        say(`    [${j}] ${m.role}: ${describe(m.content)}`);
      });
    }
  }
  const events = join(runDir, 'proof-events.jsonl');
  if (existsSync(events)) {
    say('\n-- proof events (proof-events.jsonl)');
    readJsonl(events).forEach((ev, i) => {
      const { ts: _ts, ...rest } = ev;
      say(`  line ${i + 1}: ${JSON.stringify(rest).slice(0, 400)}`);
    });
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const usage = `usage:
  node proofs/pure-resume.mts seed <model>
  node proofs/pure-resume.mts resume <model> <${SOURCES.join('|')}> <sessionId>
  node proofs/pure-resume.mts --compare <run dir A> <run dir B>
  node proofs/pure-resume.mts --against-seed <resume run dir> <seed run dir>
  node proofs/pure-resume.mts --summarise <run dir>`;

if (mode === '--summarise' && rest[0]) {
  process.stdout.write(summarise(rest[0]));
} else if (mode === '--against-seed' && rest[0] && rest[1]) {
  process.stdout.write(againstSeed(rest[0], rest[1]));
} else if (mode === '--compare' && rest[0] && rest[1]) {
  process.stdout.write(compare(rest[0], rest[1]));
} else if (mode === 'seed' && rest[0]) {
  await seed(rest[0]);
} else if (mode === 'resume' && rest.length === 3 && SOURCES.includes(rest[1] as Source)) {
  await resume(rest[0] as string, rest[1] as Source, rest[2] as string);
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
}
