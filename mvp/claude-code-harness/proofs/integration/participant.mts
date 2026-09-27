// Integration proof: the participant, as one OS process (so it can be
// SIGKILLed and restarted like a real one). One participant = one agent name
// = one config dir (the harness's config-dirs/<agent>), serving any number
// of conversations, one query() each (streaming input).
//
//   node proofs/integration/participant.mts <spec.json>
//
// Driven by JSON lines on stdin; reports JSON lines on stdout, each
// {"ev": ...}. Everything else goes to stderr and the run dir.
//
// Commands:
//   {"cmd":"serve","conv":<label>,"id"?:<uuid>,"from"?:"auto"|"local"|"tower",
//    "dry"?:true,"asOfMs"?:n,"asOfSeq"?:n,"resumeSessionAt"?:<uuid>,"name"?:s}
//   {"cmd":"say","conv":<label>,"text":s,"ending"?:<ending>,"step"?:n}
//   {"cmd":"interrupt","conv":<label>}
//   {"cmd":"end","conv":<label>}                 close its input, wait, drain
//   {"cmd":"skills","declared":[dir...]}         live change of skill dirs
//   {"cmd":"ours","add":[{pid,starttime}...]}   test-only: extend the safety list
//   {"cmd":"shutdown"}                           the first Ctrl-C
// SIGINT, SIGTERM, SIGHUP and stdin closing start the first-Ctrl-C shutdown;
// a second one tears down (SIGTERM to its Claude Codes, NATS closed without
// draining); a third exits.
//
// What it implements (design.md, Settled), with pointers:
//   isolation: spawn.mts (private HOME, login, shell prefix, tag, setpriv,
//     direct spawn with capture); connectors off, the `user` source open.
//   declared config: model, max tokens, thinking, effort, system prompt,
//     permission mode, all from the spec, nothing defaulted here.
//   the leftover stop: stop.mts, on every serve.
//   blind recovery: recover.mts, through the committer, never past tower.
//   the hybrid resume: local record (load() null) or tower (load() = tower's
//     entries), resumeSessionAt in both.
//   skills: skills.mts, linked before start and from the spawn hook.
//   the live committer: committer.mts over lineage.mts.
//
// Test-only (design.md, allowed): the safety gate (spec.ours); "as of"
// overrides and dry serves for the checks; the endings' triggers (a say's
// `ending` interrupts at that point, as proofs/reconcile/run.mts does).

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { EffortLevel, HookCallbackMatcher, HookEvent, PermissionMode, SDKMessage, SDKUserMessage, SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../../src/harness.mts';
import { startRun } from '../../src/harness.mts';
import { load, type TowerBody } from '../reconcile/load.mts';
import type { Option, Rec } from '../reconcile/holding.mts';
import { lastSeq, openTower, type Tower, towerHeld, towerMessages } from '../semantic/tower.mts';
import { blocksOf } from '../semantic/form.mts';
import { Committer, type PublishedLine } from './committer.mts';
import { appendJsonl, clean, CONFIG_DIRS_ROOT, fileStamp, HARNESS_STATE, INTEGRATION_STATE, iso, type Json, type Known, Log2, procStat, signalChecked } from './lib.mts';
import { convRoot, currentLineage, entryId, Lineage, setCurrent } from './lineage.mts';
import { instantOf, recordedResumeDirs, transcripts, union } from './recover.mts';
import { Skills } from './skills.mts';
import { type SpawnRecord, spawnHook, SETPRIV } from './spawn.mts';
import { stopLeftovers } from './stop.mts';

export type Ending = 'first-byte' | 'thinking' | 'mid-text' | 'tool-input' | 'tool-exec';

export interface Spec {
  agent: string;
  runDir: string;
  // Declared config (design.md, Configuration): every one required.
  model: string;
  maxTokens: number;
  thinking: { type: 'adaptive'; display: 'summarized' | 'omitted' };
  effort: EffortLevel;
  systemPrompt: HarnessOptions['systemPrompt'];
  permissionMode: PermissionMode;
  // Declared skill dirs (each child folder holding SKILL.md is a skill).
  skills: string[];
  // The proof's safety gate: Claude Codes this proof started.
  ours: Known[];
  // Test-only env for this process's Claude Codes (a cell's trigger, e.g.
  // the API-error cell's API_TIMEOUT_MS).
  extraEnv?: Record<string, string>;
  stateRoot?: string;
  // Part B's ways through, each TODO: undecided and none the settled rule:
  //   load-unbacked    load() rebuilds a user-side block no entry backs (a
  //                    synthetic tool_result tower committed as received) as
  //                    an entry of its own
  //   commit-dangling  the committer commits an interrupted tool's result and
  //                    marker as written at the marker's append, when tower
  //                    would otherwise end on a tool_use
  //   cut-dangling     a resume from tower that ends on a dangling tool_use
  //                    resumes at the entry before that response
  //   held-carrier     the held user side rides on tower (changes.held) at
  //                    each query's end, and load() adds it
  //   anchor-fallback  the committer anchors a request select() can't
  //   materialise      a serve from tower writes load()'s entries into the
  //                    agent dir's transcript and resumes from it (load()
  //                    null), so this machine's record lives in the agent dir
  variants?: string[];
  // The leftover-capture question this proof exists to answer: which build
  // option ('run', 'run+last' or 'run+entry') runs live, publishing to
  // tower (the same option named in `variants`, defaulting to 'run'). When
  // `pairedVariant` names a different option, a second Committer over the
  // SAME Lineage runs alongside it, dry (never publishes), so both options
  // are computed from the identical recorded entries/requests/results: the
  // only way to compare them without model nondeterminism reading as
  // variant divergence. Swap which one is live/paired across two runs of
  // the same scenario to give both a genuine live resume leg.
  pairedVariant?: string;
}

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write('usage: node proofs/integration/participant.mts <spec.json>\n');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
for (const k of ['agent', 'runDir', 'model', 'maxTokens', 'thinking', 'effort', 'systemPrompt', 'permissionMode'] as const) {
  if (spec[k] === undefined) {
    process.stderr.write(`participant: spec.${k} is required (declared config)\n`);
    process.exit(2);
  }
}
const AGENT = spec.agent;
const STATE_ROOT = spec.stateRoot ?? INTEGRATION_STATE;
const AGENT_STATE = join(STATE_ROOT, AGENT);
const AGENT_DIR = join(CONFIG_DIRS_ROOT, AGENT);
const RUN = spec.runDir;
mkdirSync(RUN, { recursive: true });
mkdirSync(AGENT_STATE, { recursive: true });
const instanceId = randomUUID();
const me = procStat(process.pid);
const VARIANTS = new Set(spec.variants ?? []);
// Claude Code's project key for the harness's cwd (work/<agent>): the path
// with every character but letters and digits made '-', as the agent dir's
// projects/ shows.
const PROJECT_KEY = join(HARNESS_STATE, 'work', AGENT).replace(/[^a-zA-Z0-9]/g, '-');

// TODO: undecided. The private HOME's place and lifetime: one fresh dir per
// participant process in the system temp dir (Stephen: "one per *process*
// is fine"; "can it be in a tmp directory? then we dont need to worry about
// cleanup"), never removed by the participant (v0: no cleanup).
const privateHome = mkdtempSync(join(tmpdir(), `tower-${AGENT}-home-`));

const logFile = new Log2(undefined, join(RUN, 'participant.log.jsonl'));
function log(s: string): void {
  const line = `${iso()} [${AGENT} ${process.pid}] ${s}`;
  process.stderr.write(`${clean(line)}\n`);
  logFile.write({ ts: iso(), s });
}
const eventsOut = new Log2(undefined, join(RUN, 'events.jsonl'));
function emit(ev: string, detail: Json = {}): void {
  const line = { ev, ts: iso(), ms: Date.now(), agent: AGENT, pid: process.pid, ...detail };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  eventsOut.write(line);
}

// ---------------------------------------------------------------------------

const skills = new Skills(spec.skills ?? [], log);
const spawned: SpawnRecord[] = [];
const ownPids = (): Set<number> => new Set(spawned.map((s) => s.pid));

let tower: Tower;

interface Conv {
  label: string;
  id: string;
  dry: boolean;
  decision: string;
  lin: Lineage;
  committer: Committer;
  // The paired same-recording methodology (spec.pairedVariant): a dry
  // committer over the same Lineage, a different build option, poked
  // alongside the live one, never published.
  shadow: Committer | undefined;
  run: Run;
  busy: boolean;
  queryId: string;
  sayText: string;
  sayMs: number;
  lastResultMs: number;
  // Claude Code's own command queue, as its queue-operation entries show it
  // (contents enqueued and not yet dequeued), and the turn it is running.
  queue: string[];
  turn: { queryId: string; self: boolean } | undefined;
  sayStarted: boolean;
  interruptedByUs: boolean;
  ending?: Ending;
  step?: number;
  fired: boolean;
  resultSeen: boolean;
  stream: { thinkingOpen: boolean; textChars: number; inputChars: number };
  firstByteTimer?: NodeJS.Timeout;
  loop: Promise<void>;
  exited: boolean;
}
const convs = new Map<string, Conv>();

const user = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });

// The last non-system entry of what's loaded (proof 24): resumeSessionAt.
function lastChain(entries: Json[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as Json;
    if (typeof e.uuid === 'string' && e.type !== 'system' && e.type !== 'progress') {
      return e.uuid;
    }
  }
  return undefined;
}

// A uuid-shaped id from a string (the load-unbacked variant's rebuilt
// entries: the same block gets the same id on every load).
function uuidFrom(s: string): string {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Tower's messages as the entries load() rebuilds, each with its seq; with
// the held-carrier variant, the held entries too; with load-unbacked, each
// user-side block no entry backs as an entry of its own.
function fromTower(bodies: TowerBody[], held: { seq: number; entry: Json }[] = []): { entries: Json[]; lastChain: string | undefined; seqd: { seq: number; entry: Json }[]; fabricated: string[] } {
  const unshown: Rec[] = [];
  for (const b of bodies) {
    for (const u of ((b as Json).ccUnshown as { seq: number; entry: Json }[] | undefined) ?? []) {
      unshown.push({ seq: u.seq, ms: 0, entry: u.entry });
    }
  }
  for (const h of held) {
    unshown.push({ seq: h.seq, ms: 0, entry: h.entry });
  }
  // TODO: undecided (Part B, way 1 for failure 1/2): load-unbacked.
  const fabricated: Rec[] = [];
  const reparent = new Map<string, string>(); // entry uuid -> new parent
  if (VARIANTS.has('load-unbacked')) {
    for (const b of bodies) {
      if (b.role === 'assistant') {
        continue;
      }
      const cc = [...(b.ccEntries ?? [])].sort((x, y) => x.seq - y.seq);
      const covered = new Set(cc.flatMap((c) => c.spans.map((sp) => sp.block)));
      b.content.forEach((block, bi) => {
        if (covered.has(bi)) {
          return;
        }
        // Placed before the first entry whose blocks come after it, and
        // chained: that entry's parent becomes the rebuilt one.
        const after = cc.find((c) => c.spans.some((sp) => sp.block > bi));
        const base = (after ?? cc[cc.length - 1])?.entry as Json | undefined;
        const uuid = uuidFrom(`${b.id}:${bi}`);
        const e: Json = {
          parentUuid: (base?.parentUuid as string | undefined) ?? null,
          isSidechain: false,
          ...Object.fromEntries(['userType', 'entrypoint', 'cwd', 'sessionId', 'version', 'gitBranch'].filter((k) => base && k in base).map((k) => [k, (base as Json)[k]])),
          type: 'user',
          message: { role: 'user', content: [block] },
          uuid,
          timestamp: b.ts,
          rebuiltFromTower: { messageId: b.id, block: bi },
        };
        const seq = after ? after.seq - 0.5 : (cc[cc.length - 1]?.seq ?? 0) + 0.5;
        fabricated.push({ seq, ms: 0, entry: e });
        if (after) {
          reparent.set(after.uuid, uuid);
        }
      });
    }
  }
  const l = load(bodies, [...unshown, ...fabricated]);
  const entries = l.entries.map((e) => (typeof e.uuid === 'string' && reparent.has(e.uuid) ? { ...e, parentUuid: reparent.get(e.uuid) } : e));
  const seqOf = new Map<string, number>();
  for (const b of bodies) {
    for (const c of b.ccEntries ?? []) {
      seqOf.set(`uuid:${c.uuid}`, c.seq);
    }
  }
  for (const u of [...unshown, ...fabricated]) {
    seqOf.set(entryId(u.entry), u.seq);
  }
  const seqd = entries.map((e, i) => ({ seq: seqOf.get(entryId(e)) ?? 1_000_000 + i, entry: e }));
  return { entries, lastChain: l.lastChain, seqd, fabricated: fabricated.map((f) => String(f.entry.uuid)) };
}

// TODO: undecided (Part B, way 3 for failure 1): cut-dangling. When what
// tower gives ends on a response with a tool_use nothing answers, the resume
// point is the last non-system entry before that response's first piece.
function danglingCut(entries: Json[]): { cutAt: string; toolUse: string } | undefined {
  const answered = new Set(entries.flatMap((e) => (e.type === 'user' ? blocksOf((e.message as Json | undefined)?.content).filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)) : [])));
  let lastAssistant = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as Json;
    if (e.type === 'assistant' && (e.message as Json | undefined)?.model !== '<synthetic>') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) {
    return undefined;
  }
  const msgId = ((entries[lastAssistant] as Json).message as Json).id;
  const pieces = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'assistant' && (e.message as Json | undefined)?.id === msgId);
  const dangling = pieces.flatMap(({ e }) => blocksOf((e.message as Json).content).filter((b) => b.type === 'tool_use' && !answered.has(String(b.id))).map((b) => String(b.id)));
  if (dangling.length === 0) {
    return undefined;
  }
  const first = Math.min(...pieces.map((x) => x.i));
  for (let i = first - 1; i >= 0; i -= 1) {
    const e = entries[i] as Json;
    if (typeof e.uuid === 'string' && e.type !== 'system' && e.type !== 'progress') {
      return { cutAt: e.uuid, toolUse: dangling[0] as string };
    }
  }
  return undefined;
}

function hooks(conv: () => Conv | undefined): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            const c = conv();
            const i = input as Json;
            if (c) {
              emit('tool-started', { conv: c.label, tool: i.tool_name });
              if (c.ending === 'tool-exec' && i.tool_name === 'Bash') {
                setTimeout(() => fire(c, '2 s after PreToolUse for Bash'), 2000);
              }
            }
            return { continue: true };
          },
        ],
      },
    ],
  };
}

function fire(c: Conv, how: string): void {
  if (c.fired || c.resultSeen || !c.ending) {
    return;
  }
  c.fired = true;
  c.interruptedByUs = true;
  emit('trigger', { conv: c.label, how, ending: c.ending });
  c.lin.event('trigger', { how, ending: c.ending });
  void c.run.interrupt().then(
    () => {},
    (err: unknown) => log(`interrupt ${c.label}: ${String(err)}`),
  );
}

async function serve(cmd: Json): Promise<void> {
  const label = String(cmd.conv);
  if (convs.has(label)) {
    throw new Error(`conv ${label} is already served`);
  }
  const dry = cmd.dry === true;
  const id = typeof cmd.id === 'string' ? cmd.id : randomUUID();
  const root = convRoot(AGENT, id, STATE_ROOT);

  // 1. Leftovers of earlier runs, before anything else.
  const stop = await stopLeftovers(AGENT, ownPids(), spec.ours ?? [], log);
  writeFileSync(join(RUN, `stop-${label}.json`), `${JSON.stringify(stop, null, 2)}\n`);
  emit('stopped', { conv: label, outcome: stop.outcome, ms: stop.ms, signals: stop.rounds.flatMap((r) => r.signals) });

  // 2. Tower, and this machine's records.
  const upto = typeof cmd.asOfSeq === 'number' ? cmd.asOfSeq : await lastSeq(tower);
  let towerBodies = (await towerMessages(tower, id, upto)) as unknown as TowerBody[];
  const towerCc = new Set(towerBodies.flatMap((b) => (b.ccEntries ?? []).map((c) => String(c.uuid))));
  const resumeDirs = recordedResumeDirs(AGENT_STATE).filter((d) => existsSync(d));
  const ts = transcripts([AGENT_DIR, ...resumeDirs], id);
  const local = union(ts);
  const localUuids = new Set(local.map((e) => e.uuid).filter((u): u is string => typeof u === 'string'));
  const inAgentDir = ts.some((t) => t.root === AGENT_DIR);
  const movedOn = local.length > 0 && [...towerCc].some((u) => !localUuids.has(u));

  // 3. Local record or tower.
  //
  // TODO: undecided. The rule: local when this agent's config dir holds the
  // conversation's transcript and every entry tower holds for it is in this
  // machine's records (agent dir and recorded resume dirs); tower otherwise
  // (moved on, or no transcript in the agent dir: a conversation first
  // resumed from tower here lives in /tmp/claude-resume-*, join 3). Fresh
  // when neither tower nor this machine has it.
  const from = typeof cmd.from === 'string' ? cmd.from : 'auto';
  let decision: 'fresh' | 'local' | 'tower' | 'record';
  if (from === 'tower') {
    decision = 'tower';
  } else if (from === 'record') {
    // TODO: undecided. A variant, not the settled rule: load() returns this
    // machine's own recording (the store's appends) instead of tower, a way
    // through for a conversation whose local record was a
    // /tmp/claude-resume-* dir the SDK deleted (join 3).
    decision = 'record';
  } else if (from === 'local') {
    decision = 'local';
  } else if (towerBodies.length === 0 && local.length === 0) {
    decision = 'fresh';
  } else if (inAgentDir && !movedOn) {
    decision = 'local';
  } else {
    decision = 'tower';
  }
  if (decision === 'tower' && towerBodies.length === 0) {
    throw new Error(`conv ${label} (${id}): tower holds nothing and the agent dir has no transcript`);
  }
  if (decision === 'record' && !currentLineage(root)) {
    throw new Error(`conv ${label} (${id}): no recording on this machine`);
  }
  if (decision === 'local' && !inAgentDir) {
    throw new Error(`conv ${label} (${id}): no transcript in ${AGENT_DIR}`);
  }

  // 4. Recovery, blind, into this machine's lineage, through its committer,
  // and never when tower has moved on (join 2). Skipped for a dry check
  // resume "as of" an earlier instant (test-only).
  let cur = currentLineage(root);
  let recovery: Json = { skipped: dry ? 'dry check' : 'no lineage and no local record' };
  if (!dry && movedOn) {
    const stale = cur ? local.filter((e) => !Lineage.open(cur as string).has(e)).length : local.length;
    recovery = { skipped: 'tower has moved on past this machine\'s record', staleLocalEntries: stale };
    log(`serve ${label}: tower moved on; ${stale} local entries not recovered (stale)`);
  } else if (!dry && local.length > 0) {
    if (!cur) {
      // TODO: undecided. A local record with no recording (state lost): a
      // new lineage, every local entry recovered into it; the committer
      // skips what tower already holds.
      const dir = join(root, `L${fileStamp()}-local`);
      Lineage.create(dir, { convId: id, name: label, origin: 'local', createdAt: iso(), model: spec.model });
      setCurrent(root, dir);
      cur = dir;
    }
    const lin = Lineage.open(cur);
    const committer = new Committer(lin, { convId: id, instanceId, dry: false, tower, log, variants: [...VARIANTS], onPublish: (p) => emit('published', { conv: label, ...pubSummary(p) }) });
    committer.seedPublished(towerBodies.filter((b) => !committer.published.has(String(b.id))) as unknown as Json[]);
    const missing = local.filter((e) => !lin.has(e));
    let prev = Date.now();
    for (const e of missing) {
      prev = instantOf(e, prev);
      lin.append({ sessionId: id, recovered: true }, [e], 'recovered', prev);
    }
    // Crash has no query end (design.md's Open, this proof's brief): a
    // SIGKILL never produces a `result`, so run+last/run+entry's tail
    // commit, which otherwise only fires at addResult(), would never fire.
    // Detected here, blind like the rest of recovery: the last say/turn this
    // lineage recorded has no matching result yet. TODO: undecided. Only a
    // heuristic (a genuinely still-running query on another machine would
    // look the same before it finishes; this machine only recovers a
    // lineage it itself owns, so that case shouldn't reach here, but this is
    // not proven). Deliberately not a closure event: see lineage.mts's
    // addTailTrigger.
    const lastSay = [...lin.says].sort((x, y) => x.ms - y.ms).at(-1);
    if (lastSay && !lin.resultsFull.some((r) => r.queryId === lastSay.queryId)) {
      const ms = Date.now();
      lin.addTailTrigger(ms, { queryId: lastSay.queryId });
      log(`serve ${label}: last run (query ${lastSay.queryId}) ended with no result; triggering the tail commit`);
      committer.poke();
    }
    await committer.drain();
    recovery = { roots: ts.map((t) => ({ root: t.root, lines: t.lines, unparseable: t.unparseable })), union: local.length, added: missing.length, addedTypes: missing.map((e) => String(e.type)), published: committer.order.length };
    log(`serve ${label}: recovery added ${missing.length} of ${local.length} local entries`);
    if (missing.length > 0) {
      towerBodies = (await towerMessages(tower, id, await lastSeq(tower))) as unknown as TowerBody[];
    }
  }

  // 5. The lineage this serve records into.
  let lin: Lineage;
  let loaded: ReturnType<typeof fromTower> | undefined;
  let held: { seq: number; entry: Json }[] = [];
  if (decision === 'tower') {
    if (VARIANTS.has('held-carrier')) {
      // The latest held record, less what tower's messages carry by now.
      const last = (await towerHeld(tower, id, upto)).at(-1);
      held = (((last?.body.entries as { seq: number; entry: Json }[] | undefined) ?? []).filter((h) => !towerCc.has(String(h.entry.uuid))));
    }
    loaded = fromTower(towerBodies, held);
  }
  if (dry) {
    const dir = join(root, `D${fileStamp()}-${typeof cmd.name === 'string' ? cmd.name : label}`);
    if (decision === 'local' || decision === 'record') {
      if (!cur) {
        throw new Error(`conv ${label}: a dry local check needs this machine's lineage`);
      }
      lin = Lineage.open(cur).copyAsOf(dir, typeof cmd.asOfMs === 'number' ? cmd.asOfMs : Number.POSITIVE_INFINITY, label);
    } else {
      lin = Lineage.create(dir, { convId: id, name: label, origin: 'dry', createdAt: iso(), model: spec.model, seededFromTower: { upto, messages: towerBodies.length, entries: loaded?.entries.length ?? 0 } });
    }
  } else if (decision === 'fresh') {
    const dir = join(root, `L${fileStamp()}-fresh`);
    lin = Lineage.create(dir, { convId: id, name: label, origin: 'fresh', createdAt: iso(), model: spec.model });
    setCurrent(root, dir);
  } else if (decision === 'local' || decision === 'record') {
    lin = Lineage.open(cur as string);
  } else {
    const dir = join(root, `L${fileStamp()}-tower`);
    lin = Lineage.create(dir, { convId: id, name: label, origin: 'tower', createdAt: iso(), model: spec.model, seededFromTower: { upto, messages: towerBodies.length, entries: loaded?.entries.length ?? 0 } });
    setCurrent(root, dir);
  }
  // Whether this call is what actually created (or is re-hydrating for the
  // first time) this lineage from tower: the only instant tower's content
  // is genuine prior history rather than this same lineage's own live
  // committer having since published its variant's take on it.
  const justSeededFromTower = loaded !== undefined && lin.rec.entries.length === 0;
  if (justSeededFromTower) {
    lin.seed({ sessionId: id, seed: 'tower' }, (loaded as NonNullable<typeof loaded>).seqd, Date.now() - 1);
  }
  const committer = new Committer(lin, { convId: id, instanceId, dry, tower, log, variants: [...VARIANTS], onPublish: (p) => emit(dry ? 'would-publish' : 'published', { conv: label, ...pubSummary(p) }) });
  if (decision === 'tower' || towerBodies.length > 0) {
    // The live committer legitimately reseeds from tower on every serve():
    // tower is real ground truth, and it must never republish what's
    // already there, however it got there.
    committer.seedPublished(towerBodies.filter((b) => !committer.published.has(String(b.id))) as unknown as Json[]);
  }
  // load-unbacked's rebuilt entries stand for blocks tower already holds.
  for (const u of loaded?.fabricated ?? []) {
    committer.carriedCc.add(u);
  }

  // The paired same-recording methodology (spec.pairedVariant, design.md's
  // Open, run+last vs run+entry): a second committer over the same Lineage,
  // always dry, a different build option, so both options are computed from
  // the identical recorded entries/requests/results rather than two live
  // model sessions whose nondeterminism would be indistinguishable from
  // variant divergence.
  //
  // The shadow's baseline is NOT `towerBodies` on every call the way the
  // live committer's is: after the first serve, tower holds the LIVE
  // committer's own publishes (this variant's take), and reseeding the
  // shadow from that on every restart would make it treat the other
  // variant's actual output as already landed, i.e. silently follow it
  // instead of independently computing its own. The shadow is seeded from
  // tower only once, at the same instant `lin.seed()` runs (this lineage's
  // genuine prior history, before either committer wrote anything into it);
  // every later run+last/run+entry difference then comes from the two
  // options over the SAME recorded entries, not from one variant leaking
  // into the other's carried set.
  let shadow: Committer | undefined;
  if (spec.pairedVariant) {
    shadow = new Committer(lin, { convId: id, instanceId, dry: true, tower, log, option: spec.pairedVariant as Option, filePrefix: `${spec.pairedVariant}-`, onPublish: (p) => emit('would-publish', { conv: label, variant: spec.pairedVariant, ...pubSummary(p) }) });
    if (justSeededFromTower) {
      shadow.seedPublished(towerBodies.filter((b) => !(shadow as Committer).published.has(String(b.id))) as unknown as Json[]);
    }
    for (const u of loaded?.fabricated ?? []) {
      shadow.carriedCc.add(u);
    }
  }

  // 6. resumeSessionAt: the last non-system entry of what's loaded, from the
  // recording (the local record's mirror) or tower's entries; or the
  // driver's "as of" override.
  const recordEntries = decision === 'record' ? lin.rec.entries.map((r) => r.entry) : undefined;
  let resumeAt = typeof cmd.resumeSessionAt === 'string' ? cmd.resumeSessionAt : decision === 'local' || decision === 'record' ? lastChain(lin.rec.entries.map((r) => r.entry)) : decision === 'tower' ? loaded?.lastChain : undefined;
  const cut = decision === 'tower' && loaded && VARIANTS.has('cut-dangling') && typeof cmd.resumeSessionAt !== 'string' ? danglingCut(loaded.entries) : undefined;
  if (cut) {
    resumeAt = cut.cutAt;
  }

  // TODO: undecided (Part B, way (b) for failure 3): materialise. A serve
  // from tower writes what load() gives into the agent dir's transcript (the
  // file Claude Code itself would keep there; a transcript already there is
  // copied to this agent's durable state first), then resumes from the agent
  // dir with load() returning null, so Claude Code's record of every
  // conversation this machine serves lives in the agent's reused config dir.
  let materialised: Json | undefined;
  if (decision === 'tower' && loaded && VARIANTS.has('materialise')) {
    const dir = join(AGENT_DIR, 'projects', PROJECT_KEY);
    const file = join(dir, `${id}.jsonl`);
    mkdirSync(dir, { recursive: true });
    let backup: string | null = null;
    if (existsSync(file)) {
      backup = join(AGENT_STATE, 'materialise-backups', `${fileStamp()}-${id}.jsonl`);
      mkdirSync(join(AGENT_STATE, 'materialise-backups'), { recursive: true });
      copyFileSync(file, backup);
    }
    writeFileSync(file, loaded.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    materialised = { file, entries: loaded.entries.length, backup };
    log(`serve ${label}: materialised ${loaded.entries.length} entries from tower into ${file}${backup ? ` (earlier transcript kept at ${backup})` : ''}`);
  }

  const store: SessionStore = {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      if (!key.subpath && conv) {
        onQueue(conv, entries as Json[]);
      }
      lin.append(key as unknown as Json, entries as Json[], 'live');
      committer.poke();
      shadow?.poke();
    },
    // Keyed on the session id alone: another agent's cwd gives another
    // projectKey for the same conversation.
    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      if (!key.subpath && recordEntries) {
        lin.event('store-load', { returned: recordEntries.length, from: 'record' });
        return recordEntries as SessionStoreEntry[];
      }
      if (key.subpath || decision !== 'tower' || !loaded || materialised) {
        lin.event('store-load', { subpath: key.subpath ?? null, returned: null, materialised: materialised !== undefined });
        return null;
      }
      lin.event('store-load', { returned: loaded.entries.length });
      return loaded.entries as SessionStoreEntry[];
    },
  };

  let conv: Conv | undefined;
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: privateHome,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(spec.maxTokens),
    OTEL_LOG_RAW_API_BODIES: `file:${lin.bodies}`,
    ...(spec.extraEnv ?? {}),
  };
  const options: HarnessOptions = {
    model: spec.model,
    thinking: spec.thinking,
    effort: spec.effort,
    systemPrompt: spec.systemPrompt,
    permissionMode: spec.permissionMode,
    // For the endings' triggers (test-only); changes nothing sent.
    includePartialMessages: true,
    // TODO: undecided. syncClaudeAiSkills false (proofs 19, 22 set it: the
    // account's claude.ai skills are not copied into the config dir).
    settings: { disableClaudeAiConnectors: true, syncClaudeAiSkills: false } as HarnessOptions['settings'],
    extraArgs: { 'setting-sources': 'user' },
    sessionStore: store,
    sessionStoreFlush: 'eager',
    spawnClaudeCodeProcess: spawnHook(
      {
        agent: AGENT,
        privateHome,
        prefixLog: join(RUN, 'prefix.log'),
        skills,
        log,
        onSpawn: (r) => {
          spawned.push(r);
          appendJsonl(join(RUN, 'spawns.jsonl'), r);
          if (!r.agentDir) {
            appendJsonl(join(AGENT_STATE, 'resume-dirs.jsonl'), { at: r.at, dir: r.configDir, conv: id, pid: r.pid });
          }
          emit('spawn', { conv: label, id, pid: r.pid, starttime: r.starttime, configDir: r.configDir, agentDir: r.agentDir, launcher: r.launcher, envNames: r.envNames });
        },
        onExit: (r) => {
          appendJsonl(join(RUN, 'spawns.jsonl'), { exit: r.pid, ...r.exited });
          emit('claude-exit', { conv: label, pid: r.pid, ...r.exited });
        },
      },
      label,
    ),
    hooks: hooks(() => conv),
    env,
    ...(decision === 'fresh' ? { sessionId: id } : { resume: id, ...(resumeAt ? { resumeSessionAt: resumeAt } : {}) }),
  };
  // TODO: undecided. A fresh conversation's id: minted here and passed as
  // the SDK's sessionId (so the lineage and its body log exist before
  // Claude Code starts); the alternative is to read it from init.
  const run = startRun({ name: AGENT, options });
  conv = {
    label,
    id,
    dry,
    decision,
    lin,
    committer,
    shadow,
    run,
    busy: false,
    queryId: '',
    sayText: '',
    sayMs: 0,
    lastResultMs: Date.now(),
    queue: [],
    turn: undefined,
    sayStarted: false,
    interruptedByUs: false,
    fired: false,
    resultSeen: false,
    stream: { thinkingOpen: false, textChars: 0, inputChars: 0 },
    loop: Promise.resolve(),
    exited: false,
  };
  convs.set(label, conv);
  const c = conv;
  const variantsInfo: Json = { variants: [...VARIANTS], ...(held.length ? { held: held.map((h) => String(h.entry.uuid)) } : {}), ...(loaded?.fabricated.length ? { fabricated: loaded.fabricated } : {}), ...(cut ? { cut } : {}), ...(materialised ? { materialised } : {}) };
  lin.event('serve', { instanceId, runDir: run.dir, decision, from, dry, movedOn, upto, resumeSessionAt: resumeAt ?? null, recovery, towerMessages: towerBodies.length, localEntries: local.length, inAgentDir, ...variantsInfo });
  c.loop = messagesLoop(c);
  committer.poke();
  shadow?.poke();
  emit('served', { conv: label, id, decision, dry, movedOn, lineage: lin.dir, harnessRun: run.dir, resumeSessionAt: resumeAt ?? null, towerUpto: upto, towerMessages: towerBodies.length, localEntries: local.length, inAgentDir, recovery, ...variantsInfo });
}

function pubSummary(p: PublishedLine): Json {
  return { kind: p.kind, seq: p.seq, id: p.id, commitMs: p.commitMs, queryId: p.queryId, index: p.index ?? null };
}

const USAGE_LIMIT = /usage limit|rate[_ ]limit|429/i;

async function messagesLoop(c: Conv): Promise<void> {
  try {
    for await (const message of c.run.messages()) {
      const m = message as SDKMessage & Json;
      if (m.type === 'system' && m.subtype === 'init') {
        c.lin.event('init', { session_id: m.session_id, model: m.model, permissionMode: m.permissionMode, apiKeySource: m.apiKeySource, cwd: m.cwd, skills: m.skills, tools: Array.isArray(m.tools) ? (m.tools as unknown[]).length : null, mcp: m.mcp_servers });
        emit('init', { conv: c.label, sessionId: m.session_id, apiKeySource: m.apiKeySource, skills: m.skills, permissionMode: m.permissionMode });
        if (m.session_id !== c.id) {
          log(`conv ${c.label}: init session ${String(m.session_id)} is not ${c.id}`);
        }
      }
      if (m.type === 'system' && m.subtype === 'api_retry') {
        c.lin.event('api-retry', { attempt: m.attempt, status: m.error_status, error: m.error });
        if (m.error_status === 429) {
          emit('usage-limit', { conv: c.label, status: 429, error: m.error });
        }
      }
      if (m.type === 'stream_event' && (m.parent_tool_use_id ?? null) === null && c.busy && c.ending) {
        const e = m.event as unknown as Json;
        const block = e.content_block as Json | undefined;
        const delta = e.delta as Json | undefined;
        if (e.type === 'content_block_start' && block?.type === 'thinking') {
          c.stream.thinkingOpen = true;
          if (c.ending === 'thinking') {
            setTimeout(() => (c.stream.thinkingOpen ? fire(c, '700 ms into an open thinking block') : c.lin.event('trigger-missed')), 700);
          }
        }
        if (e.type === 'content_block_stop') {
          c.stream.thinkingOpen = false;
        }
        if (e.type === 'content_block_delta' && delta?.type === 'text_delta') {
          c.stream.textChars += String(delta.text ?? '').length;
          if (c.ending === 'mid-text' && c.stream.textChars >= 60) {
            fire(c, `${c.stream.textChars} text characters streamed`);
          }
        }
        if (e.type === 'content_block_delta' && delta?.type === 'input_json_delta') {
          c.stream.inputChars += String(delta.partial_json ?? '').length;
          if (c.ending === 'tool-input' && c.stream.inputChars >= 100) {
            fire(c, `${c.stream.inputChars} tool input characters streamed`);
          }
        }
      }
      if (m.type === 'result') {
        const ms = Date.now();
        // The turn this result closes: the one the queue entries opened
        // (onQueue); with none seen, the pending say's if a say is pending,
        // else a turn Claude Code started itself.
        const turn = c.turn ?? (c.busy ? { queryId: c.queryId, self: false } : { queryId: randomUUID(), self: true });
        c.turn = undefined;
        const self = turn.self;
        const queryId = turn.queryId;
        if (self) {
          if (c.busy) {
            // The pending say's id resumes after this result.
            c.lin.addTurn({ ms: ms + 1, queryId: c.queryId, text: c.sayText }, { resumes: 'pending say' });
          }
        } else {
          c.resultSeen = true;
          c.busy = false;
          clearInterval(c.firstByteTimer);
        }
        c.lastResultMs = ms;
        const subtype = String(m.subtype);
        const reason = !self && c.interruptedByUs ? 'cancelled' : subtype === 'success' ? 'completed' : 'aborted';
        const text = typeof m.result === 'string' ? m.result : JSON.stringify(m.errors ?? null);
        c.lin.addResult({ ms, queryId, subtype, reason }, { isError: m.is_error, step: self ? null : (c.step ?? null), selfStarted: self, numTurns: m.num_turns ?? null, stopReason: m.stop_reason ?? null, permissionDenials: m.permission_denials ?? null, usage: m.usage ?? null, text: String(text).slice(0, 400) });
        c.committer.poke();
        c.shadow?.poke();
        emit('result', { conv: c.label, queryId, step: self ? null : (c.step ?? null), selfStarted: self, subtype, reason, isError: m.is_error, numTurns: m.num_turns ?? null, text: String(text).slice(0, 300), permissionDenials: m.permission_denials ?? null, stopReason: m.stop_reason ?? null });
        if (m.is_error === true && USAGE_LIMIT.test(String(text))) {
          emit('usage-limit', { conv: c.label, text: String(text).slice(0, 300) });
        }
      }
    }
  } catch (err) {
    log(`conv ${c.label}: messages: ${String(err)}`);
    c.lin.event('messages-error', { error: String(err) });
  }
  try {
    await c.run.done;
  } catch (err) {
    c.lin.event('run-done-error', { error: String(err) });
    log(`conv ${c.label}: run.done: ${String(err)}`);
  }
  c.exited = true;
  await c.committer.drain();
  await c.shadow?.drain();
  clearInterval(c.firstByteTimer);
  emit('query-ended', { conv: c.label, id: c.id });
}

// Turns Claude Code starts itself (a background task's notification, or one
// queued by a killed run and replayed on resume): the participant mints
// their queryId (design record, 26 Sep), from the turn's start, so its reply
// pieces (committed at their append, before the turn's result) carry it.
//
// TODO: undecided. How such a turn is told apart: built on Claude Code's own
// queue entries (mirrored to the store in order): `enqueue` carries the
// command's text, `dequeue` takes the oldest; the first dequeue after a
// result starts a turn, the say's if it takes the pending say's text, else
// one Claude Code started itself. Pros: only what Claude Code writes, no
// change to what is sent, and ordered with the turn's own entries. Cons:
// relies on queue-operation entries (bookkeeping Claude Code may change) and
// on the say's text coming back unchanged; a say merged into a turn Claude
// Code started gets no result of its own. Alternatives: a uuid on each sent
// message with Claude Code's command_lifecycle frames (@internal in 2.1.282,
// not seen on this SDK stream), or --replay-user-messages.
function onQueue(c: Conv, entries: Json[]): void {
  for (const e of entries) {
    if (e.type !== 'queue-operation') {
      continue;
    }
    if (e.operation === 'enqueue') {
      c.queue.push(typeof e.content === 'string' ? e.content : JSON.stringify(e.content ?? null));
      continue;
    }
    if (e.operation !== 'dequeue') {
      continue;
    }
    const item = c.queue.shift();
    const isSay = c.busy && !c.sayStarted && item === c.sayText;
    if (isSay) {
      c.sayStarted = true;
    }
    if (c.turn) {
      continue; // merged into the running turn
    }
    if (isSay) {
      c.turn = { queryId: c.queryId, self: false };
    } else {
      const queryId = randomUUID();
      c.turn = { queryId, self: true };
      c.lin.addTurn({ ms: Date.now(), queryId, text: '' }, { self: true, command: String(item ?? '').slice(0, 120) });
      emit('self-turn', { conv: c.label, queryId, command: String(item ?? '').slice(0, 120) });
    }
  }
}

function say(cmd: Json): void {
  const c = convs.get(String(cmd.conv));
  if (!c || c.exited) {
    throw new Error(`conv ${String(cmd.conv)} is not served`);
  }
  // A say while a query runs is rejected (design.md, The protocol).
  if (c.busy) {
    emit('say-rejected', { conv: c.label, reason: 'busy' });
    return;
  }
  const text = String(cmd.text);
  c.queryId = randomUUID();
  c.sayText = text;
  c.sayStarted = false;
  c.busy = true;
  c.interruptedByUs = false;
  c.fired = false;
  c.resultSeen = false;
  c.ending = typeof cmd.ending === 'string' ? (cmd.ending as Ending) : undefined;
  c.step = typeof cmd.step === 'number' ? cmd.step : undefined;
  c.stream = { thinkingOpen: false, textChars: 0, inputChars: 0 };
  const ms = Date.now();
  c.sayMs = ms;
  c.lin.addSay({ ms, queryId: c.queryId, text }, { step: c.step ?? null, ending: c.ending ?? null });
  if (c.ending === 'first-byte') {
    // The request file carrying the prompt: interrupt before any reply byte.
    const seen = new Set<string>();
    const want = text.slice(0, 30);
    c.firstByteTimer = setInterval(() => {
      let names: string[] = [];
      try {
        names = readdirSync(c.lin.bodies);
      } catch {
        return;
      }
      for (const f of names) {
        if (seen.has(f) || !f.endsWith('.request.json')) {
          continue;
        }
        let body: Json;
        try {
          body = JSON.parse(readFileSync(join(c.lin.bodies, f), 'utf8')) as Json;
        } catch {
          continue;
        }
        seen.add(f);
        const mainLoop = (body.thread !== undefined && body.thread !== null) || (Array.isArray(body.tools) && body.tools.length > 0);
        if (String(body.model).startsWith(spec.model) && body.thinking !== undefined && mainLoop && JSON.stringify(body.messages ?? []).includes(want)) {
          fire(c, `request file ${f}`);
        }
      }
    }, 5);
  }
  c.run.send(user(text));
  emit('sent', { conv: c.label, queryId: c.queryId, step: c.step ?? null, ending: c.ending ?? null });
}

async function end(label: string): Promise<void> {
  const c = convs.get(label);
  if (!c) {
    return;
  }
  if (!c.exited) {
    c.run.end();
  }
  await c.loop;
  emit('ended', { conv: label, id: c.id, published: c.committer.order.length, failed: c.committer.failed ? String(c.committer.failed) : null });
}

// ---------------------------------------------------------------------------
// Shutdown (design.md, Shutdown).

let presses = 0;
let shuttingDown: Promise<void> | undefined;

async function graceful(why: string): Promise<void> {
  log(`shutdown (first press: ${why}): interrupt, then drain`);
  emit('shutdown-started', { why });
  for (const c of convs.values()) {
    if (c.busy && !c.exited) {
      c.interruptedByUs = true;
      try {
        await c.run.interrupt();
      } catch (err) {
        log(`interrupt ${c.label}: ${String(err)}`);
      }
    }
  }
  // Wait for each query's result, then close its input, then its exit and
  // the commits.
  for (const c of convs.values()) {
    const t0 = Date.now();
    while (c.busy && !c.exited && Date.now() - t0 < 60_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await end(c.label);
  }
  await tower.nc.drain();
  // Give the SDK time to remove the /tmp/claude-resume-* dirs it made (it
  // does so once its Claude Code has exited); exiting at once cut that off.
  const resumeDirs = spawned.filter((s) => !s.agentDir).map((s) => s.configDir);
  const t0 = Date.now();
  while (resumeDirs.some((d) => existsSync(d)) && Date.now() - t0 < 10_000) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const left = resumeDirs.filter((d) => existsSync(d));
  emit('shutdown-done', { published: Object.fromEntries([...convs.values()].map((c) => [c.label, c.committer.order.length])), resumeDirs: resumeDirs.length, resumeDirsLeft: left, waitedMs: Date.now() - t0 });
  process.exit(0);
}

function teardown(): void {
  log('shutdown (second press): tear down');
  for (const s of spawned) {
    if (!s.exited) {
      signalChecked({ pid: s.pid, starttime: s.starttime }, 'SIGTERM', log);
    }
  }
  void tower.nc.close();
  setTimeout(() => process.exit(1), 2000).unref();
}

function press(why: string): void {
  presses += 1;
  if (presses === 1) {
    shuttingDown = graceful(why);
  } else if (presses === 2) {
    teardown();
  } else {
    process.exit(1);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => press(sig));
}

// ---------------------------------------------------------------------------

tower = await openTower();
writeFileSync(join(RUN, 'spec.json'), `${clean(JSON.stringify({ ...spec, instanceId, privateHome, setpriv: SETPRIV, pid: process.pid, starttime: me?.starttime }, null, 2))}\n`);
emit('ready', { starttime: me?.starttime, instanceId, privateHome, setpriv: SETPRIV, runDir: RUN });

let queue: Promise<void> = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  let cmd: Json;
  try {
    cmd = JSON.parse(line) as Json;
  } catch {
    emit('error', { message: `not JSON: ${line.slice(0, 80)}` });
    return;
  }
  const run = async (): Promise<void> => {
    try {
      switch (cmd.cmd) {
        case 'serve':
          await serve(cmd);
          break;
        case 'say':
          say(cmd);
          break;
        case 'interrupt': {
          const c = convs.get(String(cmd.conv));
          if (c && c.busy) {
            c.interruptedByUs = true;
            await c.run.interrupt();
          }
          emit('interrupted', { conv: cmd.conv });
          break;
        }
        case 'end':
          await end(String(cmd.conv));
          break;
        case 'flag': {
          // Test-only: a cell's trigger changed live for one step, through
          // Claude Code's session-scoped flag settings layer (the SDK's
          // applyFlagSettings); e.g. {env: {CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64'}}.
          const c = convs.get(String(cmd.conv));
          if (!c || c.exited) {
            throw new Error(`conv ${String(cmd.conv)} is not served`);
          }
          await c.run.query.applyFlagSettings(cmd.settings as never);
          c.lin.event('flag-settings', { settings: cmd.settings as Json });
          emit('flagged', { conv: c.label, settings: cmd.settings as Json });
          break;
        }
        case 'skills':
          skills.set((cmd.declared as string[]) ?? [], 'live');
          emit('skills', { declared: skills.declared, linked: [...skills.linked] });
          break;
        case 'ours':
          // Test-only: the driver extends the safety list (Claude Codes this
          // proof started that were spawned after this process's spec was
          // written).
          spec.ours = [...(spec.ours ?? []), ...((cmd.add as Known[]) ?? [])];
          emit('ours', { count: spec.ours.length });
          break;
        case 'shutdown':
          press('shutdown command');
          break;
        default:
          emit('error', { message: `unknown command ${String(cmd.cmd)}` });
      }
    } catch (err) {
      log(`command ${String(cmd.cmd)}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      emit('error', { cmd: cmd.cmd, conv: cmd.conv ?? null, message: err instanceof Error ? err.message : String(err) });
    }
  };
  // serve, end and skills in order; say and interrupt at once.
  if (cmd.cmd === 'say' || cmd.cmd === 'interrupt' || cmd.cmd === 'shutdown' || cmd.cmd === 'ours') {
    void run();
  } else {
    queue = queue.then(run);
  }
});
rl.on('close', () => {
  if (!shuttingDown) {
    press('stdin closed');
  }
});
