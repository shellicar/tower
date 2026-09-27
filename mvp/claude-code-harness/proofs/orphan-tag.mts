// Proof 25: does tagging each Claude Code close proof 21's gap?
//
// Built on proof 21 (proofs/orphans.mts, brought in from proof-21-orphans):
// its participant, driver, store, layer 1 (setpriv --pdeathsig SIGINT), proof
// 17's blind recovery check (check(), unchanged apart from also reporting
// what the tag scan sees), its transcript keeper and its scoring.
//
// Proof 21's layer 2 found a leftover Claude Code by its sessions/<pid>.json,
// which Claude Code deletes 3-27 ms after SIGINT or SIGTERM while it runs on
// for ~2.5 s. What is new here:
//
// The tag: every Claude Code the participant starts gets TOWER_AGENT=<agent
// name> added to its environment in spawnClaudeCodeProcess (spawnWith). The
// participant's own environment never carries it. /proc/<pid>/environ holds a
// process's environment as it was at exec, readable for our own processes.
//
// The tag stop (stopTagged), before serving, in the participant:
//   1. find every process whose environment holds exactly TOWER_AGENT=<name>
//      and that this participant didn't start (scanTag)
//   2. send SIGINT to each still running normally
//   3. wait until every one found has exited; scan again, until a scan finds
//      none
//   4. run proof 17's recovery check
//   5. serve.
//
// TODO: undecided. What "running normally" means (step 2). Built: the
// easiest, its sessions/<pid>.json, in the CLAUDE_CONFIG_DIR its environment
// names, exists and its procStart matches /proc. So a Claude Code already
// shutting down is not signalled again, except one caught in the few ms
// before it deletes its pid file (see the pd-double case for what a second
// SIGINT does). The alternative is SIGINT to every tagged Claude Code.
//
// TODO: undecided. What is signalled and what is waited for. Built: SIGINT
// only to a tagged process with a live pid file (a Claude Code); the wait
// covers every tagged process found, Claude Code's own children (tools)
// included, since they inherit the tag.
//
// TODO: undecided. How the participant tells its own tagged processes from
// leftovers. Built: the easiest, it excludes each pid it spawned and every
// descendant of one (a /proc ppid walk at scan time). The tag value names
// the agent only. The alternative is a per-participant value alongside it.
//
// TODO: undecided. A same-uid process whose environ can't be read. The first
// r1 run caught a Claude Code, still running (state R), whose environ read
// EACCES 8 ms before its last thread exited, so its tag can't be seen in the
// last moments of its exit. Built: the easiest, such a process is recorded
// (ownUidUnreadable) and otherwise ignored. The alternative is to wait for
// any unreadable same-uid process that wasn't unreadable at baseline.
//
// "Exited" means every thread has exited: a zombie thread-group leader with
// other threads still listed in /proc/<pid>/task is still running (gone()).
//
// TODO: undecided (as proof 21). What happens if a leftover hasn't exited
// long after SIGINT. Built: the easiest, wait STOP_WAIT_MS (30 s, a value
// picked for this proof), then log it and serve anyway.
//
// TODO: undecided (as proof 21). What happens when setpriv isn't available.
// Built: nothing; the spawn fails (ENOENT) and that conversation's query
// errors. The tag doesn't depend on setpriv.
//
// TODO: undecided (as proof 21). Where the store lives. Built: a file store,
// one JSONL file per session key under STORE_DIR.
//
// The scan reads every same-uid process's environment. It keeps nothing from
// one that doesn't carry the tag; from one that does it keeps only
// CLAUDE_CONFIG_DIR (a path), to find its pid file.
//
// Cases (store resume only; each fresh and resumed; each serve holds one
// conversation mid-reply, R, and one mid-tool, T, inside a 60 s `sleep`):
//   Proof 21's eight, with the tag stop in place of the pid-file stop:
//   stop, kill, crash, pd-stop, pd-kill, pd-crash, crash-stop, pd-crash-stop
//   (pd- = layer 1; kill = SIGKILL; crash = uncaught exception; -stop =
//   served again at once by a participant started after the death, as proof
//   21; otherwise served once every leftover has exited on its own).
//   <case>-now, for the four -stop cases: the serve 2 participant is started
//   before the death, with its modules loaded, and blocked on stdin; the
//   driver writes GO the moment it sees the old participant exit. No startup
//   delay to hide behind.
//   pf-<case>-now, for pd-stop, crash-stop, pd-crash-stop: the same, with
//   proof 21's pid-file stop (stopLive) instead of the tag stop. The control.
//   pd-double: layer 1, SIGKILL, and the driver sends every held Claude Code a
//   second SIGINT as soon as it sees the participant exit; served once they
//   have exited. What a second SIGINT to one already shutting down does.
// Every case serves each conversation twice (serve 2 and serve 3) and scores
// each serve's first request against every transcript line the driver saw.
//
// The reset guard: the same tag scan, for an agent name, refusing while any
// tagged process is alive (proofs/tag-guard.mts, read-only: it never
// deletes). The driver samples it, and the harness's own guard
// (liveClaudeCodes on config-dirs/<name>), side by side every 20 ms from
// before the death until every process of the old participant's tree has
// exited, and runs the standalone script (a process that is no ancestor of
// the Claude Codes) every ~250 ms. Each case's clean start runs tag-guard and
// then `pnpm reset-config-dir`.
//
// Proof-only safety gate (not the participant's design): before a SIGINT the
// pid and its start time must be on the `ours` list the driver passes in (the
// Claude Codes this proof started in this case), checked against /proc just
// before sending. Refusals are logged.
//
// Modes (from mvp/claude-code-harness/):
//   participant <spec.json>
//   case <model> <case> <fresh|resumed>

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSessionToStore, type SDKUserMessage, type SessionKey, type SessionStore, type SessionStoreEntry, type SpawnedProcess, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { liveClaudeCodes } from '../src/harness.mts';
import { LineRecorder, redact } from '../src/record.mts';
import { scanTag, type TagScan } from './tag-scan.mts';

// Wall clock, to the millisecond, in every process (proof 7: the harness's
// stamp() drifts 140-170 ms from it on this machine).
const stamp = (): string => new Date().toISOString();

const SCRIPT = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = join(dirname(SCRIPT), '..');
const RUNS = join(PACKAGE_ROOT, 'runs');
const STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const DEBUG_ROOT = join(STATE, 'debug');
const BODIES_ROOT = join(STATE, 'api-bodies');

// The participant's own config.
const STORE_DIR = join(STATE, 'stores', 'proof-25-orphan-tag');
const CONFIG_DIRS_ROOT = join(STATE, 'config-dirs');
const RUN_NAME = 'orphans-25';
// The tag: TAG_KEY=RUN_NAME in every Claude Code's environment.
const TAG_KEY = 'TOWER_AGENT';
const GUARD_SCRIPT = join(dirname(SCRIPT), 'tag-guard.mts');
const AGENT_CONFIG_DIR = join(CONFIG_DIRS_ROOT, RUN_NAME);
const WORK = join(STATE, 'work', RUN_NAME);

const TOOL_SLEEP_S = 60;
const REPLY_CHARS = 300;
const TOOL_DELAY_MS = 500;
// TODO: undecided (see the header): how long the stop waits after SIGINT.
const STOP_WAIT_MS = 30_000;
// Scan, signal, wait, at most this many times before serving anyway.
const STOP_ROUNDS = 5;

type Json = Record<string, unknown>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const later = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms).unref();
  });

function sha(path: string): string | null {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16) : null;
}

function readJsonl(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  const out: Json[] = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (l.trim() === '') {
      continue;
    }
    try {
      out.push(JSON.parse(l) as Json);
    } catch {}
  }
  return out;
}

function canon(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canon).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Json;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function entryId(e: Json): string {
  return typeof e.uuid === 'string' ? `uuid:${e.uuid}` : `content:${canon(e)}`;
}

function describeEntry(e: Json): string {
  const msg = e.message as Json | undefined;
  let what = String(e.type);
  const att = e.attachment as Json | undefined;
  if (att) {
    what += `/${String(att.type)}`;
  }
  if (e.subtype) {
    what += `/${String(e.subtype)}`;
  }
  const content = msg?.content;
  if (typeof content === 'string') {
    what += ` "${content.slice(0, 50).replace(/\n/g, '\\n')}"`;
  } else if (Array.isArray(content)) {
    what += ` [${content
      .map((b: Json) => {
        if (b.type === 'text') {
          const t = String(b.text);
          return `text "${t.slice(0, 30).replace(/\n/g, '\\n')}${t.length > 30 ? `...${t.slice(-20).replace(/\n/g, '\\n')}` : ''}"(${t.length})`;
        }
        if (b.type === 'tool_use') {
          return `tool_use ${String(b.name)}`;
        }
        if (b.type === 'tool_result') {
          return `tool_result${b.is_error ? ' is_error' : ''} ${JSON.stringify(b.content).slice(0, 40)}`;
        }
        return String(b.type);
      })
      .join(' | ')}]`;
  }
  if (e.isAbortedMidStream) {
    what += ' isAbortedMidStream';
  }
  return what;
}

// /proc/<pid>/stat: fields after the parenthesised comm; starttime is field 22
// (index 19 after state).
function procStat(pid: number): { state: string; ppid: number; pgid: number; starttime: string } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0] ?? '?', ppid: Number(f[1]), pgid: Number(f[2]), starttime: f[19] ?? '?' };
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  const s = procStat(pid);
  return s !== undefined && s.state !== 'Z' && s.state !== 'X';
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

function descendants(pid: number): { pid: number; cmd: string }[] {
  const byParent = new Map<number, number[]>();
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) {
      continue;
    }
    const s = procStat(Number(n));
    if (s) {
      byParent.set(s.ppid, [...(byParent.get(s.ppid) ?? []), Number(n)]);
    }
  }
  const out: { pid: number; cmd: string }[] = [];
  const walk = (p: number): void => {
    for (const k of byParent.get(p) ?? []) {
      out.push({ pid: k, cmd: cmdline(k).slice(0, 120) });
      walk(k);
    }
  };
  walk(pid);
  return out;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

function resumeDirs(): string[] {
  try {
    return readdirSync(tmpdir())
      .filter((n) => n.startsWith('claude-resume-'))
      .map((n) => join(tmpdir(), n));
  } catch {
    return [];
  }
}

class Recorder {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  write(value: unknown): void {
    appendFileSync(this.path, `${redact(typeof value === 'string' ? value : JSON.stringify(value)).text}\n`);
  }
}

function makeLog(rec: Recorder, prefix = ''): (s: string) => void {
  return (s: string): void => {
    const line = `${stamp()} ${prefix}${s}`;
    process.stdout.write(`${line}\n`);
    rec.write(line);
  };
}

// ---------------------------------------------------------------------------
// The store: one JSONL file per session key under STORE_DIR.

function storeFile(key: SessionKey): string {
  return join(STORE_DIR, key.projectKey, `${key.sessionId}${key.subpath ? `/${key.subpath}` : ''}.jsonl`);
}

class Store implements SessionStore {
  readonly rec: Recorder;
  calls = 0;
  constructor(recPath: string) {
    this.rec = new Recorder(recPath);
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.calls += 1;
    this.rec.write({ ts: stamp(), call: this.calls, key, count: entries.length, uuids: entries.map((e) => (e as Json).uuid ?? null) });
    const f = storeFile(key);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const f = storeFile(key);
    const found = existsSync(f);
    this.rec.write({ ts: stamp(), event: 'load', key, found, lines: found ? readJsonl(f).length : 0 });
    return found ? (readJsonl(f) as SessionStoreEntry[]) : null;
  }
}

// ---------------------------------------------------------------------------
// The check. Knows the session id and the participant's own config, nothing
// else.

interface Transcript {
  root: string;
  file: string;
  bytes: number;
  lines: number;
  unparseable: number;
  mtime: string;
  ageMs: number;
  sha: string | null;
  imported: number;
  importError?: string;
}

interface PidFile {
  root: string;
  file: string;
  pid: number;
  procStart: string;
  status: unknown;
  updatedAt: unknown;
  pidAlive: boolean;
  starttimeNow: string | null;
  sameProcess: boolean;
}

export interface CheckReport {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  tagAtStart: number[];
  tagAtEnd: number[];
  ms: number;
  rootsSearched: number;
  transcripts: Transcript[];
  pidFiles: PidFile[];
  runningBySessionPidFile: number[];
  runningByCmdline: number[];
  unionEntries: number;
  keys: { key: SessionKey; storeFile: string; storeBefore: number; storeShaBefore: string | null; missing: number; missingBytes: number; storeAfter: number; storeShaAfter: string | null; added: string[] }[];
  transcriptsUnchanged: boolean;
  orphanPolicy: string;
}

async function check(sessionId: string, log: (s: string) => void): Promise<CheckReport> {
  const startedAt = stamp();
  const t0 = performance.now();
  // Proof 25: anything carrying the tag (not this participant's own) as the
  // check starts, and again as it ends.
  const tagAtStart = scanTag(RUN_NAME, ownRoots()).found.map((p) => p.pid);
  const roots = [...subdirs(CONFIG_DIRS_ROOT), ...resumeDirs()];
  const transcripts: Transcript[] = [];
  const pidFiles: PidFile[] = [];
  for (const root of roots) {
    for (const project of subdirs(join(root, 'projects'))) {
      const file = join(project, `${sessionId}.jsonl`);
      if (!existsSync(file)) {
        continue;
      }
      const raw = readFileSync(file, 'utf8');
      const ls = raw.split('\n').filter((l) => l.trim() !== '');
      let unparseable = 0;
      for (const l of ls) {
        try {
          JSON.parse(l);
        } catch {
          unparseable += 1;
        }
      }
      const st = statSync(file);
      transcripts.push({ root, file, bytes: st.size, lines: ls.length, unparseable, mtime: st.mtime.toISOString(), ageMs: Date.now() - st.mtimeMs, sha: sha(file), imported: 0 });
    }
    // Claude Code's own record of a running session: sessions/<pid>.json.
    // Only the .json files are read (a .key file sits beside each).
    const sessions = join(root, 'sessions');
    let names: string[] = [];
    try {
      names = readdirSync(sessions).filter((n) => /^\d+\.json$/.test(n));
    } catch {}
    for (const n of names) {
      let d: Json;
      try {
        d = JSON.parse(readFileSync(join(sessions, n), 'utf8')) as Json;
      } catch {
        continue;
      }
      if (d.sessionId !== sessionId) {
        continue;
      }
      const pid = Number(d.pid);
      const st = procStat(pid);
      const pidAlive = alive(pid);
      pidFiles.push({ root, file: join(sessions, n), pid, procStart: String(d.procStart), status: d.status, updatedAt: d.updatedAt, pidAlive, starttimeNow: st?.starttime ?? null, sameProcess: pidAlive && st?.starttime === String(d.procStart) });
    }
  }
  // Any process whose command line names the session (a resumed Claude Code
  // carries --resume=<id>; a fresh one carries no id).
  const runningByCmdline: number[] = [];
  for (const n of readdirSync('/proc')) {
    if (/^\d+$/.test(n) && Number(n) !== process.pid && cmdline(Number(n)).includes(sessionId)) {
      runningByCmdline.push(Number(n));
    }
  }
  const runningBySessionPidFile = pidFiles.filter((p) => p.sameProcess).map((p) => p.pid);
  const orphanPolicy = runningBySessionPidFile.length > 0 || runningByCmdline.length > 0 ? 'found running; served anyway (TODO: undecided)' : 'none found';

  // Read each transcript with the SDK's importSessionToStore (it looks under
  // CLAUDE_CONFIG_DIR), oldest first, into one union.
  transcripts.sort((a, b) => a.mtime.localeCompare(b.mtime));
  const union = new Map<string, { key: SessionKey; entries: Map<string, SessionStoreEntry> }>();
  const saved = process.env.CLAUDE_CONFIG_DIR;
  for (const t of transcripts) {
    const collector: SessionStore = {
      append: async (key: SessionKey, entries: SessionStoreEntry[]) => {
        const k = JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null]);
        const slot = union.get(k) ?? { key, entries: new Map() };
        union.set(k, slot);
        for (const e of entries) {
          t.imported += 1;
          const id = entryId(e as Json);
          if (!slot.entries.has(id)) {
            slot.entries.set(id, e);
          }
        }
      },
      load: async () => null,
    };
    process.env.CLAUDE_CONFIG_DIR = t.root;
    try {
      await importSessionToStore(sessionId, collector, { dir: WORK, includeSubagents: true });
    } catch (err) {
      t.importError = err instanceof Error ? err.message : String(err);
    } finally {
      if (saved === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = saved;
      }
    }
  }
  const keys: CheckReport['keys'] = [];
  let unionEntries = 0;
  for (const { key, entries } of union.values()) {
    unionEntries += entries.size;
    const f = storeFile(key);
    const inStore = readJsonl(f);
    const storeShaBefore = sha(f);
    const have = new Map<string, number>();
    for (const e of inStore) {
      have.set(entryId(e), (have.get(entryId(e)) ?? 0) + 1);
    }
    const missing = [...entries.entries()].filter(([id]) => !have.has(id)).map(([, e]) => e);
    if (missing.length > 0) {
      mkdirSync(dirname(f), { recursive: true });
      appendFileSync(f, missing.map((e) => `${JSON.stringify(e)}\n`).join(''));
    }
    keys.push({
      key,
      storeFile: f,
      storeBefore: inStore.length,
      storeShaBefore,
      missing: missing.length,
      missingBytes: missing.reduce((n, e) => n + JSON.stringify(e).length + 1, 0),
      storeAfter: readJsonl(f).length,
      storeShaAfter: sha(f),
      added: missing.map((e) => `${String((e as Json).uuid ?? '-')} ${describeEntry(e as Json).slice(0, 110)}`),
    });
  }
  const transcriptsUnchanged = transcripts.every((t) => sha(t.file) === t.sha);
  const tagAtEnd = scanTag(RUN_NAME, ownRoots()).found.map((p) => p.pid);
  const report: CheckReport = {
    sessionId,
    startedAt,
    endedAt: stamp(),
    tagAtStart,
    tagAtEnd,
    ms: Math.round(performance.now() - t0),
    rootsSearched: roots.length,
    transcripts,
    pidFiles,
    runningBySessionPidFile,
    runningByCmdline,
    unionEntries,
    keys,
    transcriptsUnchanged,
    orphanPolicy,
  };
  log(
    `check ${sessionId}: ${roots.length} roots in ${report.ms} ms; ${transcripts.length} transcript(s) [${transcripts.map((t) => `${t.root.startsWith(tmpdir()) ? basename(t.root) : `config-dirs/${basename(t.root)}`} ${t.lines} lines${t.unparseable ? ` ${t.unparseable} unparseable` : ''} imported ${t.imported}`).join('; ')}]; pid files ${JSON.stringify(pidFiles.map((p) => ({ pid: p.pid, alive: p.pidAlive, same: p.sameProcess, status: p.status })))}; cmdline ${JSON.stringify(runningByCmdline)}; tagged at start ${JSON.stringify(tagAtStart)} end ${JSON.stringify(tagAtEnd)}; union ${unionEntries}; ${keys.map((k) => `store ${k.storeBefore} -> ${k.storeAfter} (+${k.missing})`).join(', ')}; orphan: ${orphanPolicy}`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// Signals. Only ever to a process this proof started, and only while its
// start time is still the one recorded, so a reused pid is never signalled.

interface Known {
  pid: number;
  starttime: string;
}

// Gone once every thread has exited. Proof 25 found a thread-group leader
// reads as a zombie while another of its threads runs on (11 ms, in the first
// r1 run), so a zombie leader counts only once /proc/<pid>/task lists it alone.
function gone(k: Known): boolean {
  const s = procStat(k.pid);
  if (s === undefined || s.starttime !== k.starttime) {
    return true;
  }
  if (s.state === 'Z' || s.state === 'X') {
    try {
      return readdirSync(`/proc/${k.pid}/task`).length <= 1;
    } catch {
      return true;
    }
  }
  return false;
}

function signalChecked(k: Known, sig: NodeJS.Signals, log: (s: string) => void): boolean {
  const s = procStat(k.pid);
  if (!s || s.starttime !== k.starttime) {
    log(`refused ${sig} to ${k.pid}: start time ${s?.starttime ?? 'none'} is not the recorded ${k.starttime}`);
    return false;
  }
  try {
    process.kill(k.pid, sig);
    return true;
  } catch (err) {
    log(`${sig} to ${k.pid} failed: ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Spawn (from proof 17's directSpawn): the SDK's own spawn minus the capture
// wrapper, so the tree is participant -> claude. Layer 1 puts setpriv in
// front: setpriv sets PR_SET_PDEATHSIG and execs claude in the same process.

interface Spawned {
  pid: number;
  dir: string;
  child: ChildProcess;
  exited: Promise<{ at: string; code: number | null; signal: NodeJS.Signals | null }>;
}

const spawned = new Map<string, Spawned[]>();

function claimSpawnDir(root: string): string {
  mkdirSync(root, { recursive: true });
  for (let n = 1; ; n += 1) {
    const dir = join(root, String(n));
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }
}

function spawnWith(pdeathsig: boolean): (o: SpawnOptions) => SpawnedProcess {
  return (o: SpawnOptions): SpawnedProcess => {
    const captureRoot = String(o.env.HARNESS_CAPTURE_DIR);
    const real = String(o.env.HARNESS_REAL_CLAUDE);
    const env = { ...o.env };
    delete env.HARNESS_CAPTURE_DIR;
    delete env.HARNESS_REAL_CLAUDE;
    // The tag, on this Claude Code only (and so on whatever it starts).
    env[TAG_KEY] = RUN_NAME;
    const dir = claimSpawnDir(captureRoot);
    const runId = basename(dirname(captureRoot));
    mkdirSync(DEBUG_ROOT, { recursive: true });
    const debugFile = join(DEBUG_ROOT, `${runId}-${basename(dir)}.log`);
    const args = [...o.args, '--debug-file', debugFile];
    // TODO: undecided (see the header): no setpriv. Built: nothing; spawn
    // fails with ENOENT.
    const command = pdeathsig ? 'setpriv' : real;
    const commandArgs = pdeathsig ? ['--pdeathsig', 'SIGINT', '--', real, ...args] : args;
    const child = spawn(command, commandArgs, { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
    writeFileSync(
      join(dir, 'argv.json'),
      `${JSON.stringify({ startedAt: stamp(), launcher: pdeathsig ? 'setpriv --pdeathsig SIGINT --' : null, tag: `${TAG_KEY}=${RUN_NAME}`, realBinary: real, argv: args, cwd: o.cwd, pid: child.pid, hostPid: process.pid, configDir: env.CLAUDE_CONFIG_DIR, debugFile, envNames: Object.keys(env).sort() }, null, 2)}\n`,
    );
    const stdinRec = new LineRecorder(createWriteStream(join(dir, 'stdin.txt')));
    const stdoutRec = new LineRecorder(createWriteStream(join(dir, 'stdout.txt')));
    const stderrRec = new LineRecorder(createWriteStream(join(dir, 'stderr.txt')));
    for (const [stream, rec] of [
      [child.stdout, stdoutRec],
      [child.stderr, stderrRec],
    ] as const) {
      const emit = stream.emit.bind(stream);
      stream.emit = ((event: string, ...a: unknown[]) => {
        if (event === 'data') {
          rec.push(a[0] as Buffer);
        }
        return emit(event, ...a);
      }) as typeof stream.emit;
    }
    const write = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
    child.stdin.write = ((chunk: unknown, ...a: unknown[]) => {
      stdinRec.push(Buffer.from(chunk as string));
      return write(chunk, ...a);
    }) as typeof child.stdin.write;
    let exitInfo: { at: string; code: number | null; signal: NodeJS.Signals | null } | undefined;
    const exited = new Promise<{ at: string; code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => {
        exitInfo = { at: stamp(), code, signal };
        resolve(exitInfo);
      });
    });
    child.once('close', async () => {
      await Promise.all([stdinRec.end(), stdoutRec.end(), stderrRec.end()]);
      writeFileSync(join(dir, 'exit.json'), `${JSON.stringify({ exitedAt: exitInfo?.at, closedAt: stamp(), code: exitInfo?.code, signal: exitInfo?.signal }, null, 2)}\n`);
    });
    spawned.set(captureRoot, [...(spawned.get(captureRoot) ?? []), { pid: child.pid as number, dir, child, exited }]);
    return child as unknown as SpawnedProcess;
  };
}

function claudeOf(run: Run): Spawned | undefined {
  return spawned.get(join(run.dir, 'claude'))?.at(-1);
}

function copyDebugLogs(runDir: string): void {
  const runId = basename(runDir);
  if (!existsSync(DEBUG_ROOT)) {
    return;
  }
  for (const f of readdirSync(DEBUG_ROOT).filter((n) => n.startsWith(`${runId}-`))) {
    writeFileSync(join(runDir, `debug-${f.slice(runId.length + 1)}`), redact(readFileSync(join(DEBUG_ROOT, f), 'utf8')).text);
  }
}

// ---------------------------------------------------------------------------
// Layer 2: stop any live Claude Code on the session before serving it.

interface StopReport {
  sessionId: string;
  startedAt: string;
  roots: number;
  pidFiles: { file: string; pid: number; procStart: string; status: unknown; live: boolean }[];
  signalled: { pid: number; procStart: string; sentAt: string; goneAt: string | null; msToGone: number | null }[];
  refused: { pid: number; procStart: string; why: string }[];
  ms: number;
  outcome: string;
}

async function stopLive(sessionId: string, ours: Known[], log: (s: string) => void): Promise<StopReport> {
  const startedAt = stamp();
  const t0 = performance.now();
  // The agent's config dir (a fresh Claude Code) and every resume dir (one
  // resumed through the store): proof 17b found each lives in one of these.
  const roots = [AGENT_CONFIG_DIR, ...resumeDirs()];
  const pidFiles: StopReport['pidFiles'] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, 'sessions')).filter((n) => /^\d+\.json$/.test(n));
    } catch {}
    for (const n of names) {
      let d: Json;
      try {
        d = JSON.parse(readFileSync(join(root, 'sessions', n), 'utf8')) as Json;
      } catch {
        continue;
      }
      if (d.sessionId !== sessionId) {
        continue;
      }
      const k = { pid: Number(d.pid), starttime: String(d.procStart) };
      pidFiles.push({ file: join(root, 'sessions', n), pid: k.pid, procStart: k.starttime, status: d.status, live: Number.isInteger(k.pid) && k.pid > 0 && !gone(k) });
    }
  }
  const live = [...new Map(pidFiles.filter((p) => p.live).map((p) => [p.pid, p])).values()];
  const signalled: StopReport['signalled'] = [];
  const refused: StopReport['refused'] = [];
  const waits: { k: Known; row: StopReport['signalled'][number]; t: number }[] = [];
  for (const p of live) {
    const k = { pid: p.pid, starttime: p.procStart };
    if (!ours.some((o) => o.pid === k.pid && o.starttime === k.starttime)) {
      refused.push({ pid: k.pid, procStart: k.starttime, why: 'not a Claude Code this proof started (proof safety gate)' });
      log(`stop ${sessionId}: live pid ${k.pid} is not on this proof's list; not signalled`);
      continue;
    }
    if (!signalChecked(k, 'SIGINT', log)) {
      refused.push({ pid: k.pid, procStart: k.starttime, why: 'start time changed before the signal' });
      continue;
    }
    const row = { pid: k.pid, procStart: k.starttime, sentAt: stamp(), goneAt: null as string | null, msToGone: null as number | null };
    signalled.push(row);
    waits.push({ k, row, t: performance.now() });
    log(`stop ${sessionId}: SIGINT to ${k.pid} (${p.file})`);
  }
  const deadline = performance.now() + STOP_WAIT_MS;
  while (waits.some((w) => w.row.goneAt === null) && performance.now() < deadline) {
    for (const w of waits) {
      if (w.row.goneAt === null && gone(w.k)) {
        w.row.goneAt = stamp();
        w.row.msToGone = Math.round(performance.now() - w.t);
      }
    }
    if (waits.some((w) => w.row.goneAt === null)) {
      await sleep(10);
    }
  }
  const stillRunning = signalled.filter((s) => s.goneAt === null).map((s) => s.pid);
  const outcome =
    live.length === 0
      ? 'none found'
      : stillRunning.length > 0
        ? `still running ${STOP_WAIT_MS} ms after SIGINT: ${JSON.stringify(stillRunning)}; served anyway (TODO: undecided)`
        : refused.length > 0
          ? `refused ${JSON.stringify(refused.map((r) => r.pid))}; served anyway`
          : `stopped ${JSON.stringify(signalled.map((s) => [s.pid, s.msToGone]))}`;
  const report: StopReport = { sessionId, startedAt, roots: roots.length, pidFiles, signalled, refused, ms: Math.round(performance.now() - t0), outcome };
  log(`stop ${sessionId}: ${roots.length} roots, pid files ${JSON.stringify(pidFiles.map((p) => ({ pid: p.pid, live: p.live, status: p.status })))}; ${outcome}; ${report.ms} ms`);
  return report;
}

// ---------------------------------------------------------------------------
// The tag stop: every leftover of this agent, whatever its session, before
// serving.

// Every pid this participant has spawned (its Claude Codes). The scan also
// excludes their descendants. See the header's TODO.
function ownRoots(): Set<number> {
  return new Set([...spawned.values()].flat().map((s) => s.pid));
}

// What proof 21's finder would see at the same moment: every live
// sessions/<pid>.json in the agent's config dir or a resume dir, any session.
function pidFileView(): { file: string; pid: number; sessionId: unknown; live: boolean }[] {
  const out: { file: string; pid: number; sessionId: unknown; live: boolean }[] = [];
  for (const root of [AGENT_CONFIG_DIR, ...resumeDirs()]) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, 'sessions')).filter((n) => /^\d+\.json$/.test(n));
    } catch {}
    for (const n of names) {
      try {
        const d = JSON.parse(readFileSync(join(root, 'sessions', n), 'utf8')) as Json;
        const k = { pid: Number(d.pid), starttime: String(d.procStart) };
        out.push({ file: join(root, 'sessions', n), pid: k.pid, sessionId: d.sessionId, live: Number.isInteger(k.pid) && k.pid > 0 && !gone(k) });
      } catch {}
    }
  }
  return out;
}

interface TagStopRound {
  scan: TagScan;
  pidFileView: ReturnType<typeof pidFileView>;
  signalled: { pid: number; starttime: string; sentAt: string }[];
  refused: { pid: number; starttime: string; why: string }[];
  waited: { pid: number; starttime: string; cmd: string; pidFileLive: boolean; goneAt: string | null; msToGone: number | null }[];
  waitEndedAt: string;
}

interface TagStopReport {
  finder: 'tag';
  name: string;
  startedAt: string;
  rounds: TagStopRound[];
  endedAt: string;
  ms: number;
  outcome: string;
}

async function stopTagged(ours: Known[], log: (s: string) => void): Promise<TagStopReport> {
  const startedAt = stamp();
  const t0 = performance.now();
  const rounds: TagStopRound[] = [];
  let outcome = '';
  for (let round = 1; round <= STOP_ROUNDS; round += 1) {
    const scan = scanTag(RUN_NAME, ownRoots());
    const pfv = pidFileView();
    const r: TagStopRound = { scan, pidFileView: pfv, signalled: [], refused: [], waited: [], waitEndedAt: '' };
    rounds.push(r);
    log(
      `tag stop round ${round}: scan ${scan.ms} ms over ${scan.scanned} environs; found ${JSON.stringify(scan.found.map((p) => [p.pid, p.pidFileLive ? 'live pid file' : 'no live pid file', p.cmd.slice(0, 30)]))}; excluded ${scan.excluded.length}; own-uid unreadable ${scan.ownUidUnreadable.length}; proof 21's finder would see live ${JSON.stringify(pfv.filter((x) => x.live).map((x) => x.pid))}`,
    );
    if (scan.found.length === 0) {
      r.waitEndedAt = stamp();
      outcome = round === 1 ? 'none found' : `all exited after ${round - 1} round(s)`;
      break;
    }
    // TODO: undecided (see the header): SIGINT only to one still running
    // normally, judged by its live pid file.
    for (const p of scan.found.filter((x) => x.pidFileLive)) {
      const k = { pid: p.pid, starttime: p.starttime };
      if (!ours.some((o) => o.pid === k.pid && o.starttime === k.starttime)) {
        r.refused.push({ ...k, why: 'not a Claude Code this proof started (proof safety gate)' });
        log(`tag stop: ${k.pid} is not on this proof's list; not signalled`);
        continue;
      }
      if (!signalChecked(k, 'SIGINT', log)) {
        r.refused.push({ ...k, why: 'start time changed before the signal' });
        continue;
      }
      r.signalled.push({ ...k, sentAt: stamp() });
      log(`tag stop: SIGINT to ${k.pid}`);
    }
    // TODO: undecided (see the header): wait for every tagged process found.
    const tw = performance.now();
    r.waited = scan.found.map((p) => ({ pid: p.pid, starttime: p.starttime, cmd: p.cmd.slice(0, 60), pidFileLive: p.pidFileLive, goneAt: null, msToGone: null }));
    const deadline = tw + STOP_WAIT_MS;
    while (r.waited.some((w) => w.goneAt === null) && performance.now() < deadline) {
      for (const w of r.waited) {
        if (w.goneAt === null && gone(w)) {
          w.goneAt = stamp();
          w.msToGone = Math.round(performance.now() - tw);
        }
      }
      if (r.waited.some((w) => w.goneAt === null)) {
        await sleep(5);
      }
    }
    r.waitEndedAt = stamp();
    const left = r.waited.filter((w) => w.goneAt === null).map((w) => w.pid);
    log(`tag stop round ${round}: waited ${JSON.stringify(r.waited.map((w) => [w.pid, w.msToGone]))}`);
    if (left.length > 0) {
      // TODO: undecided (see the header): a leftover still running long after
      // SIGINT. Built: serve anyway.
      outcome = `still running ${STOP_WAIT_MS} ms after round ${round}: ${JSON.stringify(left)}; served anyway (TODO: undecided)`;
      break;
    }
    if (round === STOP_ROUNDS) {
      outcome = `still finding tagged processes after ${STOP_ROUNDS} rounds; served anyway (TODO: undecided)`;
    }
  }
  const report: TagStopReport = { finder: 'tag', name: RUN_NAME, startedAt, rounds, endedAt: stamp(), ms: Math.round(performance.now() - t0), outcome };
  log(`tag stop: ${outcome}; ${report.ms} ms`);
  return report;
}

// ---------------------------------------------------------------------------
// The participant

interface ConvSpec {
  tag: string;
  sessionId?: string;
  say: string;
  trigger: 'reply' | 'tool' | 'none';
  toolLabel?: string;
}

interface ParticipantSpec {
  model: string;
  outDir: string;
  ending: 'answer' | 'hold';
  apiBodies?: boolean;
  // Layer 1.
  pdeathsig: boolean;
  // Layer 2: the stop before serving, by the tag (proof 25) or by pid file
  // (proof 21's stopLive, the control).
  stopOrphans: boolean;
  finder: 'tag' | 'pidfile';
  // Start loaded, print ARMED, and wait for GO on stdin before anything.
  waitGo?: boolean;
  // The proof's safety gate for layer 2: Claude Codes this proof started.
  ours: Known[];
  convs: ConvSpec[];
}

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

async function participant(specPath: string): Promise<void> {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ParticipantSpec;
  const out = spec.outDir;
  mkdirSync(out, { recursive: true });
  const log = makeLog(new Recorder(join(out, 'participant-log.txt')), `participant ${process.pid}: `);
  log(`start; spec ${specPath}; layer 1 ${spec.pdeathsig}; layer 2 ${spec.stopOrphans} by ${spec.finder}`);
  const timing: Json = {};
  if (spec.waitGo) {
    const go = new Promise<void>((resolve) => {
      let buf = '';
      process.stdin.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (buf.includes('GO\n')) {
          process.stdin.destroy();
          resolve();
        }
      });
    });
    log('armed; waiting for GO');
    process.stdout.write('ARMED\n');
    await go;
    timing.goAt = stamp();
    log('GO');
  }

  // Before any Claude Code of this serve starts: layer 2 (stop, wait), then
  // proof 17's check, twice (the second shows it adds nothing more). The tag
  // stop runs once, for the whole agent; proof 21's stops run side by side,
  // one per session. Checks one at a time (check() swaps
  // process.env.CLAUDE_CONFIG_DIR while it reads).
  const withSession = spec.convs.filter((c) => c.sessionId);
  const stops = new Map<string, StopReport>();
  let tagStop: TagStopReport | undefined;
  timing.stopStartedAt = stamp();
  if (spec.stopOrphans && spec.finder === 'tag') {
    tagStop = await stopTagged(spec.ours, log);
    writeFileSync(join(out, 'stop.json'), `${redact(JSON.stringify(tagStop, null, 2)).text}\n`);
  }
  if (spec.stopOrphans && spec.finder === 'pidfile') {
    await Promise.all(
      withSession.map(async (c) => {
        const r = await stopLive(c.sessionId as string, spec.ours, (s) => log(`${c.tag}: ${s}`));
        stops.set(c.tag, r);
        writeFileSync(join(out, `stop-${c.tag}.json`), `${redact(JSON.stringify(r, null, 2)).text}\n`);
      }),
    );
  }
  timing.checksStartedAt = stamp();
  for (const c of withSession) {
    const first = await check(c.sessionId as string, (s) => log(`${c.tag}: ${s}`));
    const second = await check(c.sessionId as string, (s) => log(`${c.tag} (again): ${s}`));
    writeFileSync(join(out, `check-${c.tag}.json`), `${redact(JSON.stringify({ first, second }, null, 2)).text}\n`);
  }

  // Serve.
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, 'wait.sh'), `date -u +%FT%T.%NZ > "wait-$1-started.txt"\nsleep ${TOOL_SLEEP_S}\ndate -u +%FT%T.%NZ > "wait-$1-finished.txt"\necho waited\n`);
  interface Part {
    c: ConvSpec;
    run: Run;
    ready: Promise<void>;
    result: Promise<string>;
    sessionId: Promise<string>;
    done: Promise<void>;
  }
  const parts: Part[] = [];
  timing.checksEndedAt = stamp();
  const state: Json = { participantPid: process.pid, participantStarttime: procStat(process.pid)?.starttime ?? null, startedAt: stamp(), pdeathsig: spec.pdeathsig, finder: spec.finder, timing, tagStop: tagStop?.outcome ?? null, convs: [] as Json[] };
  // The same scan with this participant's own Claude Codes (and their tools)
  // up: it must exclude them all.
  const ownScan = (when: string): void => {
    const sc = scanTag(RUN_NAME, ownRoots());
    writeFileSync(join(out, `own-scan-${when}.json`), `${JSON.stringify({ when, own: [...ownRoots()], ...sc }, null, 2)}\n`);
    log(`own scan (${when}): found ${JSON.stringify(sc.found.map((p) => p.pid))}; excluded ${JSON.stringify(sc.excluded.map((p) => [p.pid, p.cmd.slice(0, 30)]))}`);
  };
  const writeState = (): void => writeFileSync(join(out, 'participant-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  for (const c of spec.convs) {
    const runStamp = stamp().replace(/[:.]/g, '');
    const bodies = spec.apiBodies ? join(BODIES_ROOT, `${runStamp}-${RUN_NAME}-${c.tag}`) : undefined;
    const store = new Store(join(out, `store-appends-${c.tag}.jsonl`));
    const options: HarnessOptions = {
      model: spec.model,
      includePartialMessages: true,
      tools: ['Read', 'Bash'],
      allowedTools: ['Read', 'Bash'],
      thinking: { type: 'adaptive', display: 'summarized' },
      sessionStore: store,
      sessionStoreFlush: 'eager',
      spawnClaudeCodeProcess: spawnWith(spec.pdeathsig),
      ...(c.sessionId ? { resume: c.sessionId } : {}),
      ...(bodies ? { env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodies}` } } : {}),
    };
    const run = startRun({ name: RUN_NAME, options });
    run.done.catch(() => {});
    let readyR: () => void = () => {};
    let resultR: (s: string) => void = () => {};
    let sidR: (s: string) => void = () => {};
    const ready = new Promise<void>((r) => {
      readyR = r;
    });
    const result = new Promise<string>((r) => {
      resultR = r;
    });
    const sessionId = new Promise<string>((r) => {
      sidR = r;
    });
    let fired = false;
    const fire = (why: string): void => {
      if (!fired) {
        fired = true;
        log(`${c.tag}: mid-turn: ${why}`);
        readyR();
      }
    };
    if (c.trigger === 'none') {
      fire('no trigger');
    }
    if (c.trigger === 'tool') {
      const started = join(WORK, `wait-${c.toolLabel}-started.txt`);
      const poll = setInterval(() => {
        if (existsSync(started)) {
          clearInterval(poll);
          setTimeout(() => fire(`wait.sh started, +${TOOL_DELAY_MS} ms`), TOOL_DELAY_MS);
        }
      }, 20);
      poll.unref();
    }
    const consumed = (async () => {
      let chars = 0;
      try {
        for await (const m of run.messages()) {
          if (m.type === 'system' && m.subtype === 'init') {
            sidR(m.session_id);
          }
          if (m.type === 'stream_event' && m.parent_tool_use_id == null && m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta') {
            chars += m.event.delta.text.length;
            if (c.trigger === 'reply' && chars >= REPLY_CHARS) {
              fire(`${chars} text chars streamed`);
            }
          }
          if (m.type === 'result') {
            log(`${c.tag}: result ${m.subtype}`);
            resultR(m.subtype === 'success' ? m.result : m.subtype);
          }
        }
      } catch (err) {
        log(`${c.tag}: messages threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      resultR('(no result)');
    })();
    const done = (async () => {
      await consumed;
      try {
        await run.done;
        log(`${c.tag}: run.done settled`);
      } catch (err) {
        log(`${c.tag}: run.done rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
      copyDebugLogs(run.dir);
    })();
    run.send(user(c.say));
    const conv: Json = { tag: c.tag, sentAt: stamp(), runDir: run.dir, configDir: run.configDir, resumedFrom: c.sessionId ?? null, bodies: bodies ?? null, stop: stops.get(c.tag)?.outcome ?? null };
    (state.convs as Json[]).push(conv);
    void sessionId.then((sid) => {
      conv.sessionId = sid;
      writeState();
    });
    parts.push({ c, run, ready, result, sessionId, done });
    log(`${c.tag}: run ${run.dir}${c.sessionId ? `, resuming ${c.sessionId} through the store` : ', new conversation'}`);
  }
  // A resume spawns Claude Code only after the SDK has written the resume
  // dir, so the pid is waited for rather than read once.
  const pidsKnown = parts.map(async (p) => {
    const conv = (state.convs as Json[]).find((x) => x.tag === p.c.tag) as Json;
    let sp = claudeOf(p.run);
    for (let i = 0; !sp && i < 6000; i += 1) {
      await sleep(10);
      sp = claudeOf(p.run);
    }
    if (!sp) {
      log(`${p.c.tag}: no claude process after 60 s`);
      return;
    }
    const found = sp;
    conv.claudePid = found.pid;
    conv.claudeStarttime = procStat(found.pid)?.starttime ?? null;
    conv.claudeCmd = cmdline(found.pid).slice(0, 200);
    writeState();
    void found.exited.then((e) => {
      log(`${p.c.tag}: claude ${found.pid} exited ${JSON.stringify(e)}`);
      conv.claudeExit = e;
      writeState();
    });
  });
  writeState();

  if (spec.ending === 'answer') {
    await Promise.all(pidsKnown);
    ownScan('serving');
    writeState();
    for (const p of parts) {
      const answer = await Promise.race([p.result, later(180_000).then(() => '(no answer in 180 s)')]);
      const conv = (state.convs as Json[]).find((x) => x.tag === p.c.tag) as Json;
      conv.answer = answer;
      log(`${p.c.tag}: answer ${JSON.stringify(answer)}`);
      p.run.end();
    }
    await Promise.allSettled(parts.map((p) => p.done));
    writeState();
    log('all done');
    return;
  }

  // Held mid-turn; the driver ends it with SIGKILL, or SIGUSR2 for a crash.
  process.on('SIGUSR2', () => {
    log('SIGUSR2: throwing an uncaught exception');
    setImmediate(() => {
      throw new Error('proof 21: uncaught exception in the participant');
    });
  });
  process.on('exit', (code) => {
    log(`exit ${code}`);
  });
  await Promise.all(parts.map((p) => p.ready));
  await Promise.all(pidsKnown);
  ownScan('mid-turn');
  await Promise.race([Promise.all(parts.map((p) => p.sessionId)), later(3000)]);
  writeState();
  log('all mid-turn');
  process.stdout.write('READY\n');
  await Promise.allSettled(parts.map((p) => p.done));
  writeState();
  log('main returning (all done)');
}

// ---------------------------------------------------------------------------
// The driver: ends participants, keeps every transcript line it sees, times
// every Claude Code and its tool, scores each serve.

// Keeps a copy of every transcript of the watched sessions, in every root,
// updated as it grows: the SDK deletes a resume dir once its Claude Code
// exits, and the scoring needs what was written there.
class Keeper {
  readonly dir: string;
  readonly rec: Recorder;
  readonly sids = new Set<string>();
  readonly sizes = new Map<string, number>();
  // A file that shrinks, or goes and comes back, is a new generation with its
  // own copy, so no line once seen is overwritten.
  readonly gens = new Map<string, number>();
  readonly pidSeen = new Map<string, string>();
  readonly pidFiles = new Map<string, Json>();
  readonly extraRoots = new Set<string>();
  timer: NodeJS.Timeout | undefined;
  constructor(dir: string) {
    this.dir = join(dir, 'seen');
    mkdirSync(this.dir, { recursive: true });
    this.rec = new Recorder(join(dir, 'keeper.jsonl'));
  }
  watch(sid: string): void {
    this.sids.add(sid);
  }
  addRoot(root: string): void {
    this.extraRoots.add(root);
  }
  start(): void {
    this.timer = setInterval(() => this.scan(), 20);
  }
  stop(): void {
    this.scan();
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
  copyName(file: string): string {
    const root = file.slice(0, file.indexOf('/projects/'));
    const gen = this.gens.get(file) ?? 0;
    return `${basename(root)}${gen > 0 ? `.gen${gen}` : ''}__${basename(file)}`;
  }
  scan(): void {
    // 17b: a watched session's pid file that disappears (removed by its own
    // Claude Code on exit, or by anything else) is logged, so a Claude Code
    // removing the other's is visible.
    for (const [f, d] of this.pidFiles) {
      if (!existsSync(f)) {
        this.pidFiles.delete(f);
        this.rec.write({ ts: stamp(), event: 'pidfile-gone', file: f, pid: d.pid, sessionId: d.sessionId, pidAlive: alive(Number(d.pid)) });
      }
    }
    for (const [file, size] of this.sizes) {
      if (size !== -1 && !existsSync(file)) {
        this.sizes.set(file, -1);
        this.rec.write({ ts: stamp(), event: 'gone', file });
      }
    }
    const roots = [...this.extraRoots, ...resumeDirs()];
    for (const root of roots) {
      for (const project of subdirs(join(root, 'projects'))) {
        for (const sid of this.sids) {
          const file = join(project, `${sid}.jsonl`);
          let size: number;
          try {
            size = statSync(file).size;
          } catch {
            continue;
          }
          const prev = this.sizes.get(file);
          if (prev === size) {
            continue;
          }
          if (prev !== undefined && (prev === -1 || size < prev)) {
            this.gens.set(file, (this.gens.get(file) ?? 0) + 1);
            this.rec.write({ ts: stamp(), event: prev === -1 ? 'back' : 'shrank', file, from: prev, to: size, gen: this.gens.get(file) });
          }
          let text: string;
          try {
            text = readFileSync(file, 'utf8');
          } catch {
            continue;
          }
          this.sizes.set(file, size);
          writeFileSync(join(this.dir, this.copyName(file)), redact(text).text);
          writeFileSync(join(this.dir, `${this.copyName(file)}.source`), `${file}\n`);
          this.rec.write({ ts: stamp(), event: 'size', file, size, lines: text.split('\n').filter((l) => l.trim() !== '').length });
        }
      }
      for (const n of (() => {
        try {
          return readdirSync(join(root, 'sessions')).filter((x) => /^\d+\.json$/.test(x));
        } catch {
          return [];
        }
      })()) {
        const f = join(root, 'sessions', n);
        const key = `${root}:${n}`;
        try {
          const d = JSON.parse(readFileSync(f, 'utf8')) as Json;
          if (this.sids.has(String(d.sessionId))) {
            this.pidFiles.set(f, d);
            const v = `${String(d.status)}`;
            if (this.pidSeen.get(key) !== v) {
              this.pidSeen.set(key, v);
              this.rec.write({ ts: stamp(), event: 'pidfile', file: f, sessionId: d.sessionId, pid: d.pid, procStart: d.procStart, status: d.status });
            }
          }
        } catch {}
      }
    }
  }
  // Every entry seen for a session, in any root, keyed by entryId.
  truth(sid: string): Map<string, { entry: Json; copy: string }> {
    const out = new Map<string, { entry: Json; copy: string }>();
    for (const n of readdirSync(this.dir).filter((x) => x.endsWith(`__${sid}.jsonl`))) {
      for (const e of readJsonl(join(this.dir, n))) {
        if (!out.has(entryId(e))) {
          out.set(entryId(e), { entry: e, copy: n });
        }
      }
    }
    return out;
  }
}

// Times each process it tracks: the first moment, on the driver's clock, its
// pid is gone, a zombie, or holds a different process. Polls every 10 ms, and
// every 50 ms adds any new descendant of a tracked Claude Code.
interface Tracked extends Known {
  role: string;
  cmd: string;
  addedAt: string;
  goneAt: string | null;
  goneT: number | null;
  // Its thread ids, as last listed: strace -f names a signal by the thread
  // it was delivered to, which for a process-directed signal can be any.
  tids: number[];
}

function tidsOf(pid: number): number[] {
  try {
    return readdirSync(`/proc/${pid}/task`).map(Number);
  } catch {
    return [];
  }
}

class ProcWatch {
  readonly tracked = new Map<number, Tracked>();
  timer: NodeJS.Timeout | undefined;
  ticks = 0;
  add(pid: number, role: string): void {
    if (this.tracked.has(pid)) {
      return;
    }
    const s = procStat(pid);
    if (!s || s.state === 'Z' || s.state === 'X') {
      return;
    }
    this.tracked.set(pid, { pid, starttime: s.starttime, role, cmd: cmdline(pid).slice(0, 120), addedAt: stamp(), goneAt: null, goneT: null, tids: tidsOf(pid) });
  }
  addTree(pid: number, role: string): void {
    for (const d of descendants(pid)) {
      this.add(d.pid, `${role}-descendant`);
    }
  }
  tick(): void {
    this.ticks += 1;
    for (const t of this.tracked.values()) {
      if (t.goneAt === null && gone(t)) {
        t.goneAt = stamp();
        t.goneT = Date.now();
      }
    }
    if (this.ticks % 5 === 0) {
      for (const t of [...this.tracked.values()]) {
        if (t.goneAt === null) {
          t.tids = [...new Set([...t.tids, ...tidsOf(t.pid)])];
        }
        if (t.goneAt === null && t.role.startsWith('claude') && !t.role.endsWith('descendant')) {
          this.addTree(t.pid, t.role);
        }
      }
    }
  }
  start(): void {
    this.timer = setInterval(() => this.tick(), 10);
  }
  stop(): void {
    this.tick();
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
  allGone(filter: (t: Tracked) => boolean = () => true): boolean {
    return [...this.tracked.values()].filter(filter).every((t) => t.goneAt !== null);
  }
  alive(filter: (t: Tracked) => boolean = () => true): Tracked[] {
    return [...this.tracked.values()].filter(filter).filter((t) => t.goneAt === null);
  }
}

interface ParticipantHandle {
  pid: number;
  starttime: string;
  dir: string;
  ready: Promise<boolean>;
  armed: Promise<boolean>;
  go: () => string;
  exited: Promise<{ at: string; t: number; code: number | null; signal: string | null }>;
}

function startParticipant(caseDir: string, label: string, spec: Omit<ParticipantSpec, 'outDir'>, log: (s: string) => void): ParticipantHandle {
  const dir = join(caseDir, label);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, `${JSON.stringify({ ...spec, outDir: dir }, null, 2)}\n`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'participant', specPath], { cwd: PACKAGE_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const outFile = createWriteStream(join(dir, 'participant-stdout.txt'));
  let buf = '';
  let readyR: (b: boolean) => void = () => {};
  const ready = new Promise<boolean>((r) => {
    readyR = r;
  });
  let armedR: (b: boolean) => void = () => {};
  const armed = new Promise<boolean>((r) => {
    armedR = r;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    outFile.write(chunk);
    buf += chunk.toString('utf8');
    let at = buf.indexOf('\n');
    while (at >= 0) {
      if (buf.slice(0, at) === 'READY') {
        readyR(true);
      }
      if (buf.slice(0, at) === 'ARMED') {
        armedR(true);
      }
      buf = buf.slice(at + 1);
      at = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => outFile.write(chunk));
  const exited = new Promise<{ at: string; t: number; code: number | null; signal: string | null }>((r) =>
    child.once('exit', (code, signal) => {
      readyR(false);
      armedR(false);
      r({ at: stamp(), t: Date.now(), code, signal });
    }),
  );
  child.stdin.on('error', () => {});
  const go = (): string => {
    child.stdin.write('GO\n');
    return stamp();
  };
  const starttime = procStat(child.pid as number)?.starttime ?? '?';
  log(`${label}: participant pid ${child.pid} (start ${starttime}), dir ${relative(PACKAGE_ROOT, dir)}`);
  return { pid: child.pid as number, starttime, dir, ready, armed, go, exited };
}

function pstate(h: ParticipantHandle): { convs: Json[] } {
  return JSON.parse(readFileSync(join(h.dir, 'participant-state.json'), 'utf8')) as { convs: Json[] };
}

// The story is longer than proof 17's 600 words, so the reply is still
// streaming when layer 2's SIGINT lands a few seconds after the kill.
const PROMPTS = {
  seed: (w: string): string => `Remember the code word ${w} for later. Reply with OK and nothing else.`,
  story: 'Write a 1500-word story about a lighthouse keeper. No preamble.',
  tool: (label: string): string => `Run \`bash wait.sh ${label}\` in the working directory with the Bash tool, then reply DONE.`,
};

const QUESTIONS: Record<string, string> = {
  R: 'Quote the final sentence of your previous reply exactly, or reply NONE if you have no previous reply.',
  T: 'In your previous turn you ran wait.sh with the Bash tool. What did the tool result say, and what did you reply after it? Quote both exactly, or reply NONE for either you did not see.',
};

const WORDS: Record<string, string> = { R: 'PERIWINKLE', T: 'MARIGOLD' };

function storeFilesFor(sid: string): string[] {
  return subdirs(STORE_DIR)
    .map((p) => join(p, `${sid}.jsonl`))
    .filter((f) => existsSync(f));
}

function isMessage(e: Json): boolean {
  return e.type === 'user' || e.type === 'assistant';
}

// A parentUuid with two or more user/assistant children: the conversation
// forked there (proof 17's test).
function branchesOf(entries: Json[]): { parent: string; children: string[] }[] {
  const children = new Map<string, string[]>();
  for (const e of entries) {
    if (typeof e.parentUuid === 'string' && typeof e.uuid === 'string' && isMessage(e)) {
      const list = children.get(e.parentUuid) ?? [];
      if (!list.includes(e.uuid)) {
        list.push(e.uuid);
      }
      children.set(e.parentUuid, list);
    }
  }
  const byUuid = new Map(entries.filter((e) => typeof e.uuid === 'string').map((e) => [e.uuid as string, e]));
  return [...children.entries()].filter(([, v]) => v.length > 1).map(([p, c]) => ({ parent: p, children: c.map((u) => `${u} ${describeEntry(byUuid.get(u) as Json).slice(0, 90)}`) }));
}

const INVENTED = /outcome is unknown|Tool call interrupted/;

function invented(entries: Json[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const content = (e.message as Json | undefined)?.content;
    if (Array.isArray(content)) {
      for (const b of content as Json[]) {
        if (b.type === 'tool_result' && INVENTED.test(flat(b.content))) {
          out.push(`${String(e.uuid)} ${flat(b.content).slice(0, 120)}`);
        }
      }
    }
  }
  return out;
}

// What an entry holds, for a turn's summary.
function turnRow(e: Json, req: Json | undefined): Json {
  const msg = e.message as Json | undefined;
  const content = msg?.content;
  const textChars = Array.isArray(content) ? (content as Json[]).filter((b) => b.type === 'text').reduce((n, b) => n + String(b.text).length, 0) : typeof content === 'string' ? content.length : 0;
  return {
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    at: e.timestamp,
    what: describeEntry(e).slice(0, 140),
    stopReason: e.type === 'assistant' ? (msg?.stop_reason ?? null) : undefined,
    textChars,
    ...(req ? (({ what, carried: c }) => ({ carriedTest: what, carried: c }))(carried(e, req)) : { carried: null }),
  };
}

// Whether an entry is carried by a request, by content (proof 17's test): an
// assistant's last text block must be one of the request's assistant text
// blocks; a tool_result must match on tool_use_id AND content (a synthetic
// "[Tool call interrupted...]" result carries the same id); a tool_use by id;
// a user text by its text.
function flat(c: unknown): string {
  if (typeof c === 'string') {
    return c;
  }
  if (Array.isArray(c)) {
    return c.map((b: Json) => (typeof b.text === 'string' ? b.text : '')).join('');
  }
  return JSON.stringify(c ?? null);
}

function carried(e: Json, req: Json): { what: string; carried: boolean | null } {
  const msgs = (req.messages as Json[]) ?? [];
  const blocks = (role: string): Json[] => msgs.filter((m) => m.role === role && Array.isArray(m.content)).flatMap((m) => m.content as Json[]);
  const content = (e.message as Json | undefined)?.content;
  if (e.type === 'assistant' && Array.isArray(content)) {
    const texts = (content as Json[]).filter((b) => b.type === 'text' && String(b.text).trim() !== '');
    if (texts.length > 0) {
      const t = String(texts.at(-1)?.text);
      return { what: `assistant text "${t.slice(0, 30).replace(/\n/g, ' ')}"`, carried: blocks('assistant').some((b) => b.type === 'text' && b.text === t) };
    }
    const use = (content as Json[]).find((b) => b.type === 'tool_use');
    if (use) {
      return { what: 'assistant tool_use', carried: blocks('assistant').some((b) => b.type === 'tool_use' && b.id === use.id) };
    }
    return { what: 'assistant thinking only', carried: null };
  }
  if (e.type === 'user' && Array.isArray(content) && (content as Json[]).some((b) => b.type === 'tool_result')) {
    const r = (content as Json[]).find((b) => b.type === 'tool_result') as Json;
    return { what: `tool_result "${flat(r.content).slice(0, 30)}"`, carried: blocks('user').some((b) => b.type === 'tool_result' && b.tool_use_id === r.tool_use_id && flat(b.content) === flat(r.content)) };
  }
  const t = flat(content);
  return { what: `user "${t.slice(0, 30).replace(/\n/g, ' ')}"`, carried: JSON.stringify(req).includes(JSON.stringify(t).slice(1, -1)) };
}

// The first main-loop request Claude Code sent (query_source "sdk"), as text.
function firstRequest(bodies: string): string | null {
  if (!bodies || !existsSync(join(bodies, 'index.jsonl'))) {
    return null;
  }
  const first = readJsonl(join(bodies, 'index.jsonl')).find((x) => x.query_source === 'sdk');
  if (!first || !existsSync(join(bodies, String(first.request_file)))) {
    return null;
  }
  // Re-serialised, so escaping matches the fingerprints (JSON.stringify).
  return JSON.stringify(JSON.parse(readFileSync(join(bodies, String(first.request_file)), 'utf8')));
}

interface Ctx {
  caseDir: string;
  model: string;
  pd: boolean;
  finder: 'tag' | 'pidfile';
  sids: Record<string, string>;
  keeper: Keeper;
  ours: Known[];
  log: (s: string) => void;
  note: (h: ParticipantHandle) => void;
}

interface Window {
  name: string;
  from: Record<string, string>;
  to?: Record<string, string>;
}

function readJson(path: string): Json | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Json) : undefined;
}

function byTime(a: Json, b: Json): number {
  return String(a.timestamp).localeCompare(String(b.timestamp));
}

function inWindow(e: Json, w: Window, tag: string): boolean {
  const at = String(e.timestamp ?? '');
  const from = w.from[tag];
  const to = w.to?.[tag];
  return at !== '' && from !== undefined && at >= from && (to === undefined || at < to);
}

// One serve of every conversation, each asked about its previous turn. Layer 2
// runs first in the participant, then proof 17's check.
function serveSpec(ctx: Ctx, waitGo: boolean): Omit<ParticipantSpec, 'outDir'> {
  const tags = Object.keys(ctx.sids);
  return {
    model: ctx.model,
    ending: 'answer',
    apiBodies: true,
    pdeathsig: ctx.pd,
    stopOrphans: true,
    finder: ctx.finder,
    waitGo,
    ours: [...ctx.ours],
    convs: tags.map((tag) => ({ tag, sessionId: ctx.sids[tag], say: QUESTIONS[tag] as string, trigger: 'none' as const })),
  };
}

// `pre`: a serve participant already started (armed, then sent GO).
async function serveAgain(ctx: Ctx, label: string, windows: Window[], pre?: ParticipantHandle): Promise<{ rows: Json[]; sentAt: Record<string, string> }> {
  const { keeper, log } = ctx;
  const tags = Object.keys(ctx.sids);
  const h = pre ?? startParticipant(ctx.caseDir, label, serveSpec(ctx, false), log);
  const ex = await Promise.race([h.exited, later(400_000).then(() => undefined)]);
  log(`${label}: participant exited ${JSON.stringify(ex)}`);
  ctx.note(h);
  await sleep(300);
  keeper.scan();
  const st = pstate(h);
  const rows: Json[] = [];
  const sentAt: Record<string, string> = {};
  for (const tag of tags) {
    const sid = ctx.sids[tag] as string;
    const conv = st.convs.find((c) => c.tag === tag) as Json;
    sentAt[tag] = String(conv.sentAt);
    const stopPf = readJson(join(h.dir, `stop-${tag}.json`)) as unknown as StopReport | undefined;
    const stopTag = readJson(join(h.dir, 'stop.json')) as unknown as TagStopReport | undefined;
    const stop = stopPf ?? (stopTag ? { outcome: stopTag.outcome, ms: stopTag.ms, pidFiles: stopTag.rounds[0]?.pidFileView ?? [], signalled: stopTag.rounds.flatMap((r) => r.signalled), refused: stopTag.rounds.flatMap((r) => r.refused), found: stopTag.rounds.map((r) => r.scan.found.map((p) => p.pid)), waited: stopTag.rounds.flatMap((r) => r.waited) } : undefined);
    const checks = readJson(join(h.dir, `check-${tag}.json`)) as unknown as { first: CheckReport; second: CheckReport };
    const truth = [...keeper.truth(sid).values()].map((v) => v.entry);
    const bodyText = firstRequest(String(conv.bodies ?? ''));
    const req = bodyText === null ? undefined : (JSON.parse(bodyText) as Json);
    if (bodyText !== null) {
      writeFileSync(join(h.dir, `first-request-${tag}.json`), redact(bodyText).text);
    }
    // Everything written on the session before this serve's message was sent
    // (after layer 2 and the check), whoever wrote it.
    const prior = truth.filter((e) => isMessage(e) && typeof e.timestamp === 'string' && String(e.timestamp) < sentAt[tag]).sort(byTime);
    const priorRows = prior.map((e) => turnRow(e, req));
    const k = checks.first.keys[0];
    const storeAfterCheck = k ? readJsonl(k.storeFile).slice(0, k.storeAfter) : [];
    const storeNow = storeFilesFor(sid).flatMap(readJsonl);
    rows.push({
      serve: label,
      tag,
      sessionId: sid,
      stop: stop ? { finder: stopPf ? 'pidfile' : 'tag', ...stop } : null,
      check: {
        startedAt: checks.first.startedAt,
        tagAtStart: checks.first.tagAtStart,
        tagAtEnd: checks.first.tagAtEnd,
        ms: checks.first.ms,
        transcripts: checks.first.transcripts.map((t) => ({ where: t.root.startsWith(tmpdir()) ? basename(t.root) : `config-dirs/${basename(t.root)}`, lines: t.lines, imported: t.imported })),
        stillRunningByPidFile: checks.first.runningBySessionPidFile,
        stillRunningByCmdline: checks.first.runningByCmdline,
        storeBefore: checks.first.keys.map((x) => x.storeBefore),
        added: checks.first.keys.map((x) => x.missing),
        addedEntries: checks.first.keys.flatMap((x) => x.added),
        secondCheckAdded: checks.second.keys.map((x) => x.missing),
      },
      priorEntries: priorRows.length,
      priorNotCarried: priorRows.filter((r) => r.carried === false),
      priorUntested: priorRows.filter((r) => r.carried === null).length,
      // Each window ends, at the latest, where this serve's message was sent.
      windows: windows.map((w) => ({ name: w.name, rows: prior.filter((e) => inWindow(e, w, tag)).map((e) => turnRow(e, req)) })),
      branches: { storeAfterCheck: branchesOf(storeAfterCheck), storeNow: branchesOf(storeNow), transcripts: branchesOf(truth) },
      invented: { transcripts: invented(truth), store: invented(storeNow) },
      requestFound: req !== undefined,
      answer: conv.answer,
      runDir: relative(PACKAGE_ROOT, String(conv.runDir)),
    });
  }
  writeFileSync(join(h.dir, 'score.json'), `${JSON.stringify(rows, null, 2)}\n`);
  for (const r of rows) {
    const b = r.branches as Record<string, unknown[]>;
    const inv = r.invented as Record<string, unknown[]>;
    log(
      `${label} ${String(r.tag)}: stop ${JSON.stringify((r.stop as Json | null)?.outcome ?? null)}; check added ${JSON.stringify((r.check as Json).added)}; prior ${String(r.priorEntries)}, not carried ${(r.priorNotCarried as unknown[]).length}, untested ${String(r.priorUntested)}; branches store-after-check ${b.storeAfterCheck?.length} store-now ${b.storeNow?.length} transcripts ${b.transcripts?.length}; invented ${inv.transcripts?.length}/${inv.store?.length}; answer ${JSON.stringify(r.answer)}`,
    );
  }
  return { rows, sentAt };
}

// What the store and the transcripts hold once every orphan has exited, before
// any check has run.
function snapshot(ctx: Ctx, label: string, heldSentAt: Record<string, string>): Json {
  const dir = join(ctx.caseDir, label);
  mkdirSync(dir, { recursive: true });
  const out: Json = { at: stamp() };
  for (const [tag, sid] of Object.entries(ctx.sids)) {
    const files = storeFilesFor(sid);
    files.forEach((f, i) => copyFileSync(f, join(dir, `store-${tag}${i ? `-${i}` : ''}.jsonl`)));
    const store = files.flatMap(readJsonl);
    const inStore = new Set(store.map(entryId));
    const truth = [...ctx.keeper.truth(sid).values()].map((v) => v.entry);
    const held: Window = { name: 'held turn', from: heldSentAt };
    out[tag] = {
      storeFiles: files,
      storeEntries: store.length,
      transcriptEntries: truth.length,
      transcriptCopies: readdirSync(join(ctx.caseDir, 'seen')).filter((n) => n.endsWith(`__${sid}.jsonl`)),
      heldTurn: truth.filter((e) => isMessage(e) && inWindow(e, held, tag)).sort(byTime).map((e) => ({ ...turnRow(e, undefined), inStore: inStore.has(entryId(e)) })),
      inTranscriptsNotStore: truth.filter((e) => !inStore.has(entryId(e))).map((e) => `${String(e.uuid ?? '-')} ${describeEntry(e).slice(0, 110)}`),
      branches: { store: branchesOf(store), transcripts: branchesOf(truth) },
      invented: { transcripts: invented(truth), store: invented(store) },
    };
  }
  writeFileSync(join(dir, 'snapshot.json'), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

const BASE_CASES = ['stop', 'kill', 'crash', 'pd-stop', 'pd-kill', 'pd-crash', 'crash-stop', 'pd-crash-stop'] as const;
const NOW_CASES = ['stop-now', 'pd-stop-now', 'crash-stop-now', 'pd-crash-stop-now'] as const;
const CONTROL_CASES = ['pf-pd-stop-now', 'pf-crash-stop-now', 'pf-pd-crash-stop-now'] as const;
const CASES = [...BASE_CASES, ...NOW_CASES, ...CONTROL_CASES, 'pd-double'] as const;
type CaseName = (typeof CASES)[number];
type Variant = 'fresh' | 'resumed';

// The reset guard, sampled every 20 ms: the tag scan (for the agent name, no
// exclusions, as tag-guard.mts runs it) and the harness's own guard,
// liveClaudeCodes(config-dirs/<name>), at the same moment, against which of
// the old participant's processes (tracked by ProcWatch) are alive just
// before and just after the scan. Every ~250 ms it also runs
// proofs/tag-guard.mts as a separate process, no ancestor of any Claude Code.
class GuardSampler {
  readonly samples: Json[] = [];
  readonly scripts: Json[] = [];
  phase = 'running normally';
  timer: NodeJS.Timeout | undefined;
  scriptTimer: NodeJS.Timeout | undefined;
  readonly pending: Promise<void>[] = [];
  readonly pw: ProcWatch;
  constructor(pw: ProcWatch) {
    this.pw = pw;
  }
  old(): Tracked[] {
    return [...this.pw.tracked.values()].filter((t) => t.role !== 'participant');
  }
  sample(): void {
    const old = this.old();
    const before = new Set(old.filter((t) => !gone(t)).map((t) => t.pid));
    const scan = scanTag(RUN_NAME);
    const harness = liveClaudeCodes(AGENT_CONFIG_DIR).map((l) => l.pid);
    const after = new Set(old.filter((t) => !gone(t)).map((t) => t.pid));
    const found = new Set(scan.found.map((p) => p.pid));
    const through = [...before].filter((p) => after.has(p));
    const missed = through.filter((p) => !found.has(p)).map((p) => {
      const st = procStat(p);
      let environBytes: number | string;
      try {
        environBytes = readFileSync(`/proc/${p}/environ`).length;
      } catch (err) {
        environBytes = (err as NodeJS.ErrnoException).code ?? '?';
      }
      return { pid: p, role: this.pw.tracked.get(p)?.role, state: st?.state ?? null, environBytes };
    });
    const oldIds = new Set(old.map((t) => t.pid));
    this.samples.push({
      at: scan.at,
      t: scan.t,
      phase: this.phase,
      scanMs: scan.ms,
      oldAlive: through.map((p) => [p, this.pw.tracked.get(p)?.role]),
      oldClaudeAlive: through.filter((p) => !String(this.pw.tracked.get(p)?.role).endsWith('descendant')),
      uptimeTicks: scan.uptimeTicks,
      tagFound: scan.found.map((p) => [p.pid, p.pidFileLive ? 'live pid file' : 'no live pid file', p.starttime]),
      otherTagged: scan.found.filter((p) => !oldIds.has(p.pid)).map((p) => [p.pid, p.cmd.slice(0, 30)]),
      tagRefuses: scan.found.length > 0,
      harnessLive: harness,
      harnessRefuses: harness.length > 0,
      missed,
      ownUidUnreadable: scan.ownUidUnreadable.map((u) => [u.pid, u.state, u.code]),
    });
  }
  runScript(): void {
    const startedAt = stamp();
    const phase = this.phase;
    const oldAliveAtStart = this.old()
      .filter((t) => !gone(t))
      .map((t) => t.pid);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', GUARD_SCRIPT, RUN_NAME], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    this.pending.push(
      new Promise<void>((r) =>
        child.once('exit', (code) => {
          let parsed: Json | null = null;
          try {
            parsed = JSON.parse(out.trim()) as Json;
          } catch {}
          this.scripts.push({
            phase,
            startedAt,
            endedAt: stamp(),
            pid: child.pid,
            exit: code,
            refused: code === 1,
            scanAt: parsed?.at ?? null,
            found: ((parsed?.found as Json[] | undefined) ?? []).map((f) => [f.pid, f.pidFileLive]),
            oldAliveAtStart,
            oldAliveAtEnd: this.old()
              .filter((t) => !gone(t))
              .map((t) => t.pid),
            stderr: err.trim().slice(0, 300),
          });
          r();
        }),
      ),
    );
  }
  start(): void {
    this.timer = setInterval(() => this.sample(), 20);
    this.scriptTimer = setInterval(() => this.runScript(), 250);
    this.sample();
    this.runScript();
  }
  async stop(): Promise<void> {
    this.sample();
    if (this.timer) {
      clearInterval(this.timer);
    }
    if (this.scriptTimer) {
      clearInterval(this.scriptTimer);
    }
    await Promise.all(this.pending);
  }
  summary(): Json {
    const ss = this.samples;
    const withOld = ss.filter((x) => (x.oldAlive as unknown[]).length > 0);
    const noneAlive = ss.filter((x) => (x.oldAlive as unknown[]).length === 0 && (x.otherTagged as unknown[]).length === 0);
    const byPhase = (ph: string): Json => {
      const p = withOld.filter((x) => x.phase === ph);
      return {
        samplesWithOldAlive: p.length,
        tagRefused: p.filter((x) => x.tagRefuses).length,
        harnessRefused: p.filter((x) => x.harnessRefuses).length,
        samplesWithAMiss: p.filter((x) => (x.missed as unknown[]).length > 0).length,
      };
    };
    const sc = this.scripts;
    return {
      samples: ss.length,
      runningNormally: byPhase('running normally'),
      afterDeath: byPhase('after death'),
      samplesWithNoneAlive: noneAlive.length,
      tagRefusedWithNoneAlive: noneAlive.filter((x) => x.tagRefuses).length,
      misses: ss.filter((x) => (x.missed as unknown[]).length > 0).map((x) => ({ at: x.at, missed: x.missed })),
      script: {
        runs: sc.length,
        withOldAliveThroughout: sc.filter((x) => (x.oldAliveAtStart as unknown[]).length > 0 && (x.oldAliveAtEnd as unknown[]).length > 0).length,
        refusedOfThose: sc.filter((x) => (x.oldAliveAtStart as unknown[]).length > 0 && (x.oldAliveAtEnd as unknown[]).length > 0 && x.refused).length,
        withNoneAliveThroughout: sc.filter((x) => (x.oldAliveAtStart as unknown[]).length === 0).length,
        allowedOfThose: sc.filter((x) => (x.oldAliveAtStart as unknown[]).length === 0 && x.exit === 0).length,
      },
    };
  }
}

async function runCase(model: string, name: CaseName, variant: Variant): Promise<void> {
  const caseDir = join(RUNS, `${stamp().replace(/[:.]/g, '')}-orphan-tag-${name}-${variant}`);
  mkdirSync(caseDir, { recursive: true });
  const log = makeLog(new Recorder(join(caseDir, 'driver-log.txt')), 'driver: ');
  const finder: 'tag' | 'pidfile' = name.startsWith('pf-') ? 'pidfile' : 'tag';
  const base = name.replace(/^pf-/, '').replace(/-now$/, '');
  const pd = base.startsWith('pd-');
  const how: 'kill' | 'crash' = base.includes('crash') ? 'crash' : 'kill';
  const immediate = base.endsWith('stop');
  const now = name.endsWith('-now');
  const double = name === 'pd-double';
  log(`case ${name} ${variant}; layer 1 ${pd}; ending ${how}; stop by ${finder}; served ${now ? 'at once, by a participant started beforehand and sent GO on the death' : immediate ? 'at once, by a participant started after the death' : 'after the leftovers exit'}${double ? '; a second SIGINT from the driver on the death' : ''}; dir ${caseDir}`);

  // A clean start: the tag guard, then the harness's own reset script.
  const guard = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', GUARD_SCRIPT, RUN_NAME], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  log(`tag-guard ${RUN_NAME}: exit ${guard.status}; ${guard.stdout.trim()}`);
  if (guard.status !== 0) {
    throw new Error(`tag-guard refused: ${guard.stderr}`);
  }
  const reset = spawnSync('pnpm', ['reset-config-dir', RUN_NAME], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
  writeFileSync(join(caseDir, 'reset.json'), `${JSON.stringify({ guard: { status: guard.status, stdout: guard.stdout, stderr: guard.stderr }, status: reset.status, stdout: reset.stdout, stderr: reset.stderr }, null, 2)}\n`);
  log(`pnpm reset-config-dir ${RUN_NAME}: exit ${reset.status}; ${reset.stdout.trim().split('\n').at(-1)}`);
  if (reset.status !== 0) {
    throw new Error(`reset refused: ${reset.stderr}`);
  }

  const keeper = new Keeper(caseDir);
  keeper.addRoot(AGENT_CONFIG_DIR);
  keeper.start();
  const ours: Known[] = [];
  const sids: Record<string, string> = {};
  const note = (h: ParticipantHandle): void => {
    for (const c of pstate(h).convs) {
      keeper.addRoot(String(c.configDir));
      if (c.sessionId) {
        sids[String(c.tag)] = String(c.sessionId);
        keeper.watch(String(c.sessionId));
      }
      const pid = Number(c.claudePid);
      if (pid > 0 && typeof c.claudeStarttime === 'string' && !ours.some((o) => o.pid === pid && o.starttime === c.claudeStarttime)) {
        ours.push({ pid, starttime: c.claudeStarttime });
      }
    }
  };
  const ctx: Ctx = { caseDir, model, pd, finder, sids, keeper, ours, log, note };

  if (variant === 'resumed') {
    const h = startParticipant(caseDir, '0-seed', { model, ending: 'answer', pdeathsig: pd, stopOrphans: true, finder, ours: [...ours], convs: ['R', 'T'].map((tag) => ({ tag, say: PROMPTS.seed(WORDS[tag] as string), trigger: 'none' as const })) }, log);
    const ex = await h.exited;
    note(h);
    log(`seed exited ${JSON.stringify(ex)}; sessions ${JSON.stringify(sids)}`);
  }

  const toolLabel = `${name}-${variant}-${Date.now()}`;
  const h = startParticipant(
    caseDir,
    '1-serve',
    {
      model,
      ending: 'hold',
      pdeathsig: pd,
      stopOrphans: true,
      finder,
      ours: [...ours],
      convs: [
        { tag: 'R', say: PROMPTS.story, trigger: 'reply', ...(sids.R ? { sessionId: sids.R } : {}) },
        { tag: 'T', say: PROMPTS.tool(toolLabel), trigger: 'tool', toolLabel, ...(sids.T ? { sessionId: sids.T } : {}) },
      ],
    },
    log,
  );
  const ok = await Promise.race([h.ready, later(240_000).then(() => false)]);
  note(h);
  if (!ok) {
    throw new Error('1-serve: participant never reached mid-turn');
  }
  const held = pstate(h).convs;
  const heldSentAt: Record<string, string> = Object.fromEntries(held.map((c) => [String(c.tag), String(c.sentAt)]));
  const pw = new ProcWatch();
  pw.add(h.pid, 'participant');
  for (const c of held) {
    pw.add(Number(c.claudePid), `claude-${String(c.tag)}`);
    pw.addTree(Number(c.claudePid), `claude-${String(c.tag)}`);
  }
  pw.start();
  log(`1-serve: READY; sessions ${JSON.stringify(sids)}; tracked ${JSON.stringify([...pw.tracked.values()].map((t) => [t.pid, t.role, t.cmd.slice(0, 50)]))}`);

  // The serve 2 participant, for a -now case: started and loaded now, sent GO
  // the moment the driver sees the old participant exit.
  let pre: ParticipantHandle | undefined;
  if (now) {
    pre = startParticipant(caseDir, '2-serve', serveSpec(ctx, true), log);
    const armed = await Promise.race([pre.armed, later(30_000).then(() => false)]);
    if (!armed) {
      throw new Error('2-serve: never armed');
    }
    log(`2-serve: ARMED (pid ${pre.pid})`);
  }

  const sampler = new GuardSampler(pw);
  sampler.start();
  await sleep(600);

  const endSentAt = stamp();
  const endT = Date.now();
  let goSentAt: string | null = null;
  // Registered before the signal, so GO goes out in the same turn of the
  // event loop as the driver learns of the exit.
  const exitSeen = h.exited.then((e) => {
    if (pre) {
      goSentAt = pre.go();
    }
    sampler.phase = 'after death';
    return e;
  });
  signalChecked({ pid: h.pid, starttime: h.starttime }, how === 'kill' ? 'SIGKILL' : 'SIGUSR2', log);
  log(`${how === 'kill' ? 'KILL: SIGKILL' : 'CRASH: SIGUSR2 (uncaught exception)'} to participant ${h.pid}`);
  const pex = await Promise.race([exitSeen, later(60_000).then(() => undefined)]);
  if (!pex) {
    throw new Error('participant still running 60 s after its ending');
  }
  const ending: Json = {
    case: name,
    variant,
    layer1: pd,
    how,
    finder,
    now,
    endSentAt,
    participantExit: pex,
    goSentAt,
    msToParticipantExit: pex.t - endT,
    claudesAliveAtParticipantExit: pw.alive((t) => t.role.startsWith('claude')).map((t) => [t.pid, t.role]),
  };
  log(`participant exit ${JSON.stringify(pex)}; GO ${goSentAt}; alive then ${JSON.stringify(ending.claudesAliveAtParticipantExit)}`);

  if (double) {
    // A second SIGINT to every held Claude Code, as soon as the driver sees
    // the death (layer 1 has sent the first).
    const second: Json[] = [];
    for (const c of held) {
      const k = ours.find((o) => o.pid === Number(c.claudePid));
      if (!k) {
        continue;
      }
      const argv = readJson(join(String(c.runDir), 'claude', '1', 'argv.json'));
      const pidFile = argv ? join(String(argv.configDir), 'sessions', `${k.pid}.json`) : null;
      const pidFilePresent = pidFile ? existsSync(pidFile) : null;
      const sent = signalChecked(k, 'SIGINT', log);
      second.push({ tag: c.tag, pid: k.pid, sentAt: stamp(), sent, pidFilePresent });
    }
    ending.secondSigint = second;
    log(`second SIGINT: ${JSON.stringify(second)}`);
  }

  const stopSampler = (async () => {
    const deadline = Date.now() + 240_000;
    while (!pw.allGone((t) => t.role !== 'participant') && Date.now() < deadline) {
      await sleep(20);
    }
    await sleep(100);
    await sampler.stop();
  })();

  let serve2: { rows: Json[]; sentAt: Record<string, string> };
  if (immediate) {
    serve2 = await serveAgain(ctx, '2-serve', [{ name: 'held turn', from: heldSentAt }], pre);
  } else {
    const deadline = Date.now() + 240_000;
    while (!pw.allGone((t) => t.role !== 'participant') && Date.now() < deadline) {
      await sleep(50);
    }
    const left = pw.alive((t) => t.role !== 'participant');
    if (left.length > 0) {
      log(`still running 240 s after the ending; SIGKILL ${JSON.stringify(left.map((t) => t.pid))}`);
      for (const t of left) {
        signalChecked(t, 'SIGKILL', log);
      }
      ending.fallbackKilled = left.map((t) => [t.pid, t.role]);
    }
    await sleep(500);
    keeper.scan();
    ending.snapshot = snapshot(ctx, 'after-orphans', heldSentAt);
    serve2 = await serveAgain(ctx, '2-serve', [{ name: 'held turn', from: heldSentAt }]);
  }
  await stopSampler;
  const serve3 = await serveAgain(ctx, '3-serve', [
    { name: 'held turn', from: heldSentAt, to: serve2.sentAt },
    { name: 'serve 2 turn', from: serve2.sentAt, to: {} },
  ]);

  // Keep timing until everything tracked is gone, or 75 s after the death.
  const until = pex.t + 75_000;
  while (!pw.allGone() && Date.now() < until) {
    await sleep(50);
  }
  pw.stop();
  keeper.stop();
  writeFileSync(join(caseDir, 'guard-samples.jsonl'), sampler.samples.map((x) => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(join(caseDir, 'guard-scripts.jsonl'), sampler.scripts.map((x) => JSON.stringify(x)).join('\n') + '\n');
  ending.guard = sampler.summary();
  log(`guard: ${JSON.stringify(ending.guard)}`);
  const tool = {
    label: toolLabel,
    started: existsSync(join(WORK, `wait-${toolLabel}-started.txt`)) ? readFileSync(join(WORK, `wait-${toolLabel}-started.txt`), 'utf8').trim() : null,
    finished: existsSync(join(WORK, `wait-${toolLabel}-finished.txt`)) ? readFileSync(join(WORK, `wait-${toolLabel}-finished.txt`), 'utf8').trim() : null,
  };
  const timings = [...pw.tracked.values()].map((t) => ({ pid: t.pid, role: t.role, cmd: t.cmd, starttime: t.starttime, addedAt: t.addedAt, goneAt: t.goneAt, msAfterParticipantExit: t.goneT === null ? null : t.goneT - pex.t, tids: t.tids }));
  ending.stillAliveAtEnd = pw.alive().map((t) => [t.pid, t.role, t.cmd.slice(0, 60)]);
  log(`timings after participant exit (ms): ${JSON.stringify(timings.map((t) => [t.pid, t.role, t.cmd.slice(0, 30), t.msAfterParticipantExit]))}; tool ${JSON.stringify(tool)}`);
  writeFileSync(join(caseDir, 'result.json'), `${JSON.stringify({ ending, timings, tool, heldSentAt, ours, serve2: serve2.rows, serve3: serve3.rows }, null, 2)}\n`);
  log('case done');
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'participant' && rest[0]) {
  await participant(rest[0]);
} else if (mode === 'case' && rest[0] && (CASES as readonly string[]).includes(rest[1] ?? '') && ['fresh', 'resumed'].includes(rest[2] ?? '')) {
  await runCase(rest[0], rest[1] as CaseName, rest[2] as Variant);
} else {
  process.stderr.write(`usage:\n  case <model> <${CASES.join('|')}> <fresh|resumed>\n  participant <spec.json>\n`);
  process.exit(2);
}
