// Proof 8: where a resumable conversation can live: a file, NATS, or a
// hybrid (Stephen, 26 Sep: "can it be a hybrid? / because that potentially
// allows the resume from nats functionality / would it break if the other
// markers werent there? i doubt it"; "show me how this can and would work in
// both options, file only, nats only, hybrid").
//
// Every option is a SessionStore passed with `resume`: the SDK calls load()
// once, writes what it returns into /tmp/claude-resume-<uuid>/, and Claude
// Code resumes from that (proof 3). What differs is where the entries live.
//
//   file    FileStore: every entry, one JSON line each, in
//           <STATE>/file-store/<projectKey>/<sessionId>.jsonl (a subagent's
//           in <sessionId>/<subpath>.jsonl). load() reads the file back.
//   nats    NatsStore: every entry, one JetStream message each, on
//           proof8.store.<sessionId>.main (a subagent's on
//           proof8.store.<sessionId>.sub.<base64url subpath>), stream PROOF8
//           on the test broker. load() replays the subject with an ordered
//           consumer.
//   hybrid  HybridStore: the entries the model sees (type user and assistant)
//           go to NATS, on proof8.hybrid.<sessionId>.main; every other entry
//           goes to a local file, <STATE>/hybrid-file/<host>/..., each line
//           anchored to the NATS-side entry it followed. load() merges the
//           two back into the original order. With no file (another host,
//           a lost disk) it returns the NATS side alone, relinking any
//           parentUuid that points at an entry it doesn't have.
//
// TODO: undecided. Every layout above (file paths keyed by projectKey;
// subjects keyed by sessionId with projectKey dropped; one message per
// entry; one stream PROOF8 over proof8.>; no Nats-Msg-Id dedupe on uuid; the
// hybrid's split at type user|assistant; the file-side anchor; relinking at
// load) is the easiest thing that runs, built for this proof. None of it is
// the participant's design.
//
// Modes (from mvp/claude-code-harness/):
//
//   seed <model>
//       One Claude Code, three turns: a code word to remember; thinking + a
//       Read of a file that the proof deletes afterwards; a plain reply. Its
//       store is all three at once (a tee), so every option starts from the
//       same conversation. Prints the session id.
//
//   resume <model> <file|nats|hybrid|hybrid-nats> <sessionId> <1|2>
//       Resumes the session through that option's store, which also takes
//       the resumed run's entries. Step 1 asks, from memory, for the code
//       word and the file's contents, then gives a second code word. Step 2
//       (a second resume of the same store) asks for both code words and the
//       file's contents. hybrid-nats is the hybrid store on a host with no
//       local file of its own: it loads the NATS side only.
//
//   ablate <model> <variant> <sessionId>
//       Resumes from the seed's entries (a snapshot taken when the seed
//       ended) with some removed or rebuilt, and asks the step-1 question.
//       Appends are recorded only. Variants are in ABLATIONS below.
//
//   --summarise <run dir>
//
// Every run logs API request bodies (OTEL_LOG_RAW_API_BODIES, as proof 1) so
// the summary can show what the model was actually sent on resume, against
// what it had been sent by the end of the seed.

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

const NAME = 'resume-store';
const STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'proof-8');
const FILE_STORE_ROOT = join(STATE, 'file-store');
const HYBRID_FILE_ROOT = join(STATE, 'hybrid-file');
const SEEDS = join(STATE, 'seeds');
const BODIES_ROOT = join(STATE, 'api-bodies');

// Tower's test broker, never 4222.
const NATS_URL = '127.0.0.1:31416';
const STREAM = 'PROOF8';

const QUIET_MS = 3000;

const CODE_WORD_1 = 'PERIWINKLE';
const CODE_WORD_2 = 'TANGERINE';
const NOTE_FILE = 'note-8.txt';
const NOTE_TEXT = 'MARIGOLD 4417';

const SEED_STEPS = [
  `Remember the code word ${CODE_WORD_1} for later. Reply with OK and nothing else.`,
  'Let N be the number of primes below 20; work it out before you act. Then read note-N.txt (N replaced by the number) from the working directory with the Read tool and reply with its contents only.',
  'Reply with the word DONE and nothing else.',
];
const Q1 = 'Answer from memory, without using any tools: what code word did I ask you to remember, and what did the file you read contain? Reply on one line as: <code word> | <file contents>';
const GIVE_2 = `Remember a second code word, ${CODE_WORD_2}. Reply with OK and nothing else.`;
const Q2 = 'Answer from memory, without using any tools: which two code words did I ask you to remember, in order, and what did the file you read contain? Reply on one line as: <word 1> <word 2> | <file contents>';

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

function keyName(key: SessionKey): string {
  return `${key.sessionId}${key.subpath ? `/${key.subpath}` : ''}`;
}

// One line per entry: what it is, and where it hangs in the chain.
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
    blocks,
  };
}

// ---------------------------------------------------------------------------
// The stores

function fileFor(root: string, key: SessionKey): string {
  const dir = join(root, key.projectKey);
  return key.subpath ? join(dir, key.sessionId, `${key.subpath}.jsonl`) : join(dir, `${key.sessionId}.jsonl`);
}

// Option 1: a file.
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

interface Nats {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
}

async function openNats(): Promise<Nats> {
  const nc = await connect({ servers: NATS_URL, name: 'proof-8-resume-store' });
  const jsm = await jetstreamManager(nc);
  try {
    await jsm.streams.info(STREAM);
  } catch {
    await jsm.streams.add({ name: STREAM, subjects: ['proof8.>'] });
  }
  return { nc, js: jetstream(nc), jsm };
}

function subjectFor(prefix: string, key: SessionKey): string {
  return key.subpath ? `${prefix}.${key.sessionId}.sub.${Buffer.from(key.subpath).toString('base64url')}` : `${prefix}.${key.sessionId}.main`;
}

// Every message on one subject, in stream order; null if there are none.
async function readSubject(nats: Nats, subject: string): Promise<Json[] | null> {
  const info = await nats.jsm.streams.info(STREAM, { subjects_filter: subject });
  const count = info.state.subjects?.[subject] ?? 0;
  if (count === 0) {
    return null;
  }
  const consumer = await nats.js.consumers.get(STREAM, { filter_subjects: subject });
  const out: Json[] = [];
  const messages = await consumer.consume();
  for await (const m of messages) {
    out.push(m.json() as Json);
    if (m.info.pending === 0) {
      break;
    }
  }
  return out;
}

// Option 2: NATS.
class NatsStore implements SessionStore {
  readonly nats: Nats;
  readonly prefix: string;
  constructor(nats: Nats, prefix: string) {
    this.nats = nats;
    this.prefix = prefix;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const subject = subjectFor(this.prefix, key);
    for (const e of entries) {
      await this.nats.js.publish(subject, JSON.stringify(e));
    }
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return (await readSubject(this.nats, subjectFor(this.prefix, key))) as SessionStoreEntry[] | null;
  }
}

function modelSide(e: Json): boolean {
  return e.type === 'user' || e.type === 'assistant';
}

// An entry whose parentUuid names an entry not in the list is pointed at
// the nearest entry before it that has a uuid. Returns how many changed.
function relink(entries: Json[]): number {
  const have = new Set(entries.map((e) => e.uuid).filter((u): u is string => typeof u === 'string'));
  let last: string | null = null;
  let changed = 0;
  for (const e of entries) {
    if (typeof e.uuid !== 'string') {
      continue;
    }
    if (typeof e.parentUuid === 'string' && !have.has(e.parentUuid)) {
      e.parentUuid = last;
      changed += 1;
    }
    last = e.uuid;
  }
  return changed;
}

// Option 3: the hybrid.
class HybridStore implements SessionStore {
  readonly nats: Nats;
  readonly prefix: string;
  readonly fileRoot: string;
  // The last NATS-side uuid appended or loaded, per key: the anchor for the
  // next file-side entry.
  readonly anchor = new Map<string, string | null>();
  lastLoad: { natsSide: number; fileSide: number; orphans: number; relinked: number } | undefined;
  constructor(nats: Nats, prefix: string, fileRoot: string) {
    this.nats = nats;
    this.prefix = prefix;
    this.fileRoot = fileRoot;
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const subject = subjectFor(this.prefix, key);
    const path = fileFor(this.fileRoot, key);
    mkdirSync(dirname(path), { recursive: true });
    for (const e of entries) {
      if (modelSide(e)) {
        await this.nats.js.publish(subject, JSON.stringify(e));
        this.anchor.set(keyName(key), typeof e.uuid === 'string' ? e.uuid : null);
      } else {
        appendFileSync(path, `${JSON.stringify({ after: this.anchor.get(keyName(key)) ?? null, entry: e })}\n`);
      }
    }
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const natsSide = (await readSubject(this.nats, subjectFor(this.prefix, key))) ?? [];
    const path = fileFor(this.fileRoot, key);
    const fileSide = existsSync(path) ? (readJsonl(path) as { after: string | null; entry: Json }[]) : [];
    if (natsSide.length === 0 && fileSide.length === 0) {
      return null;
    }
    const byAnchor = new Map<string | null, Json[]>();
    for (const f of fileSide) {
      byAnchor.set(f.after, [...(byAnchor.get(f.after) ?? []), f.entry]);
    }
    const out: Json[] = [...(byAnchor.get(null) ?? [])];
    byAnchor.delete(null);
    for (const m of natsSide) {
      out.push(m);
      const u = typeof m.uuid === 'string' ? m.uuid : undefined;
      if (u && byAnchor.has(u)) {
        out.push(...(byAnchor.get(u) ?? []));
        byAnchor.delete(u);
      }
    }
    // File-side entries anchored to a NATS entry that isn't there.
    const orphans = [...byAnchor.values()].flat();
    out.push(...orphans);
    const relinked = relink(out);
    const lastModel = [...natsSide].reverse().find((m) => typeof m.uuid === 'string');
    this.anchor.set(keyName(key), (lastModel?.uuid as string | undefined) ?? null);
    this.lastLoad = { natsSide: natsSide.length, fileSide: fileSide.length, orphans: orphans.length, relinked };
    return out as SessionStoreEntry[];
  }
}

// Records every call into the run directory, then hands it to the store.
class Recording implements SessionStore {
  readonly inner: SessionStore[];
  readonly rec = new Recorder('store-appends.jsonl');
  readonly loadRec = new Recorder('store-load.jsonl');
  loadGate: Promise<void> = Promise.resolve();
  // What load() handed the SDK, for the summary.
  loaded: Json[] | null = null;
  calls = 0;
  constructor(inner: SessionStore[]) {
    this.inner = inner;
  }
  // run.json records the options as JSON; a NATS connection is circular.
  toJSON(): Json {
    return { recording: this.inner.map((s) => s.constructor.name) };
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.calls += 1;
    this.rec.write({ ts: stamp(), call: this.calls, key, count: entries.length, entries });
    for (const s of this.inner) {
      await s.append(key, entries);
    }
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    await this.loadGate;
    const started = stamp();
    const first = this.inner[0];
    const got = first ? await first.load(key) : null;
    this.loaded = got as Json[] | null;
    const hybrid = first instanceof HybridStore ? first.lastLoad : undefined;
    this.loadRec.write({ ts: stamp(), started, key, count: got?.length ?? null, hybrid, entries: (got ?? []).map((e) => brief(e as Json)) });
    return got;
  }
}

// ---------------------------------------------------------------------------
// Ablations: what load() returns, built from the seed's entries.

type Ablation = (entries: Json[]) => Json[];

const clone = (entries: Json[]): Json[] => JSON.parse(JSON.stringify(entries)) as Json[];

const ABLATIONS: Record<string, { what: string; build: Ablation }> = {
  full: { what: 'every entry, unchanged (control)', build: (es) => clone(es) },
  'no-uuidless': {
    what: 'drop the entries with no uuid (queue-operation, ai-title, atis-latch, last-prompt, cost-state)',
    build: (es) => clone(es).filter((e) => typeof e.uuid === 'string'),
  },
  'no-attachments': {
    what: 'drop the attachment entries, keep the rest; parentUuid left as it was',
    build: (es) => clone(es).filter((e) => e.type !== 'attachment'),
  },
  'no-attachments-relinked': {
    what: 'drop the attachment entries, keep the rest; parentUuid relinked past them',
    build: (es) => {
      const out = clone(es).filter((e) => e.type !== 'attachment');
      relink(out);
      return out;
    },
  },
  'messages-only': {
    what: 'only the user and assistant entries, unchanged; parentUuid left as it was',
    build: (es) => clone(es).filter(modelSide),
  },
  'messages-relinked': {
    what: 'only the user and assistant entries; parentUuid relinked past what was dropped (what the hybrid loads from NATS alone)',
    build: (es) => {
      const out = clone(es).filter(modelSide);
      relink(out);
      return out;
    },
  },
  'synth-min': {
    what: 'rebuilt from the model-visible messages alone: one entry per API message (assistant entries sharing a message id merged), each {type, uuid (new), parentUuid (previous), message: {role, content}}; nothing else',
    build: (es) => synth(es, false, []),
  },
  'synth-min-ids': {
    what: 'as synth-min, plus each assistant message keeps its API message id (message.id)',
    build: (es) => synth(es, true, []),
  },
};

// Parametrised variants, for finding which fields resume needs:
//   synth-min[-ids]+<field>+<field>...     synth-min[-ids] plus those top-level
//                                          fields, copied from the entry
//                                          (message.<field>: into message)
//   messages-relinked-minus+<field>+...    messages-relinked with those
//                                          top-level fields removed
//   messages-relinked-keep+<field>+...     messages-relinked keeping only
//                                          those top-level fields
function ablation(name: string): { what: string; build: Ablation } | undefined {
  const fixed = ABLATIONS[name];
  if (fixed) {
    return fixed;
  }
  const [base, ...fields] = name.split('+');
  if ((base === 'synth-min' || base === 'synth-min-ids') && fields.length > 0) {
    return { what: `${base} plus the fields ${fields.join(', ')} copied from each message's (first) entry`, build: (es) => synth(es, base === 'synth-min-ids', fields) };
  }
  if (base === 'messages-relinked-keep' && fields.length > 0) {
    return {
      what: `messages-relinked with every top-level field removed except ${fields.join(', ')}`,
      build: (es) => {
        const out = clone(es).filter(modelSide);
        relink(out);
        return out.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => fields.includes(k))));
      },
    };
  }
  if (base === 'messages-relinked-minus' && fields.length > 0) {
    return {
      what: `messages-relinked with the fields ${fields.join(', ')} removed from every entry`,
      build: (es) => {
        const out = clone(es).filter(modelSide);
        relink(out);
        for (const e of out) {
          for (const f of fields) {
            delete e[f];
          }
        }
        return out;
      },
    };
  }
  return undefined;
}

function synth(entries: Json[], keepIds: boolean, extra: string[]): Json[] {
  const out: Json[] = [];
  let prev: string | null = null;
  let lastMsgId: string | undefined;
  for (const e of clone(entries).filter(modelSide)) {
    const msg = e.message as Json;
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    const last = out.at(-1);
    if (e.type === 'assistant' && last && last.type === 'assistant' && id && id === lastMsgId) {
      const lm = last.message as Json;
      lm.content = [...(lm.content as unknown[]), ...(msg.content as unknown[])];
      continue;
    }
    const uuid = randomUUID();
    const message: Json = { role: msg.role, content: msg.content };
    if (keepIds && e.type === 'assistant' && id) {
      message.id = id;
    }
    const entry: Json = { type: e.type, uuid, parentUuid: prev, message };
    for (const f of extra) {
      if (f.startsWith('message.')) {
        const mf = f.slice('message.'.length);
        if (mf in msg) {
          message[mf] = msg[mf];
        }
      } else if (f in e) {
        entry[f] = e[f];
      }
    }
    out.push(entry);
    prev = uuid;
    lastMsgId = id;
  }
  return out;
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

// Sends each step once the previous one has a result and the stream has
// been quiet for QUIET_MS; ends the input after the last.
async function drive(run: Run, steps: string[], log: (s: string) => void): Promise<void> {
  let index = 0;
  let resultSeen = false;
  let quiet: NodeJS.Timeout | undefined;
  let line = 0;
  const send = (): void => {
    log(`send step ${index + 1}: ${JSON.stringify(steps[index])}`);
    run.send(user(steps[index] ?? ''));
  };
  const advance = (): void => {
    quiet = undefined;
    resultSeen = false;
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
    if (message.type === 'result') {
      log(`sdk line ${line}: result ${message.subtype}`);
    }
    if (message.type === 'result' || resultSeen) {
      resultSeen = true;
      quiet = setTimeout(advance, QUIET_MS);
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
  projectKey: string;
  seedRun: string;
  snapshot: string;
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

async function seed(model: string): Promise<void> {
  const nats = await openNats();
  const file = new FileStore(FILE_STORE_ROOT);
  const store = new Recording([file, new NatsStore(nats, 'proof8.store'), new HybridStore(nats, 'proof8.hybrid', join(HYBRID_FILE_ROOT, 'host-a'))]);
  const bodies = bodiesDirFor('seed');
  const logRec = new Recorder('proof-log.txt');
  const run = startRun({ name: NAME, options: baseOptions(model, store, bodies) });
  store.rec.attach(run.dir);
  store.loadRec.attach(run.dir);
  logRec.attach(run.dir);
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}`);
  writeFileSync(join(run.cwd, NOTE_FILE), `${NOTE_TEXT}\n`);
  await drive(run, SEED_STEPS, log);
  // Gone before any resume, so a resume can only answer from what it loaded.
  rmSync(join(run.cwd, NOTE_FILE), { force: true });
  log(`removed ${NOTE_FILE} from the working directory`);
  await finish(run, bodies, log);
  await nats.nc.drain();
  const appends = readJsonl(join(run.dir, 'store-appends.jsonl'));
  const key = appends.map((a) => a.key as SessionKey).find((k) => !k.subpath);
  if (!key) {
    throw new Error('seed: no append for a main transcript');
  }
  mkdirSync(SEEDS, { recursive: true });
  const snapshot = join(SEEDS, `${key.sessionId}.entries.jsonl`);
  writeFileSync(snapshot, readFileSync(fileFor(FILE_STORE_ROOT, key), 'utf8'));
  const record: SeedRecord = { sessionId: key.sessionId, projectKey: key.projectKey, seedRun: run.dir, snapshot };
  writeFileSync(join(SEEDS, `${key.sessionId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(run.dir, 'seed.json'), `${JSON.stringify(record, null, 2)}\n`);
  log(`session ${key.sessionId}; snapshot ${snapshot}`);
}

type Option = 'file' | 'nats' | 'hybrid' | 'hybrid-nats';

async function resume(model: string, option: Option, sessionId: string, step: 1 | 2): Promise<void> {
  const seedRec = seedRecord(sessionId);
  const nats = option === 'file' ? undefined : await openNats();
  const inner: SessionStore =
    option === 'file'
      ? new FileStore(FILE_STORE_ROOT)
      : option === 'nats'
        ? new NatsStore(nats as Nats, 'proof8.store')
        : // hybrid-nats: the same NATS subjects, on a host whose own file is
          // empty, so load() has the NATS side only.
          new HybridStore(nats as Nats, 'proof8.hybrid', join(HYBRID_FILE_ROOT, option === 'hybrid' ? 'host-a' : 'host-b'));
  const store = new Recording([inner]);
  let release: () => void = () => {};
  store.loadGate = new Promise((r) => {
    release = r;
  });
  const bodies = bodiesDirFor(`${option}-${step}`);
  const logRec = new Recorder('proof-log.txt');
  const options = { ...baseOptions(model, store, bodies), resume: sessionId };
  const run = startRun({ name: NAME, options });
  store.rec.attach(run.dir);
  store.loadRec.attach(run.dir);
  logRec.attach(run.dir);
  const log = makeLog(logRec);
  writeFileSync(join(run.dir, 'resume.json'), `${JSON.stringify({ option, step, sessionId, seedRun: seedRec.seedRun }, null, 2)}\n`);
  log(`run dir: ${run.dir}`);
  log(`resume ${option} step ${step}: session ${sessionId}; ${NOTE_FILE} in the working directory: ${existsSync(join(run.cwd, NOTE_FILE))}`);
  release();
  await drive(run, step === 1 ? [Q1, GIVE_2] : [Q2], log);
  await finish(run, bodies, log);
  await nats?.nc.drain();
}

async function ablate(model: string, variant: string, sessionId: string): Promise<void> {
  const ab = ablation(variant);
  if (!ab) {
    throw new Error(`unknown variant ${variant}; one of ${Object.keys(ABLATIONS).join(', ')}, synth-min+<field>..., messages-relinked-minus+<field>...`);
  }
  const seedRec = seedRecord(sessionId);
  const entries = ab.build(readJsonl(seedRec.snapshot));
  const prepared: SessionStore = {
    append: async () => {},
    load: async () => entries as SessionStoreEntry[],
  };
  const store = new Recording([prepared]);
  let release: () => void = () => {};
  store.loadGate = new Promise((r) => {
    release = r;
  });
  const bodies = bodiesDirFor(`ablate-${variant}`);
  const logRec = new Recorder('proof-log.txt');
  const run = startRun({ name: NAME, options: { ...baseOptions(model, store, bodies), resume: sessionId } });
  store.rec.attach(run.dir);
  store.loadRec.attach(run.dir);
  logRec.attach(run.dir);
  const log = makeLog(logRec);
  writeFileSync(join(run.dir, 'resume.json'), `${JSON.stringify({ ablation: variant, what: ab.what, sessionId, seedRun: seedRec.seedRun }, null, 2)}\n`);
  writeFileSync(join(run.dir, 'loaded-entries.jsonl'), entries.map((e) => `${redact(JSON.stringify(e)).text}\n`).join(''));
  log(`run dir: ${run.dir}`);
  log(`ablate ${variant}: ${ab.what}; ${entries.length} entries`);
  release();
  await drive(run, [Q1], log);
  await finish(run, bodies, log);
}

// ---------------------------------------------------------------------------
// Summary

type Block = Json & { type: string };
type ApiMessage = { role: string; content: string | Block[] };

function canon(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Json;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => k !== 'cache_control')
      .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function describeApiMessage(m: ApiMessage): string {
  if (typeof m.content === 'string') {
    return `${m.role}: "${m.content.slice(0, 60).replace(/\n/g, '\\n')}"`;
  }
  return `${m.role}: ${m.content
    .map((b) => {
      if (b.type === 'text') {
        const t = String(b.text);
        const reminder = t.includes('<system-reminder>') ? `system-reminder(${(t.match(/<system-reminder>/g) ?? []).length}) ` : '';
        return `text ${reminder}"${t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().slice(0, 50).replace(/\n/g, '\\n')}"(${t.length})`;
      }
      if (b.type === 'tool_use') {
        return `tool_use ${String(b.name)} ${JSON.stringify(b.input).slice(0, 60)}`;
      }
      if (b.type === 'tool_result') {
        return `tool_result ${JSON.stringify(b.content).slice(0, 50)}`;
      }
      return String(b.type);
    })
    .join(' | ')}`;
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
// `create` (or no thread) carries every message; a `continue` carries only
// the new ones. The last response is added as the assistant's reply.
function finalContext(reqs: MainRequest[]): ApiMessage[] {
  let state: ApiMessage[] = [];
  for (const r of reqs) {
    const cont = r.body.thread?.type === 'continue';
    state = cont ? [...state, ...r.body.messages] : [...r.body.messages];
    // The thread holds each response; a continue builds on it.
    if (r.response) {
      state = [...state, { role: 'assistant', content: r.response.content as Block[] }];
    }
  }
  return state;
}

// String content and a single text block are the same thing to the model.
function normal(m: ApiMessage): ApiMessage {
  const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
  // A response's tool_use carries `caller`, which is never sent back.
  return { role: m.role, content: content.map((b) => ({ ...b, cache_control: undefined, caller: undefined })) };
}

function summarise(runDir: string): string {
  const out: string[] = [];
  const w = (s = ''): void => {
    out.push(s);
  };
  w(`# ${runDir}`);
  const resumeInfo = existsSync(join(runDir, 'resume.json')) ? (JSON.parse(readFileSync(join(runDir, 'resume.json'), 'utf8')) as Json) : undefined;
  w(`what: ${resumeInfo ? JSON.stringify(resumeInfo) : 'seed'}`);

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
    w(`load() at ${String(l.ts)}: ${String(l.count)} entries${l.hybrid ? ` hybrid=${JSON.stringify(l.hybrid)}` : ''} (store-load.jsonl)`);
    w(`  ${[...counts].map(([k, n]) => `${k}×${n}`).join(', ')}`);
    const last = [...entries].reverse().find((e) => typeof e.uuid === 'string');
    w(`  last loaded entry with a uuid: ${last ? JSON.stringify(last) : '-'}`);
  }

  // The SDK's view: answers, tool calls, results.
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
        }
      }
    }
    if (m.type === 'result') {
      w(`  line ${i + 1}: result ${m.subtype}${m.subtype === 'success' ? ` ${JSON.stringify(m.result)}` : ''} session_id=${m.session_id}`);
    }
    if (m.type === 'system' && m.subtype !== 'init') {
      w(`  line ${i + 1}: system/${m.subtype}`);
    }
  });

  // Where the resumed run's own entries went, and what they hang from.
  w();
  w('== store-appends.jsonl');
  const appendsPath = join(runDir, 'store-appends.jsonl');
  const appends = existsSync(appendsPath) ? readJsonl(appendsPath) : [];
  const keys = new Map<string, number>();
  const appended: Json[] = [];
  for (const a of appends) {
    const k = keyName(a.key as SessionKey);
    keys.set(k, (keys.get(k) ?? 0) + Number(a.count));
    appended.push(...(a.entries as Json[]));
  }
  w(`  ${appends.length} append() calls: ${[...keys].map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  appended.forEach((e, i) => {
    const b = brief(e);
    const parent = typeof e.parentUuid === 'string' ? (loadedUuids.has(e.parentUuid) ? ' (parent: a LOADED entry)' : appended.some((x) => x.uuid === e.parentUuid) ? ' (parent: this run)' : ' (parent: NOT FOUND)') : '';
    if (e.type === 'user' || e.type === 'assistant') {
      w(`  #${i + 1} ${JSON.stringify(b)}${parent}`);
    }
  });

  // What the model was sent.
  w();
  w('== main-thread API requests (api-bodies/index.jsonl, query_source sdk)');
  const reqs = mainRequests(runDir);
  for (const r of reqs) {
    w(`  index line ${r.line} ${r.file}: thread=${JSON.stringify(r.body.thread ?? null)} messages=${r.body.messages.length} system=${Array.isArray(r.body.system) ? r.body.system.length : typeof r.body.system}`);
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
    w(`== against the seed: the context the seed's model had by its last reply (${seedCtx.length} messages, from ${seedRun}/api-bodies)`);
    if (cont) {
      const prevId = (first.body.thread as Json).previous_message_id;
      const seedLastId = seedReqs.at(-1)?.response?.id;
      w(`  this request CONTINUES a server-side thread from ${String(prevId)}; the seed's last response id was ${String(seedLastId)}; it carries only ${first.body.messages.length} new message(s)`);
    }
    const sent = cont ? [] : first.body.messages;
    if (!cont) {
      const n = Math.max(seedCtx.length, sent.length);
      let same = 0;
      for (let i = 0; i < n; i += 1) {
        const a = seedCtx[i];
        const b = sent[i];
        const equal = a && b && canon(normal(a)) === canon(normal(b));
        if (equal) {
          same += 1;
          w(`  [${i}] same   ${describeApiMessage(b)}`);
        } else {
          w(`  [${i}] seed:  ${a ? describeApiMessage(a) : '(none)'}`);
          w(`  [${i}] sent:  ${b ? describeApiMessage(b) : '(none)'}`);
        }
      }
      w(`  ${same} of the seed's ${seedCtx.length} messages sent identically (cache_control and a response's tool_use caller ignored; string content = one text block); the request has ${sent.length}`);
    }
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const OPTIONS: Option[] = ['file', 'nats', 'hybrid', 'hybrid-nats'];
if (mode === '--summarise' && rest.length > 0) {
  for (const dir of rest) {
    const text = summarise(dir);
    writeFileSync(join(dir, 'summary.txt'), text);
    process.stdout.write(text);
  }
} else if (mode === 'seed' && rest[0]) {
  await seed(rest[0]);
} else if (mode === 'resume' && rest[0] && OPTIONS.includes(rest[1] as Option) && rest[2] && (rest[3] === '1' || rest[3] === '2')) {
  await resume(rest[0], rest[1] as Option, rest[2], rest[3] === '1' ? 1 : 2);
} else if (mode === 'ablate' && rest[0] && rest[1] && rest[2]) {
  await ablate(rest[0], rest[1], rest[2]);
} else {
  process.stderr.write(
    `usage:\n  node proofs/resume-store.mts seed <model>\n  node proofs/resume-store.mts resume <model> <${OPTIONS.join('|')}> <sessionId> <1|2>\n  node proofs/resume-store.mts ablate <model> <${Object.keys(ABLATIONS).join('|')}> <sessionId>\n  node proofs/resume-store.mts --summarise <run dir> [...]\n`,
  );
  process.exit(2);
}
