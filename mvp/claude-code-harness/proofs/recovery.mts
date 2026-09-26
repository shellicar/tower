// Proof 17: recovering unpublished entries when nobody knows how the last run
// ended.
//
// Stephen (27 Sep): "they need to prove its resilient / you cant just say 'i
// know how to recover from SIGKILL when I knew it was SIGKILL' that doesnt
// work". Proof 7's recover mode took the session ids, config dirs and store
// from the killed run's own record, and only ran after every orphan had
// exited. Here the check is blind: the same check runs on every serve, before
// the conversation's Claude Code starts, knowing only what a participant would
// know.
//
// What the participant knows (its "own config"), all constants in this file:
//   - the store root (STORE_DIR), the same for every run of this proof
//   - the root the harness puts every CLAUDE_CONFIG_DIR under (CONFIG_DIRS_ROOT)
//   - os.tmpdir(), where the SDK makes /tmp/claude-resume-* when resuming
//   - the working directory it runs Claude Code in (WORK)
//   - the model
// and, per conversation it is asked to serve: the session id (none for a new
// one) and the message to say. The participant process is started with a
// spec file holding only those two per conversation (plus where to write its
// own log). It never reads a previous participant's files.
//
// The driver is the test operator. It ends each participant in one of the
// case's ways, keeps copies of every transcript line it sees (the SDK deletes
// its resume dirs), and scores each serve against what was actually written.
// Only the driver reads previous runs' records, and only to score.
//
// Modes (from mvp/claude-code-harness/):
//
//   participant <spec.json>
//       One participant: checks each conversation it's given a session id for
//       (twice, to show the second adds nothing), then serves them.
//
//   case <model> <case> <fresh|resumed>
//       case: press1 press2 press3 kill kill-orphan crash claude-kill abort
//             reboot kill-twice (kill-twice is resumed only)
//
//   --analyse <case dir>
//
// TODO: undecided. Where the store lives. Built: one JSONL file per session
// key under STORE_DIR (a file store, as proof 7), the easiest that resumes.
//
// TODO: undecided. Where the check looks. Built: every directory under the
// harness's config-dirs root (each run gets a fresh CLAUDE_CONFIG_DIR, so a
// participant that doesn't know its predecessor's has to look in all of them)
// plus every /tmp/claude-resume-*. A participant with one fixed config dir
// would look in one place; that is not what the harness baseline is.
//
// TODO: undecided. How several transcripts of one session are combined and
// in what order what's missing is appended. Built: union by uuid (uuid-less
// entries by content), transcripts taken oldest mtime first, each in file
// order; missing entries appended at the end of the store's file.
//
// TODO: undecided. What the participant does when it finds a Claude Code
// still running on the session it's asked to serve. Built: the easiest, which
// is to log it and serve anyway.
//
// TODO: undecided. Press handling (press 1 interrupt then drain, press 2
// SIGTERM each Claude Code and stop waiting, press 3 process.exit) and abort
// are carried over from proof 7 to show what each leaves behind; none of it is
// the participant's design.

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSessionToStore, type SDKUserMessage, type SessionKey, type SessionStore, type SessionStoreEntry, type SpawnedProcess, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { LineRecorder, redact } from '../src/record.mts';

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
const STORE_DIR = join(STATE, 'stores', 'proof-17-recovery');
const CONFIG_DIRS_ROOT = join(STATE, 'config-dirs');
const RUN_NAME = 'recovery';
const WORK = join(STATE, 'work', RUN_NAME);

const TOOL_SLEEP_S = 60;
const REPLY_CHARS = 300;
const TOOL_DELAY_MS = 500;

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
  const report: CheckReport = {
    sessionId,
    startedAt,
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
    `check ${sessionId}: ${roots.length} roots in ${report.ms} ms; ${transcripts.length} transcript(s) [${transcripts.map((t) => `${t.root.startsWith(tmpdir()) ? basename(t.root) : `config-dirs/${basename(t.root)}`} ${t.lines} lines${t.unparseable ? ` ${t.unparseable} unparseable` : ''} imported ${t.imported}`).join('; ')}]; pid files ${JSON.stringify(pidFiles.map((p) => ({ pid: p.pid, alive: p.pidAlive, same: p.sameProcess, status: p.status })))}; cmdline ${JSON.stringify(runningByCmdline)}; union ${unionEntries}; ${keys.map((k) => `store ${k.storeBefore} -> ${k.storeAfter} (+${k.missing})`).join(', ')}; orphan: ${orphanPolicy}`,
  );
  return report;
}

// ---------------------------------------------------------------------------
// Direct spawn (from proof 7): the SDK's own spawn minus the capture wrapper,
// so the tree is participant -> claude and a killed participant leaves the
// real Claude Code as the orphan. Records claude/<n>/ like the wrapper.

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

function directSpawn(o: SpawnOptions): SpawnedProcess {
  const captureRoot = String(o.env.HARNESS_CAPTURE_DIR);
  const real = String(o.env.HARNESS_REAL_CLAUDE);
  const env = { ...o.env };
  delete env.HARNESS_CAPTURE_DIR;
  delete env.HARNESS_REAL_CLAUDE;
  const dir = claimSpawnDir(captureRoot);
  const runId = basename(dirname(captureRoot));
  mkdirSync(DEBUG_ROOT, { recursive: true });
  const debugFile = join(DEBUG_ROOT, `${runId}-${basename(dir)}.log`);
  const args = [...o.args, '--debug-file', debugFile];
  const child = spawn(real, args, { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
  writeFileSync(
    join(dir, 'argv.json'),
    `${JSON.stringify({ startedAt: stamp(), realBinary: real, argv: args, cwd: o.cwd, pid: child.pid, hostPid: process.pid, configDir: env.CLAUDE_CONFIG_DIR, debugFile, envNames: Object.keys(env).sort() }, null, 2)}\n`,
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
  log(`start; spec ${specPath}`);

  // 1. The check, before any Claude Code starts, so the check never sees this
  //    serve's own Claude Code, pid file or resume dir.
  for (const c of spec.convs) {
    if (!c.sessionId) {
      continue;
    }
    const first = await check(c.sessionId, (s) => log(`${c.tag}: ${s}`));
    const second = await check(c.sessionId, (s) => log(`${c.tag} (again): ${s}`));
    writeFileSync(join(out, `check-${c.tag}.json`), `${redact(JSON.stringify({ first, second }, null, 2)).text}\n`);
  }

  // 2. Serve.
  mkdirSync(WORK, { recursive: true });
  writeFileSync(join(WORK, 'wait.sh'), `date -u +%FT%T.%NZ > "wait-$1-started.txt"\nsleep ${TOOL_SLEEP_S}\ndate -u +%FT%T.%NZ > "wait-$1-finished.txt"\necho waited\n`);
  interface Part {
    c: ConvSpec;
    run: Run;
    abort: AbortController;
    ready: Promise<void>;
    result: Promise<string>;
    sessionId: Promise<string>;
    done: Promise<void>;
    bodies?: string;
  }
  const parts: Part[] = [];
  const state: Json = { participantPid: process.pid, startedAt: stamp(), convs: [] as Json[] };
  const writeState = (): void => writeFileSync(join(out, 'participant-state.json'), `${JSON.stringify(state, null, 2)}\n`);
  for (const c of spec.convs) {
    const abort = new AbortController();
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
      spawnClaudeCodeProcess: directSpawn,
      abortController: abort,
      ...(c.sessionId ? { resume: c.sessionId } : {}),
      ...(bodies ? { env: { ...process.env, OTEL_LOG_RAW_API_BODIES: `file:${bodies}` } } : {}),
    };
    const run = startRun({ name: RUN_NAME, options });
    run.done.catch(() => {});
    if (c.toolLabel) {
      rmSync(join(WORK, `wait-${c.toolLabel}-started.txt`), { force: true });
      rmSync(join(WORK, `wait-${c.toolLabel}-finished.txt`), { force: true });
    }
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
    const conv: Json = { tag: c.tag, runDir: run.dir, configDir: run.configDir, resumedFrom: c.sessionId ?? null, bodies: bodies ?? null };
    (state.convs as Json[]).push(conv);
    void sessionId.then((sid) => {
      conv.sessionId = sid;
      writeState();
    });
    parts.push({ c, run, abort, ready, result, sessionId, done, bodies });
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
    writeState();
    void found.exited.then((e) => {
      log(`${p.c.tag}: claude ${found.pid} exited ${JSON.stringify(e)}`);
      conv.claudeExit = e;
      writeState();
    });
  });
  writeState();

  if (spec.ending === 'answer') {
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

  // Held mid-turn; the driver ends it.
  let presses = 0;
  let stopWaiting: () => void = () => {};
  const stopped = new Promise<void>((r) => {
    stopWaiting = r;
  });
  process.on('SIGINT', () => {
    presses += 1;
    log(`SIGINT ${presses}`);
    if (presses === 1) {
      log('press 1: interrupt each, then end input and wait for everything to exit');
      for (const p of parts) {
        void (async () => {
          try {
            await p.run.interrupt();
            log(`${p.c.tag}: interrupt returned`);
          } catch (err) {
            log(`${p.c.tag}: interrupt failed: ${String(err)}`);
          }
          p.run.end();
          log(`${p.c.tag}: input ended`);
        })();
      }
    } else if (presses === 2) {
      log('press 2: SIGTERM each Claude Code, stop waiting');
      for (const p of parts) {
        const sp = claudeOf(p.run);
        if (sp && sp.child.exitCode === null && sp.child.signalCode === null) {
          try {
            process.kill(sp.pid, 'SIGTERM');
            log(`${p.c.tag}: SIGTERM ${sp.pid}`);
          } catch (err) {
            log(`${p.c.tag}: SIGTERM failed: ${String(err)}`);
          }
        }
      }
      stopWaiting();
    } else {
      log('press 3: process.exit(130)');
      process.exit(130);
    }
  });
  process.on('SIGUSR1', () => {
    log('SIGUSR1: abort each (the SDK abortController), wait for everything to exit');
    for (const p of parts) {
      p.abort.abort();
    }
  });
  process.on('SIGUSR2', () => {
    log('SIGUSR2: throwing an uncaught exception');
    setImmediate(() => {
      throw new Error('proof 17: uncaught exception in the participant');
    });
  });
  process.on('exit', (code) => {
    log(`exit ${code}`);
  });
  await Promise.all(parts.map((p) => p.ready));
  await Promise.all(pidsKnown);
  await Promise.race([Promise.all(parts.map((p) => p.sessionId)), later(3000)]);
  writeState();
  log('all mid-turn');
  process.stdout.write('READY\n');
  await Promise.race([Promise.allSettled(parts.map((p) => p.done)), stopped]);
  writeState();
  log('main returning (all done, or stopped waiting)');
}

// ---------------------------------------------------------------------------
// The driver: ends participants, keeps every transcript line it sees, scores.

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

interface ParticipantHandle {
  pid: number;
  dir: string;
  ready: Promise<boolean>;
  exited: Promise<{ at: string; code: number | null; signal: string | null }>;
}

function startParticipant(caseDir: string, label: string, spec: Omit<ParticipantSpec, 'outDir'>, log: (s: string) => void): ParticipantHandle {
  const dir = join(caseDir, label);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, `${JSON.stringify({ ...spec, outDir: dir }, null, 2)}\n`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SCRIPT, 'participant', specPath], { cwd: PACKAGE_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const outFile = createWriteStream(join(dir, 'participant-stdout.txt'));
  let buf = '';
  let readyR: (b: boolean) => void = () => {};
  const ready = new Promise<boolean>((r) => {
    readyR = r;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    outFile.write(chunk);
    buf += chunk.toString('utf8');
    let at = buf.indexOf('\n');
    while (at >= 0) {
      if (buf.slice(0, at) === 'READY') {
        readyR(true);
      }
      buf = buf.slice(at + 1);
      at = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk: Buffer) => outFile.write(chunk));
  const exited = new Promise<{ at: string; code: number | null; signal: string | null }>((r) =>
    child.once('exit', (code, signal) => {
      readyR(false);
      r({ at: stamp(), code, signal });
    }),
  );
  log(`${label}: participant pid ${child.pid}, dir ${relative(PACKAGE_ROOT, dir)}`);
  return { pid: child.pid as number, dir, ready, exited };
}

function pstate(h: ParticipantHandle): { convs: Json[] } {
  return JSON.parse(readFileSync(join(h.dir, 'participant-state.json'), 'utf8')) as { convs: Json[] };
}

const PROMPTS = {
  seed: (w: string): string => `Remember the code word ${w} for later. Reply with OK and nothing else.`,
  story: 'Write a 600-word story about a lighthouse keeper. No preamble.',
  story2: 'Write a 600-word story about a clockmaker. No preamble.',
  tool: (label: string): string => `Run \`bash wait.sh ${label}\` in the working directory with the Bash tool, then reply DONE.`,
};

const QUESTIONS: Record<string, string> = {
  R: 'Quote the final sentence of your previous reply exactly, or reply NONE if you have no previous reply.',
  T: 'In your previous turn you ran wait.sh with the Bash tool. What did the tool result say, and what did you reply after it? Quote both exactly, or reply NONE for either you did not see.',
};

async function waitGone(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((p) => !alive(p))) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function serveAgain(caseDir: string, label: string, model: string, sids: Record<string, string>, keeper: Keeper, log: (s: string) => void): Promise<Json[]> {
  // Truth as of now: every line of these sessions the driver has seen.
  keeper.scan();
  const truths: Record<string, Map<string, { entry: Json; copy: string }>> = {};
  for (const [tag, sid] of Object.entries(sids)) {
    truths[tag] = keeper.truth(sid);
  }
  const h = startParticipant(caseDir, label, { model, ending: 'answer', apiBodies: true, convs: Object.entries(sids).map(([tag, sid]) => ({ tag, sessionId: sid, say: QUESTIONS[tag] as string, trigger: 'none' as const })) }, log);
  const ex = await Promise.race([h.exited, later(400_000).then(() => undefined)]);
  log(`${label}: participant exited ${JSON.stringify(ex)}`);
  const st = pstate(h);
  for (const c of st.convs) {
    keeper.addRoot(String(c.configDir));
  }
  const rows: Json[] = [];
  for (const [tag, sid] of Object.entries(sids)) {
    const conv = st.convs.find((c) => c.tag === tag) as Json;
    const checks = JSON.parse(readFileSync(join(h.dir, `check-${tag}.json`), 'utf8')) as { first: CheckReport; second: CheckReport };
    const truth = truths[tag] as Map<string, { entry: Json; copy: string }>;
    // What the store held right after the check: its file, cut at the
    // length the check reported (this serve appended after).
    const k = checks.first.keys[0];
    const storeAfterCheck = k ? readJsonl(k.storeFile).slice(0, k.storeAfter) : [];
    const inStore = new Set(storeAfterCheck.map(entryId));
    const lost = [...truth.entries()].filter(([id]) => !inStore.has(id)).map(([, v]) => v);
    // Branches in the store after the check: a parentUuid with two children.
    const children = new Map<string, string[]>();
    for (const e of storeAfterCheck) {
      if (typeof e.parentUuid === 'string' && typeof e.uuid === 'string' && (e.type === 'user' || e.type === 'assistant')) {
        children.set(e.parentUuid, [...(children.get(e.parentUuid) ?? []), e.uuid]);
      }
    }
    const branches = [...children.entries()].filter(([, v]) => v.length > 1);
    // The part written last: the last few message entries of the truth, by
    // timestamp, each reduced to something findable in the request body.
    const msgs = [...truth.values()]
      .map((v) => v.entry)
      .filter((e) => (e.type === 'user' || e.type === 'assistant') && typeof e.timestamp === 'string')
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const tail = msgs.slice(-4);
    const bodyText = firstRequest(String(conv.bodies ?? ''));
    const fingerprints = tail.map((e) => {
      const fp = fingerprint(e);
      return { uuid: e.uuid, at: e.timestamp, what: describeEntry(e).slice(0, 100), fp, inRequest: fp === null || bodyText === null ? null : bodyText.includes(fp) };
    });
    rows.push({
      serve: label,
      tag,
      sessionId: sid,
      check: {
        ms: checks.first.ms,
        roots: checks.first.rootsSearched,
        transcripts: checks.first.transcripts.map((t) => ({ where: t.root.startsWith(tmpdir()) ? basename(t.root) : `config-dirs/${basename(t.root)}`, lines: t.lines, unparseable: t.unparseable, imported: t.imported, ageMs: Math.round(t.ageMs), importError: t.importError })),
        pidFiles: checks.first.pidFiles.map((p) => ({ pid: p.pid, status: p.status, pidAlive: p.pidAlive, sameProcess: p.sameProcess, where: p.root.startsWith(tmpdir()) ? basename(p.root) : `config-dirs/${basename(p.root)}` })),
        runningByCmdline: checks.first.runningByCmdline,
        orphan: checks.first.orphanPolicy,
        storeBefore: checks.first.keys.map((x) => x.storeBefore),
        added: checks.first.keys.map((x) => x.missing),
        addedEntries: checks.first.keys.flatMap((x) => x.added),
        secondCheckAdded: checks.second.keys.map((x) => x.missing),
        secondCheckStoreUnchanged: checks.second.keys.every((x) => x.storeShaBefore === x.storeShaAfter),
        transcriptsUnchanged: checks.first.transcriptsUnchanged && checks.second.transcriptsUnchanged,
      },
      truthEntries: truth.size,
      storeAfterCheck: storeAfterCheck.length,
      lost: lost.map((l) => `${String(l.entry.uuid ?? '-')} ${describeEntry(l.entry).slice(0, 110)} (seen in ${l.copy})`),
      storeBranches: branches.map(([p, c]) => ({ parent: p, children: c.map((u) => `${u} ${describeEntry(storeAfterCheck.find((e) => e.uuid === u) as Json).slice(0, 80)}`) })),
      lastWritten: fingerprints,
      requestFound: bodyText !== null,
      answer: conv.answer,
      runDir: relative(PACKAGE_ROOT, String(conv.runDir)),
    });
    if (bodyText !== null) {
      writeFileSync(join(h.dir, `first-request-${tag}.json`), redact(bodyText).text);
    }
  }
  writeFileSync(join(h.dir, 'score.json'), `${JSON.stringify(rows, null, 2)}\n`);
  for (const r of rows) {
    const c = r.check as Json;
    log(`${label} ${String(r.tag)}: found ${JSON.stringify(c.transcripts)}; pid files ${JSON.stringify(c.pidFiles)}; cmdline ${JSON.stringify(c.runningByCmdline)}; added ${JSON.stringify(c.added)} (again ${JSON.stringify(c.secondCheckAdded)}); lost ${(r.lost as string[]).length}; branches ${(r.storeBranches as Json[]).length}; last written in request ${JSON.stringify((r.lastWritten as Json[]).map((f) => f.inRequest))}; answer ${JSON.stringify(r.answer)}`);
  }
  return rows;
}

function fingerprint(e: Json): string | null {
  const content = (e.message as Json | undefined)?.content;
  if (typeof content === 'string') {
    return JSON.stringify(content.slice(-60)).slice(1, -1);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  for (const b of [...content].reverse() as Json[]) {
    if (b.type === 'text' && String(b.text).trim() !== '') {
      return JSON.stringify(String(b.text).slice(-60)).slice(1, -1);
    }
    if (b.type === 'tool_use') {
      return String(b.id);
    }
    if (b.type === 'tool_result') {
      return `"tool_use_id":"${String(b.tool_use_id)}"`;
    }
  }
  return null;
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

type CaseName = 'press1' | 'press2' | 'press3' | 'kill' | 'kill-orphan' | 'crash' | 'claude-kill' | 'abort' | 'reboot' | 'kill-twice';

const WORDS: Record<string, string> = { R: 'PERIWINKLE', T: 'MARIGOLD' };

async function runCase(model: string, name: CaseName, variant: 'fresh' | 'resumed'): Promise<void> {
  const caseDir = join(RUNS, `${stamp().replace(/[:.]/g, '')}-recovery-${name}-${variant}`);
  mkdirSync(caseDir, { recursive: true });
  const log = makeLog(new Recorder(join(caseDir, 'driver-log.txt')), 'driver: ');
  log(`case ${name} ${variant}; dir ${caseDir}`);
  const keeper = new Keeper(caseDir);
  keeper.start();
  const tagId = `${name}-${variant}-${Date.now()}`;
  const sids: Record<string, string> = {};
  const note = (h: ParticipantHandle): void => {
    for (const c of pstate(h).convs) {
      keeper.addRoot(String(c.configDir));
      if (c.sessionId) {
        sids[String(c.tag)] = String(c.sessionId);
        keeper.watch(String(c.sessionId));
      }
    }
  };

  // Seed: a clean one-turn serve, so the case's serve is a resume.
  if (variant === 'resumed') {
    const h = startParticipant(caseDir, '0-seed', { model, ending: 'answer', convs: ['R', 'T'].map((tag) => ({ tag, say: PROMPTS.seed(WORDS[tag] as string), trigger: 'none' as const })) }, log);
    const ex = await h.exited;
    note(h);
    log(`seed exited ${JSON.stringify(ex)}; sessions ${JSON.stringify(sids)}`);
  }

  const heldServe = async (label: string, story: string, tool: string): Promise<{ h: ParticipantHandle; claudes: number[] }> => {
    const convs: ConvSpec[] = [
      { tag: 'R', say: story, trigger: 'reply', ...(sids.R ? { sessionId: sids.R } : {}) },
      { tag: 'T', say: PROMPTS.tool(tool), trigger: 'tool', toolLabel: tool, ...(sids.T ? { sessionId: sids.T } : {}) },
    ];
    const h = startParticipant(caseDir, label, { model, ending: 'hold', convs }, log);
    const ok = await Promise.race([h.ready, later(240_000).then(() => false)]);
    note(h);
    if (!ok) {
      throw new Error(`${label}: participant never reached mid-turn`);
    }
    const claudes = pstate(h)
      .convs.map((c) => Number(c.claudePid))
      .filter((p) => p > 0);
    log(`${label}: READY; sessions ${JSON.stringify(sids)}; claude pids ${JSON.stringify(claudes)}`);
    return { h, claudes };
  };

  const allOf = (claudes: number[]): number[] => [...claudes, ...claudes.flatMap((p) => descendants(p).map((d) => d.pid))];

  let label = '1-serve';
  const { h, claudes } = await heldServe(label, PROMPTS.story, `${tagId}-1`);
  const procs = allOf(claudes);
  log(`${label}: claude processes and descendants ${JSON.stringify(procs.map((p) => [p, cmdline(p).slice(0, 60)]))}`);
  const ending: Json = { case: name, variant, at: stamp() };
  const press = async (n: number): Promise<void> => {
    if (!alive(h.pid)) {
      log(`press ${n}: participant already exited; not sent`);
      return;
    }
    process.kill(h.pid, 'SIGINT');
    log(`PRESS ${n}: SIGINT to participant ${h.pid}`);
  };
  let orphanServe: Json[] | undefined;
  switch (name) {
    case 'press1':
      await press(1);
      break;
    case 'press2':
      await press(1);
      await sleep(20);
      await press(2);
      break;
    case 'press3':
      await press(1);
      await sleep(20);
      await press(2);
      await sleep(20);
      await press(3);
      break;
    case 'kill':
    case 'kill-orphan':
    case 'reboot':
    case 'kill-twice':
      process.kill(h.pid, 'SIGKILL');
      log(`KILL: SIGKILL to participant ${h.pid}`);
      break;
    case 'crash':
      process.kill(h.pid, 'SIGUSR2');
      log(`CRASH: SIGUSR2 to participant ${h.pid} (it throws an uncaught exception)`);
      break;
    case 'claude-kill':
      for (const p of claudes) {
        process.kill(p, 'SIGKILL');
      }
      log(`CLAUDE-KILL: SIGKILL to ${JSON.stringify(claudes)}; participant lives on`);
      break;
    case 'abort':
      process.kill(h.pid, 'SIGUSR1');
      log(`ABORT: SIGUSR1 to participant ${h.pid} (it aborts each query)`);
      break;
  }
  const pex = await Promise.race([h.exited, later(120_000).then(() => undefined)]);
  ending.participantExit = pex ?? 'still running after 120 s';
  ending.claudesAliveAfterParticipantExit = claudes.filter(alive);
  ending.procsAliveAfterParticipantExit = procs.filter(alive).map((p) => [p, cmdline(p).slice(0, 60)]);
  log(`${label}: participant exit ${JSON.stringify(pex)}; claude processes alive: ${JSON.stringify(ending.claudesAliveAfterParticipantExit)}; any of their tree alive: ${JSON.stringify(ending.procsAliveAfterParticipantExit)}`);
  if (!pex) {
    process.kill(h.pid, 'SIGKILL');
  }

  if (name === 'kill-orphan') {
    // Served again at once, while the orphans run (T is inside a 60 s tool).
    ending.orphansAliveAtServe = claudes.filter(alive);
    log(`kill-orphan: serving again while ${JSON.stringify(ending.orphansAliveAtServe)} still run`);
    orphanServe = await serveAgain(caseDir, '2-serve-while-orphan', model, { ...sids }, keeper, log);
    ending.orphansAliveAfterOrphanServe = claudes.filter(alive);
  }
  if (name === 'reboot') {
    // A reboot: every process gone, /tmp emptied. Only this case's own
    // resume dirs are deleted; other sessions on this machine have theirs.
    for (const p of procs.filter(alive)) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {}
    }
    await waitGone(procs, 10_000);
    keeper.scan();
    const mine = resumeDirs().filter((d) => Object.values(sids).some((sid) => subdirs(join(d, 'projects')).some((p) => existsSync(join(p, `${sid}.jsonl`)))));
    for (const d of mine) {
      rmSync(d, { recursive: true, force: true });
    }
    ending.rebootDeleted = mine;
    log(`reboot: killed ${JSON.stringify(procs)}; deleted ${JSON.stringify(mine)}`);
  }
  const gone = await waitGone(procs, 240_000);
  ending.allClaudeProcsGone = gone;
  if (!gone) {
    log('claude processes still running after 240 s; SIGKILL');
    for (const p of procs.filter(alive)) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {}
    }
  }
  await sleep(500);
  keeper.scan();
  ending.resumeDirsLeft = resumeDirs().filter((d) => Object.values(sids).some((sid) => subdirs(join(d, 'projects')).some((p) => existsSync(join(p, `${sid}.jsonl`)))));
  log(`after the ending: resume dirs holding these sessions: ${JSON.stringify(ending.resumeDirsLeft)}`);

  if (name === 'kill-twice') {
    label = '2-serve';
    const second = await heldServe(label, PROMPTS.story2, `${tagId}-2`);
    const procs2 = allOf(second.claudes);
    process.kill(second.h.pid, 'SIGKILL');
    log(`KILL 2: SIGKILL to participant ${second.h.pid}`);
    await second.h.exited;
    ending.secondKillGone = await waitGone(procs2, 240_000);
    await sleep(500);
    keeper.scan();
    ending.resumeDirsLeftAfterSecond = resumeDirs().filter((d) => Object.values(sids).some((sid) => subdirs(join(d, 'projects')).some((p) => existsSync(join(p, `${sid}.jsonl`)))));
    log(`after the second kill: resume dirs holding these sessions: ${JSON.stringify(ending.resumeDirsLeftAfterSecond)}`);
  }
  writeFileSync(join(caseDir, 'ending.json'), `${JSON.stringify(ending, null, 2)}\n`);

  const rows = await serveAgain(caseDir, name === 'kill-orphan' ? '3-serve-after-orphan' : name === 'kill-twice' ? '3-serve' : '2-serve', model, { ...sids }, keeper, log);
  keeper.stop();
  writeFileSync(join(caseDir, 'result.json'), `${JSON.stringify({ ending, orphanServe, serve: rows }, null, 2)}\n`);
  log('case done');
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const CASES = ['press1', 'press2', 'press3', 'kill', 'kill-orphan', 'crash', 'claude-kill', 'abort', 'reboot', 'kill-twice'];
if (mode === 'participant' && rest[0]) {
  await participant(rest[0]);
} else if (mode === 'case' && rest[0] && CASES.includes(rest[1] ?? '') && (rest[2] === 'fresh' || rest[2] === 'resumed')) {
  await runCase(rest[0], rest[1] as CaseName, rest[2]);
} else {
  process.stderr.write(`usage:\n  case <model> <${CASES.join('|')}> <fresh|resumed>\n  participant <spec.json>\n`);
  process.exit(2);
}
