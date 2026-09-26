// Proof 7: the participant stopped or killed while Claude Code is mid-turn.
//
// Stephen's three Ctrl-C presses (26 Sep): first "try to exit *gracefully*,
// that is, stop what its doing, and wait till everything exits"; second
// "still try to shut down, but dont wait"; third "instant termination".
// "ctrl-c is what we're going for, not claude code being kill -9". On the
// participant itself dying: "we should at least know/understand what happens
// on a SIGKILL". "can we test if there's any different from sending
// sigint/term to the child process and using abort?"
//
// What the participant learns comes through the SDK's session store, eager
// flush, as in proof 3. Every store append is recorded synchronously
// (appendFileSync) to <run>/store-appends.jsonl, so "reached append()" stays
// exact even when the host is SIGKILLed.
//
// The capture wrapper is not used here. Each Claude Code is spawned directly
// by the host through the SDK's spawnClaudeCodeProcess hook, with the same
// command line, env and abort signal the SDK would use, so the process tree is
// the participant's (host -> claude) and a process-group signal reaches each
// Claude Code once, not twice. The hook records into the same files the
// wrapper would (claude/<n>/argv.json with the real pid, stdin/stdout/stderr,
// exit.json) and adds --debug-file (outside the repo; copied redacted).
//
// Modes (from mvp/claude-code-harness/):
//
//   stop <model> <abort|interrupt|sigint|sigterm> <reply|tool>
//       Q1. One Claude Code, stopped mid-reply (after 300 streamed text
//       characters) or mid-tool (500 ms after wait.sh stamps its start).
//       abort: the SDK's abortController. interrupt: query.interrupt(), wait
//       for the result, then end() the input. sigint/sigterm: the signal sent
//       by the host straight to the real claude pid.
//
//   drive <model> <press-interrupt|press-abort> <host|group> <gap ms>
//       Q2. Starts `strace -f ... setsid node stopped.mts host ...` (the host
//       leads its own process group, strace is outside it), waits until three
//       Claude Codes are mid-turn (a: counting, b: inside wait.sh, c: a
//       story), then presses Ctrl-C three times, gap ms apart, while the host
//       is alive: `host` sends SIGINT to the host pid only; `group` to the
//       host's whole process group, as a terminal does. Snapshots after each
//       press; waits for every traced process to exit.
//
//   drive <model> kill-fresh
//   drive <model> kill-resume <seed dir>
//       Q3. Same three, fresh or resumed through a file-backed store, then
//       SIGKILL to the host pid only. Watches what the orphaned Claude Codes
//       do until every traced process has exited (bounded).
//
//   seed <model>
//       Q3 prep: three one-turn conversations in a file-backed store, for
//       kill-resume.
//
//   recover <model> <kill drive dir>
//       Q4. Finds each conversation's transcript where Claude Code left it,
//       publishes what the store is missing, then resumes through the store
//       (and, as a control, through a copy of the store as it was before) and
//       asks about the part that had not been published.
//
//   --analyse <run dir | drive dir> [...]
//
// TODO: undecided. Everything the host does on each press (interrupt vs
// AbortController for press 1, SIGTERM to each Claude Code then stop waiting
// for press 2, process.exit for press 3) is carried over from proof 3 only to
// show what each reaches; none of it is the participant's design (Stephen:
// "the exact implementation or mechanics can change").
//
// TODO: undecided. Where the store lives (Stephen: a local file, tower, or
// both). Built: one JSONL file per session under
// ~/.local/state/tower-claude-code-harness/stores/<id>/, the easiest thing
// that resumes. It stands in for whatever the store becomes.
//
// TODO: undecided. How unpublished entries are found and published on the
// next serve (recover mode). Built: look in the conversation's config dir and
// in every /tmp/claude-resume-*, read the session with the SDK's
// importSessionToStore, publish entries the store doesn't have (by uuid;
// uuid-less entries by content, counted). One way, not the design.

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSessionToStore, type SDKMessage, type SDKUserMessage, type SessionKey, type SessionStore, type SessionStoreEntry, type SpawnedProcess, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { LineRecorder, redact } from '../src/record.mts';

// The harness's stamp() is performance.timeOrigin + performance.now(): the
// monotonic clock offset once at process start. On this WSL2 machine that
// was seen 140-170 ms away from the wall clock that strace and Claude Code
// (its debug log and transcript timestamps) use, differently per process. So
// every time this proof compares is taken from the wall clock, to the
// millisecond, in every process.
const stamp = (): string => new Date().toISOString();

const SCRIPT = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = join(dirname(SCRIPT), '..');
const RUNS = join(PACKAGE_ROOT, 'runs');
const STATE = join(homedir(), '.local', 'state', 'tower-claude-code-harness');
const DEBUG_ROOT = join(STATE, 'debug');
const STORES = join(STATE, 'stores');

type Json = Record<string, unknown>;

const COUNT = 'Count from 1 to 400, one number per line, no other text.';
const TOOL = 'Run `bash wait.sh` in the working directory with the Bash tool, then reply DONE.';
const STORY = 'Write a 600-word story about a lighthouse keeper. No preamble.';
const WAIT_SH = 'date -u +%FT%T.%NZ > wait-started.txt\nsleep 25\ndate -u +%FT%T.%NZ > wait-finished.txt\necho waited\n';
const REPLY_CHARS = 300;
const TOOL_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Small helpers

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
// For races: a timer that doesn't keep the process alive, so what holds a
// host open after its work is done is the SDK's and Claude Code's, not ours.
const later = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms).unref();
  });

function toMs(s: string): number {
  // ISO, to the millisecond (this proof) or microsecond (the harness).
  const micro = s.slice(23, 26);
  return Date.parse(`${s.slice(0, 23)}Z`) + (/^\d{3}$/.test(micro) ? Number(micro) / 1000 : 0);
}

function isoFromEpoch(sec: number): string {
  const ms = sec * 1000;
  const whole = Math.floor(ms);
  const micros = Math.round((ms - whole) * 1000);
  return new Date(whole).toISOString().replace('Z', `${String(Math.min(micros, 999)).padStart(3, '0')}Z`);
}

function rel(t: number | undefined, t0: number): string {
  return t === undefined ? '-' : `${t - t0 >= 0 ? '+' : ''}${(t - t0).toFixed(1)}ms`;
}

function readJsonl(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkJsonl(p));
    } else if (e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}

// Names, sizes and modes only; nothing is read (a config dir can hold
// .credentials.json).
function listTree(root: string): { path: string; size: number; mode: string }[] {
  const out: { path: string; size: number; mode: string }[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        const st = lstatSync(p);
        out.push({ path: relative(root, p), size: st.size, mode: (st.mode & 0o777).toString(8) });
      } catch {}
      if (e.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(root);
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

function describeEntry(e: Json): string {
  const msg = e.message as Json | undefined;
  const att = e.attachment as Json | undefined;
  let what = String(e.type);
  if (att) {
    what += `/${String(att.type)}`;
  }
  if (e.subtype) {
    what += `/${String(e.subtype)}`;
  }
  if (e.operation) {
    what += `/${String(e.operation)}`;
  }
  const content = msg?.content;
  if (typeof content === 'string') {
    what += ` "${content.slice(0, 50).replace(/\n/g, '\\n')}"`;
  } else if (Array.isArray(content)) {
    what += ` [${content
      .map((b: Json) => {
        if (b.type === 'text') {
          const t = String(b.text);
          return `text "${t.slice(0, 40).replace(/\n/g, '\\n')}${t.length > 40 ? `...${t.slice(-16).replace(/\n/g, '\\n')}` : ''}"(${t.length})`;
        }
        if (b.type === 'tool_use') {
          return `tool_use ${String(b.name)}`;
        }
        if (b.type === 'tool_result') {
          return `tool_result${b.is_error ? ' is_error' : ''} ${JSON.stringify(b.content).slice(0, 50)}`;
        }
        return String(b.type);
      })
      .join(' | ')}]`;
  }
  if (msg && 'stop_reason' in msg) {
    what += ` stop=${String(msg.stop_reason)}`;
  }
  if (e.isAbortedMidStream) {
    what += ' isAbortedMidStream';
  }
  if (e.toolDenialKind) {
    what += ` toolDenialKind=${String(e.toolDenialKind)}`;
  }
  return what;
}

function isMarker(e: Json): boolean {
  const c = (e.message as Json | undefined)?.content;
  return e.type === 'user' && Array.isArray(c) && c.some((b: Json) => b.type === 'text' && String(b.text).startsWith('[Request interrupted by user'));
}

function isPartial(e: Json): boolean {
  return e.type === 'assistant' && e.isAbortedMidStream === true;
}

// /proc/<pid>/stat: state is the field after the parenthesised comm.
function procStat(pid: number): { state: string; ppid: number; pgid: number } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0] ?? '?', ppid: Number(f[1]), pgid: Number(f[2]) };
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
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 160);
  } catch {
    return '?';
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
      out.push({ pid: k, cmd: cmdline(k) });
      walk(k);
    }
  };
  walk(pid);
  return out;
}

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

function makeLog(rec: Recorder, prefix = ''): (s: string) => void {
  return (s: string): void => {
    const line = `${stamp()} ${prefix}${s}`;
    process.stdout.write(`${line}\n`);
    rec.write(line);
  };
}

// Records every append() (synchronously), and when given a directory also
// keeps the entries there as one JSONL file per session key, which is what
// load() returns on resume.
class Store implements SessionStore {
  readonly rec = new Recorder('store-appends.jsonl');
  readonly dir: string | undefined;
  calls = 0;
  constructor(dir?: string) {
    this.dir = dir;
  }
  file(key: SessionKey): string {
    return join(this.dir as string, key.projectKey, `${key.sessionId}${key.subpath ? `/${key.subpath}` : ''}.jsonl`);
  }
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.calls += 1;
    this.rec.write({ ts: stamp(), call: this.calls, key, count: entries.length, entries });
    if (this.dir) {
      const f = this.file(key);
      mkdirSync(dirname(f), { recursive: true });
      appendFileSync(f, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
    }
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const f = this.dir ? this.file(key) : undefined;
    const found = f !== undefined && existsSync(f);
    this.rec.write({ ts: stamp(), event: 'load', key, file: f ?? null, found });
    return found ? (readJsonl(f as string) as SessionStoreEntry[]) : null;
  }
}

// Records when each transcript line first appears on disk. fs.watch
// triggers a scan; a 20 ms poll catches anything it misses. Also tracks the
// SDK's temporary resume dirs (/tmp/claude-resume-*).
class TranscriptWatcher {
  readonly rec: Recorder;
  readonly offsets = new Map<string, { bytes: number; lines: number; partial: string }>();
  readonly roots = new Set<string>();
  readonly watchers: FSWatcher[] = [];
  readonly tmpSeen = new Map<string, string>();
  timer: NodeJS.Timeout | undefined;
  constructor(file = 'transcript-watch.jsonl') {
    this.rec = new Recorder(file);
  }

  addRoot(root: string): void {
    if (this.roots.has(root)) {
      return;
    }
    this.roots.add(root);
    try {
      this.watchers.push(watch(root, { recursive: true }, () => this.scan()));
    } catch (err) {
      this.rec.write({ ts: stamp(), event: 'watch-failed', root, message: (err as Error).message });
    }
    this.rec.write({ ts: stamp(), event: 'root', root });
    this.scan();
  }

  start(): void {
    this.timer = setInterval(() => {
      this.scanTmp();
      this.scan();
    }, 20);
    this.timer.unref();
  }

  stop(): void {
    this.scanTmp();
    this.scan();
    if (this.timer) {
      clearInterval(this.timer);
    }
    for (const w of this.watchers) {
      w.close();
    }
  }

  scanTmp(): void {
    let names: string[];
    try {
      names = readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-'));
    } catch {
      return;
    }
    for (const name of names) {
      const root = join(tmpdir(), name);
      const listing = listTree(root);
      const key = JSON.stringify(listing);
      if (this.tmpSeen.get(root) !== key) {
        this.tmpSeen.set(root, key);
        this.rec.write({ ts: stamp(), event: 'tmp-config-dir', root, listing });
      }
      this.addRoot(root);
    }
    for (const root of this.tmpSeen.keys()) {
      if (!existsSync(root) && this.tmpSeen.get(root) !== 'gone') {
        this.tmpSeen.set(root, 'gone');
        this.rec.write({ ts: stamp(), event: 'tmp-config-dir-gone', root });
      }
    }
  }

  scan(): void {
    for (const root of this.roots) {
      for (const file of walkJsonl(join(root, 'projects'))) {
        this.read(root, file);
      }
    }
  }

  read(root: string, file: string): void {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    const at = this.offsets.get(file) ?? { bytes: 0, lines: 0, partial: '' };
    if (size <= at.bytes) {
      this.offsets.set(file, at);
      return;
    }
    const ts = stamp();
    let buf: Buffer;
    try {
      buf = readFileSync(file);
    } catch {
      return;
    }
    const text = at.partial + buf.subarray(at.bytes).toString('utf8');
    const parts = text.split('\n');
    const partial = parts.pop() ?? '';
    for (const raw of parts) {
      at.lines += 1;
      let entry: Json = {};
      try {
        entry = JSON.parse(raw) as Json;
      } catch {}
      this.rec.write({ ts, root, file: relative(root, file), line: at.lines, type: entry.type, uuid: entry.uuid });
    }
    this.offsets.set(file, { bytes: buf.length, lines: at.lines, partial });
  }
}

// ---------------------------------------------------------------------------
// Direct spawn: the SDK's own spawn, minus the capture wrapper, recorded.

interface Spawned {
  pid: number;
  dir: string;
  child: ChildProcess;
  exited: Promise<{ at: string; code: number | null; signal: NodeJS.Signals | null }>;
}

// Keyed by the harness's capture dir (<run dir>/claude).
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
  // As the SDK's spawnLocalProcess: same stdio, abort signal and env.
  const child = spawn(real, args, { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
  writeFileSync(
    join(dir, 'argv.json'),
    `${JSON.stringify({ startedAt: stamp(), realBinary: real, argv: args, cwd: o.cwd, pid: child.pid, hostPid: process.pid, debugFile, envNames: Object.keys(env).sort() }, null, 2)}\n`,
  );
  const stdinRec = new LineRecorder(createWriteStream(join(dir, 'stdin.txt')));
  const stdoutRec = new LineRecorder(createWriteStream(join(dir, 'stdout.txt')));
  const stderrRec = new LineRecorder(createWriteStream(join(dir, 'stderr.txt')));
  // Tap without adding a listener or a pipe to the streams the SDK reads.
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
  const direct = spawned.get(join(run.dir, 'claude'))?.at(-1);
  if (direct || process.env.PROOF7_SPAWN !== 'wrapper') {
    return direct;
  }
  // Wrapper control: the real claude is the wrapper's child; exit is polled.
  try {
    const { wrapperPid } = JSON.parse(readFileSync(join(run.dir, 'claude', '1', 'argv.json'), 'utf8')) as { wrapperPid: number };
    const pid = Number(readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, 'utf8').trim().split(/\s+/)[0]);
    const exited = new Promise<{ at: string; code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const t = setInterval(() => {
        if (!alive(pid)) {
          clearInterval(t);
          resolve({ at: stamp(), code: null, signal: null });
        }
      }, 10);
    });
    return { pid, dir: join(run.dir, 'claude', '1'), child: undefined as unknown as ChildProcess, exited };
  } catch {
    return undefined;
  }
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
// Options and turns

const baseOptions = (model: string, store: SessionStore): HarnessOptions => ({
  model,
  includePartialMessages: true,
  tools: ['Read', 'Bash'],
  allowedTools: ['Read', 'Bash'],
  thinking: { type: 'adaptive', display: 'summarized' },
  sessionStore: store,
  sessionStoreFlush: 'eager',
  // PROOF7_SPAWN=wrapper: the SDK's own spawn through the harness's capture
  // wrapper, as a control for anything the direct spawn might change.
  ...(process.env.PROOF7_SPAWN === 'wrapper' ? {} : { spawnClaudeCodeProcess: directSpawn }),
});

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function prepareCwd(cwd: string): void {
  writeFileSync(join(cwd, 'wait.sh'), WAIT_SH);
  rmSync(join(cwd, 'wait-started.txt'), { force: true });
  rmSync(join(cwd, 'wait-finished.txt'), { force: true });
}

function readIf(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : 'never';
}

// Consumes a run's SDK messages; resolves `ready` at the mid-turn trigger.
interface Consumer {
  ready: Promise<void>;
  result: Promise<string>;
  sessionId: Promise<string>;
  consumed: Promise<void>;
  lastText: () => string;
}

function consume(run: Run, trigger: 'reply' | 'tool' | 'none', log: (s: string) => void): Consumer {
  let chars = 0;
  let text = '';
  let readyResolve: () => void = () => {};
  let resultResolve: (s: string) => void = () => {};
  let sidResolve: (s: string) => void = () => {};
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  const result = new Promise<string>((r) => {
    resultResolve = r;
  });
  const sessionId = new Promise<string>((r) => {
    sidResolve = r;
  });
  let fired = false;
  const fire = (why: string): void => {
    if (!fired) {
      fired = true;
      log(`mid-turn: ${why}`);
      readyResolve();
    }
  };
  if (trigger === 'tool') {
    const started = join(run.cwd, 'wait-started.txt');
    const poll = setInterval(() => {
      if (existsSync(started)) {
        clearInterval(poll);
        setTimeout(() => fire(`wait.sh started ${readIf(started)}, +${TOOL_DELAY_MS} ms`), TOOL_DELAY_MS);
      }
    }, 20);
    poll.unref();
  }
  const consumed = (async () => {
    let line = 0;
    try {
      for await (const m of run.messages()) {
        line += 1;
        if (m.type === 'system' && m.subtype === 'init') {
          sidResolve(m.session_id);
        }
        if (m.type === 'stream_event' && m.parent_tool_use_id == null && m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta') {
          chars += m.event.delta.text.length;
          text += m.event.delta.text;
          if (trigger === 'reply' && chars >= REPLY_CHARS) {
            fire(`${chars} text chars streamed (sdk line ${line})`);
          }
        }
        if (m.type === 'result') {
          log(`sdk line ${line}: result ${m.subtype}`);
          resultResolve(m.subtype === 'success' ? m.result : m.subtype);
        }
      }
    } catch (err) {
      log(`messages threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    resultResolve('(no result)');
  })();
  return { ready, result, sessionId, consumed, lastText: () => text };
}

// ---------------------------------------------------------------------------
// Q1: one Claude Code stopped four ways

async function stopOne(model: string, method: 'abort' | 'interrupt' | 'sigint' | 'sigterm', point: 'reply' | 'tool'): Promise<void> {
  const store = new Store();
  const abort = new AbortController();
  const logRec = new Recorder('proof-log.txt');
  const watcher = new TranscriptWatcher();
  const run = startRun({ name: `stopped-one-${point}`, options: { ...baseOptions(model, store), abortController: abort } });
  // Awaited later; a rejection before then must not crash the process.
  run.done.catch(() => {});
  store.rec.attach(run.dir);
  logRec.attach(run.dir);
  watcher.rec.attach(run.dir);
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}`);
  log(`method ${method}, point ${point}, straced: ${process.env.PROOF7_STRACED ?? 'no'}`);
  prepareCwd(run.cwd);
  watcher.addRoot(run.configDir);
  watcher.start();
  const c = consume(run, point, log);
  run.send(user(point === 'reply' ? COUNT : TOOL));
  const timedOut = await Promise.race([c.ready.then(() => false), later(90_000).then(() => true)]);
  if (timedOut) {
    log('never reached mid-turn in 90 s; stopping anyway');
  }
  const sp = claudeOf(run);
  if (!sp) {
    throw new Error('no claude process recorded');
  }
  const tree = descendants(sp.pid);
  log(`claude pid ${sp.pid}; its descendants: ${JSON.stringify(tree)}`);
  const stop: Json = { method, point, pid: sp.pid, hostPid: process.pid, tree };
  stop.stopAt = stamp();
  log(`STOP ${method}`);
  if (method === 'abort') {
    abort.abort();
  } else if (method === 'interrupt') {
    try {
      await run.interrupt();
      stop.interruptReturnedAt = stamp();
      log('interrupt returned');
    } catch (err) {
      stop.interruptError = String(err);
      log(`interrupt failed: ${String(err)}`);
    }
    await Promise.race([c.result, later(15_000)]);
    stop.resultAt = stamp();
    log('result seen (or 15 s); end() the input');
    stop.endAt = stamp();
    run.end();
  } else {
    process.kill(sp.pid, method === 'sigint' ? 'SIGINT' : 'SIGTERM');
    log(`${method.toUpperCase()} sent to claude pid ${sp.pid}`);
  }
  const exit = await Promise.race([sp.exited, later(30_000).then(() => undefined)]);
  stop.exit = exit ?? 'still running after 30 s';
  log(`claude exit: ${JSON.stringify(exit)}`);
  // What became of Claude Code's own children (wait.sh, sleep).
  const fates: Json[] = [];
  const deadline = Date.now() + 30_000;
  const pending = new Map(tree.map((t) => [t.pid, t.cmd]));
  const aliveAtExit = tree.filter((t) => alive(t.pid)).map((t) => t.pid);
  while (pending.size > 0 && Date.now() < deadline) {
    for (const [pid, cmd] of pending) {
      if (!alive(pid)) {
        fates.push({ pid, cmd, goneAt: stamp() });
        pending.delete(pid);
      }
    }
    await sleep(50);
  }
  for (const [pid, cmd] of pending) {
    fates.push({ pid, cmd, goneAt: 'still running after 30 s' });
  }
  stop.childrenAliveAtClaudeExit = aliveAtExit;
  stop.childFates = fates;
  if (!exit) {
    try {
      process.kill(sp.pid, 'SIGKILL');
      log('cleanup: SIGKILL to the claude pid');
    } catch {}
  }
  try {
    await run.done;
    log('run.done settled');
  } catch (err) {
    log(`run.done rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
  await c.consumed;
  stop.waitStarted = readIf(join(run.cwd, 'wait-started.txt'));
  stop.waitFinished = readIf(join(run.cwd, 'wait-finished.txt'));
  writeFileSync(join(run.dir, 'stop.json'), `${JSON.stringify(stop, null, 2)}\n`);
  await sleep(500);
  watcher.stop();
  copyDebugLogs(run.dir);
  const text = analyseRun(run.dir);
  writeFileSync(join(run.dir, 'analysis.txt'), text);
  process.stdout.write(`\n${text}`);
}

// ---------------------------------------------------------------------------
// Q2/Q3: the host (three Claude Codes), run by the driver under strace

interface Conv {
  label: string;
  name: string;
  runDir: string;
  configDir: string;
  cwd: string;
  pid?: number;
  sessionId?: string;
  resumedFrom?: string;
}

type Variant = 'press-interrupt' | 'press-abort' | 'kill-fresh' | 'kill-resume';

async function host(driveDir: string, model: string, variant: Variant, seedDir?: string): Promise<void> {
  const hostRec = new Recorder('host-log.txt');
  hostRec.attach(driveDir);
  const log = makeLog(hostRec);
  const pgid = procStat(process.pid)?.pgid;
  log(`host pid ${process.pid}, pgid ${pgid}, variant ${variant}`);
  const kill = variant.startsWith('kill');
  // TODO: undecided (store location). A file-backed store for the kill runs,
  // so recover can resume from it; record-only for the press runs.
  let storeDir: string | undefined;
  let seed: { conversations: { label: string; sessionId: string }[]; storeDir: string } | undefined;
  if (kill) {
    storeDir = join(STORES, basename(driveDir));
    if (seedDir) {
      seed = JSON.parse(readFileSync(join(seedDir, 'seed-state.json'), 'utf8'));
      cpSync(seed?.storeDir as string, storeDir, { recursive: true });
      log(`store ${storeDir}, copied from the seed's ${seed?.storeDir}`);
    } else {
      mkdirSync(storeDir, { recursive: true });
      log(`store ${storeDir}`);
    }
  }
  const specs = [
    { label: 'a', text: COUNT, trigger: 'reply' as const },
    { label: 'b', text: TOOL, trigger: 'tool' as const },
    { label: 'c', text: STORY, trigger: 'reply' as const },
  ];
  const convs: Conv[] = [];
  const parts: { conv: Conv; run: Run; abort: AbortController; c: Consumer; done: Promise<void> }[] = [];
  const state = (): void => writeFileSync(join(driveDir, 'host-state.json'), `${JSON.stringify({ hostPid: process.pid, pgid, variant, storeDir, conversations: convs }, null, 2)}\n`);
  for (const spec of specs) {
    const store = new Store(storeDir);
    const abort = new AbortController();
    const prefix = kill ? 'stopped-kill' : 'stopped-press';
    const options: HarnessOptions = { ...baseOptions(model, store), abortController: abort };
    const resumeId = seed?.conversations.find((s) => s.label === spec.label)?.sessionId;
    if (resumeId) {
      options.resume = resumeId;
    }
    const run = startRun({ name: `${prefix}-${spec.label}`, options });
    // Awaited later; a rejection before then must not crash the process.
    run.done.catch(() => {});
    store.rec.attach(run.dir);
    prepareCwd(run.cwd);
    const conv: Conv = { label: spec.label, name: `${prefix}-${spec.label}`, runDir: run.dir, configDir: run.configDir, cwd: run.cwd, resumedFrom: resumeId };
    convs.push(conv);
    const clog = (s: string): void => log(`${spec.label}: ${s}`);
    clog(`run dir ${run.dir}${resumeId ? `, resuming ${resumeId} through the store` : ''}`);
    const c = consume(run, spec.trigger, clog);
    void c.sessionId.then((sid) => {
      conv.sessionId = sid;
      state();
    });
    run.send(user(spec.text));
    const done = (async () => {
      await c.consumed;
      try {
        await run.done;
        clog('run.done settled');
      } catch (err) {
        clog(`run.done rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    parts.push({ conv, run, abort, c, done });
  }
  for (const p of parts) {
    p.conv.pid = claudeOf(p.run)?.pid;
    const sp = claudeOf(p.run);
    void sp?.exited.then((e) => log(`${p.conv.label}: claude ${sp.pid} exited ${JSON.stringify(e)}`));
  }
  state();

  let pressCount = 0;
  let stopWaiting: () => void = () => {};
  const stopped = new Promise<void>((r) => {
    stopWaiting = r;
  });
  if (!kill) {
    const stage1 = variant === 'press-interrupt' ? 'interrupt' : 'abort';
    process.on('SIGINT', () => {
      pressCount += 1;
      log(`SIGINT ${pressCount}`);
      if (pressCount === 1) {
        log(`stage 1 (${stage1}): stop each, wait for all to exit`);
        for (const p of parts) {
          if (stage1 === 'interrupt') {
            void (async () => {
              try {
                await p.run.interrupt();
                log(`${p.conv.label}: interrupt returned`);
              } catch (err) {
                log(`${p.conv.label}: interrupt failed: ${String(err)}`);
              }
              p.run.end();
              log(`${p.conv.label}: input ended`);
            })();
          } else {
            p.abort.abort();
            log(`${p.conv.label}: aborted`);
          }
        }
      } else if (pressCount === 2) {
        log('stage 2: SIGTERM each Claude Code, stop waiting');
        for (const p of parts) {
          const sp = claudeOf(p.run);
          if (sp && sp.child.exitCode === null && sp.child.signalCode === null) {
            try {
              process.kill(sp.pid, 'SIGTERM');
              log(`${p.conv.label}: SIGTERM ${sp.pid}`);
            } catch (err) {
              log(`${p.conv.label}: SIGTERM ${sp.pid} failed: ${String(err)}`);
            }
          } else {
            log(`${p.conv.label}: claude already exited`);
          }
        }
        stopWaiting();
      } else {
        log('stage 3: process.exit(130)');
        process.exit(130);
      }
    });
    process.on('exit', (code) => {
      const at = stamp();
      for (const p of parts) {
        const snapshot = walkJsonl(join(p.run.configDir, 'projects')).map((f) => ({ file: relative(p.run.configDir, f), text: redact(readFileSync(f, 'utf8')).text }));
        writeFileSync(join(p.run.dir, 'transcript-at-host-exit.json'), JSON.stringify({ at, snapshot }));
      }
      hostRec.write(`${at} exit ${code} (presses seen: ${pressCount})`);
    });
  }

  await Promise.all(parts.map((p) => p.c.ready));
  await Promise.race([Promise.all(parts.map((p) => p.c.sessionId)), later(2000)]);
  for (const p of parts) {
    p.conv.pid = claudeOf(p.run)?.pid;
  }
  state();
  log('all mid-turn');
  process.stdout.write('READY\n');
  await Promise.race([Promise.allSettled(parts.map((p) => p.done)), stopped]);
  log('main: all done / stopped waiting; returning');
  const sample = setInterval(() => {
    log(`still alive; active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  }, 1000);
  sample.unref();
}

// ---------------------------------------------------------------------------
// The driver: a terminal stand-in, outside the host's process group

async function drive(model: string, variant: Variant, delivery: 'host' | 'group', gapMs: number, seedDir?: string): Promise<void> {
  const tag = variant.startsWith('kill') ? variant : `${variant}-${delivery}-gap${gapMs}`;
  const driveDir = join(RUNS, `${stamp().replace(/[:.]/g, '')}-stopped-drive-${tag}`);
  mkdirSync(driveDir, { recursive: true });
  const rec = new Recorder('drive-log.txt');
  rec.attach(driveDir);
  const log = makeLog(rec, 'driver: ');
  const snaps = new Recorder('snapshots.jsonl');
  snaps.attach(driveDir);
  const watcher = new TranscriptWatcher();
  watcher.rec.attach(driveDir);
  log(`drive dir ${driveDir}`);
  const hostArgs = ['--disable-warning=ExperimentalWarning', SCRIPT, 'host', driveDir, model, variant, ...(seedDir ? [seedDir] : [])];
  const straceOut = join(driveDir, 'strace.txt');
  const tracer = spawn('strace', ['-f', '-ttt', '-e', 'trace=%process,kill,tgkill,tkill', '-o', straceOut, 'setsid', process.execPath, ...hostArgs], {
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PROOF7_STRACED: 'yes' },
  });
  const hostOut = createWriteStream(join(driveDir, 'host-stdout.txt'));
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  let buf = '';
  tracer.stdout.on('data', (chunk: Buffer) => {
    hostOut.write(chunk);
    buf += chunk.toString('utf8');
    let at = buf.indexOf('\n');
    while (at >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      if (line === 'READY') {
        readyResolve();
      }
      at = buf.indexOf('\n');
    }
  });
  tracer.stderr.on('data', (chunk: Buffer) => hostOut.write(chunk));
  const tracerExit = new Promise<string>((r) => tracer.once('exit', (code, signal) => r(`${stamp()} code ${code} signal ${signal}`)));

  const statePath = join(driveDir, 'host-state.json');
  const hostState = (): { hostPid: number; pgid: number; storeDir?: string; conversations: Conv[] } => JSON.parse(readFileSync(statePath, 'utf8'));
  const watchRoots = setInterval(() => {
    if (existsSync(statePath)) {
      try {
        for (const c of hostState().conversations) {
          watcher.addRoot(c.configDir);
        }
      } catch {}
    }
  }, 50);
  watcher.start();

  const up = await Promise.race([ready.then(() => true), tracerExit.then(() => false), later(180_000).then(() => false)]);
  if (!up) {
    log('host never reported READY');
    clearInterval(watchRoots);
    watcher.stop();
    return;
  }
  const hs = hostState();
  for (const c of hs.conversations) {
    watcher.addRoot(c.configDir);
  }
  log(`READY; host pid ${hs.hostPid}, pgid ${hs.pgid}; claude pids ${hs.conversations.map((c) => `${c.label}=${c.pid}`).join(' ')}`);
  const watched = new Map<number, string>();
  for (const c of hs.conversations) {
    if (c.pid) {
      watched.set(c.pid, `${c.label}: claude`);
      for (const d of descendants(c.pid)) {
        watched.set(d.pid, `${c.label}: ${d.cmd}`);
      }
    }
  }
  log(`processes watched: ${JSON.stringify([...watched])}`);

  const snapshot = (label: string): void => {
    const now = stamp();
    const convs = hs.conversations.map((c) => {
      const file = findTranscript(c);
      const lines = file ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0;
      const appends = readJsonl(join(c.runDir, 'store-appends.jsonl')).filter((x) => x.event !== 'load');
      const stored = appends.reduce((n, x) => n + Number(x.count), 0);
      return { label: c.label, transcript: file, lines, stored, claudeAlive: c.pid ? alive(c.pid) : null };
    });
    const procs = [...watched].map(([pid, what]) => ({ pid, what, alive: alive(pid) }));
    snaps.write({ ts: now, label, hostAlive: alive(hs.hostPid), convs, procs });
    log(`snapshot "${label}": host ${alive(hs.hostPid) ? 'alive' : 'gone'}; ${convs.map((c) => `${c.label} ${c.lines} lines/${c.stored} stored/claude ${c.claudeAlive ? 'alive' : 'gone'}`).join('; ')}`);
  };

  snapshot('ready');
  if (variant.startsWith('press')) {
    for (let k = 1; k <= 3; k += 1) {
      // A terminal hands Ctrl-C back to the shell once the foreground job
      // (the host) has exited, so no press after that.
      if (!alive(hs.hostPid)) {
        log(`press ${k}: host already exited; not sent`);
        snaps.write({ ts: stamp(), label: `press ${k} not sent: host gone` });
        break;
      }
      const target = delivery === 'group' ? -hs.pgid : hs.hostPid;
      try {
        process.kill(target, 'SIGINT');
        log(`PRESS ${k}: SIGINT to ${delivery === 'group' ? `process group ${hs.pgid}` : `host pid ${hs.hostPid}`}`);
        snaps.write({ ts: stamp(), label: `PRESS ${k}`, target });
      } catch (err) {
        log(`press ${k}: kill failed: ${String(err)}`);
      }
      if (gapMs > 0) {
        await sleep(gapMs - 5);
        snapshot(`press ${k} + ${gapMs - 5} ms`);
        await sleep(5);
      }
    }
  } else {
    process.kill(hs.hostPid, 'SIGKILL');
    log(`KILL: SIGKILL to host pid ${hs.hostPid}`);
    snaps.write({ ts: stamp(), label: 'KILL', target: hs.hostPid });
  }
  // Wait for every traced process (strace exits when the last one does),
  // snapshotting as processes go.
  const gone = new Set<number>();
  const pollDeadline = Date.now() + 240_000;
  let lastSnap = Date.now();
  let finished = false;
  void tracerExit.then(() => {
    finished = true;
  });
  while (!finished && Date.now() < pollDeadline) {
    for (const [pid, what] of watched) {
      if (!gone.has(pid) && !alive(pid)) {
        gone.add(pid);
        log(`gone: ${pid} (${what})`);
      }
    }
    if (Date.now() - lastSnap >= 5000) {
      snapshot('periodic');
      lastSnap = Date.now();
    }
    await sleep(50);
  }
  if (!finished) {
    log('still running after 240 s; SIGKILL to what is left of the watched processes');
    for (const [pid] of watched) {
      if (alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
  }
  log(`strace exited: ${await tracerExit}`);
  for (const [pid, what] of watched) {
    if (!gone.has(pid)) {
      log(`gone: ${pid} (${what}) (by strace exit)`);
    }
  }
  snapshot('final');
  clearInterval(watchRoots);
  await sleep(200);
  watcher.stop();
  await new Promise((r) => hostOut.end(r));
  // Where the transcripts were left, and any SDK temp dirs (names only).
  const tmps = readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-'));
  log(`claude-resume-* in ${tmpdir()} now: ${JSON.stringify(tmps.map((n) => ({ dir: n, listing: listTree(join(tmpdir(), n)) })))}`);
  for (const c of hs.conversations) {
    copyDebugLogs(c.runDir);
  }
  const text = analyseDrive(driveDir);
  writeFileSync(join(driveDir, 'analysis.txt'), text);
  process.stdout.write(`\n${text}`);
}

// The session's transcript: the run's config dir, else an SDK resume temp dir.
function findTranscript(c: Conv): string | undefined {
  if (!c.sessionId) {
    return undefined;
  }
  const roots = [c.configDir, ...readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-')).map((n) => join(tmpdir(), n))];
  for (const root of roots) {
    const hit = walkJsonl(join(root, 'projects')).find((f) => basename(f) === `${c.sessionId}.jsonl` && relative(join(root, 'projects'), f).split('/').length === 2);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Q3 prep: three conversations to resume

const WORDS: Record<string, string> = { a: 'PERIWINKLE', b: 'MARIGOLD', c: 'OBSIDIAN' };

async function seedRun(model: string): Promise<void> {
  const seedDir = join(RUNS, `${stamp().replace(/[:.]/g, '')}-stopped-seed`);
  mkdirSync(seedDir, { recursive: true });
  const storeDir = join(STORES, basename(seedDir));
  const rec = new Recorder('seed-log.txt');
  rec.attach(seedDir);
  const log = makeLog(rec);
  const conversations: { label: string; sessionId: string; runDir: string }[] = [];
  for (const label of ['a', 'b', 'c']) {
    const store = new Store(storeDir);
    const run = startRun({ name: `stopped-kill-${label}`, options: baseOptions(model, store) });
    // Awaited later; a rejection before then must not crash the process.
    run.done.catch(() => {});
    store.rec.attach(run.dir);
    const c = consume(run, 'none', (s) => log(`${label}: ${s}`));
    run.send(user(`Remember the code word ${WORDS[label]} for later. Reply with OK and nothing else.`));
    const answer = await c.result;
    run.end();
    await run.done.catch(() => {});
    const sessionId = await c.sessionId;
    log(`${label}: session ${sessionId}, answer ${JSON.stringify(answer)}, run ${run.dir}`);
    conversations.push({ label, sessionId, runDir: run.dir });
  }
  writeFileSync(join(seedDir, 'seed-state.json'), `${JSON.stringify({ storeDir, conversations }, null, 2)}\n`);
  log(`seed dir ${seedDir}`);
}

// ---------------------------------------------------------------------------
// Q4: find and publish on the next serve

const QUESTIONS: Record<string, string> = {
  a: 'What is the last number you wrote in your previous reply? Reply with just the number, or NONE if your previous reply has no numbers.',
  b: 'In your previous turn you ran wait.sh with the Bash tool. What did the tool result say? Quote it exactly, or reply NONE if you saw no result.',
  c: 'Quote the final sentence of your previous reply exactly, or reply NONE if you have no previous reply.',
};

async function recover(model: string, driveDir: string): Promise<void> {
  const hs = JSON.parse(readFileSync(join(driveDir, 'host-state.json'), 'utf8')) as { storeDir: string; conversations: Conv[] };
  const recDir = join(RUNS, `${stamp().replace(/[:.]/g, '')}-stopped-recover-${basename(driveDir).replace(/^.*-stopped-drive-/, '')}`);
  mkdirSync(recDir, { recursive: true });
  const rec = new Recorder('recover-log.txt');
  rec.attach(recDir);
  const log = makeLog(rec);
  log(`recover dir ${recDir}; from drive ${driveDir}; store ${hs.storeDir}`);
  const unrecovered = join(STORES, `${basename(recDir)}-unrecovered`);
  cpSync(hs.storeDir, unrecovered, { recursive: true });
  log(`control: the store as it was, copied to ${unrecovered}`);
  const report: Json[] = [];
  for (const c of hs.conversations) {
    const l = (s: string): void => log(`${c.label}: ${s}`);
    if (!c.sessionId) {
      l('no session id; skipped');
      continue;
    }
    // 1. Find it: the conversation's config dir, then every SDK resume dir.
    const roots = [c.configDir, ...readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-')).map((n) => join(tmpdir(), n))];
    const found: { root: string; file: string; lines: number; bytes: number }[] = [];
    for (const root of roots) {
      for (const f of walkJsonl(join(root, 'projects'))) {
        if (basename(f) === `${c.sessionId}.jsonl`) {
          const text = readFileSync(f, 'utf8');
          found.push({ root, file: f, lines: text.split('\n').filter((x) => x.trim() !== '').length, bytes: text.length });
        }
      }
    }
    l(`searched ${roots.length} roots; found ${JSON.stringify(found)}`);
    const src = found[0];
    if (!src) {
      report.push({ label: c.label, found: 'nowhere' });
      continue;
    }
    // 2. Read it with the SDK's importSessionToStore (CLAUDE_CONFIG_DIR is
    // where it looks), into a collector.
    const offered: SessionStoreEntry[] = [];
    const collector: SessionStore = {
      append: async (_key: SessionKey, entries: SessionStoreEntry[]) => {
        offered.push(...entries);
      },
      load: async () => null,
    };
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = src.root;
    let how = 'importSessionToStore';
    try {
      await importSessionToStore(c.sessionId, collector, { dir: c.cwd, includeSubagents: true });
    } catch (err) {
      how = `file read (importSessionToStore failed: ${err instanceof Error ? err.message : String(err)})`;
      offered.splice(0, offered.length, ...(readJsonl(src.file) as SessionStoreEntry[]));
    } finally {
      if (saved === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = saved;
      }
    }
    l(`read ${offered.length} entries from ${src.file} via ${how}`);
    // 3. What the store lacks: by uuid; uuid-less entries by content, counted.
    const storeFiles = walkJsonl(hs.storeDir).filter((f) => basename(f) === `${c.sessionId}.jsonl`);
    const storeFile = storeFiles[0] as string;
    const inStore = readJsonl(storeFile);
    const uuids = new Set(inStore.map((e) => e.uuid).filter((u) => typeof u === 'string'));
    const bag = new Map<string, number>();
    for (const e of inStore.filter((x) => typeof x.uuid !== 'string')) {
      bag.set(canon(e), (bag.get(canon(e)) ?? 0) + 1);
    }
    const missing: SessionStoreEntry[] = [];
    for (const e of offered) {
      if (typeof e.uuid === 'string') {
        if (!uuids.has(e.uuid)) {
          missing.push(e);
        }
      } else {
        const k = canon(e);
        const n = bag.get(k) ?? 0;
        if (n > 0) {
          bag.set(k, n - 1);
        } else {
          missing.push(e);
        }
      }
    }
    const missingBytes = missing.reduce((n, e) => n + JSON.stringify(e).length + 1, 0);
    l(`store has ${inStore.length} entries; transcript ${offered.length}; missing ${missing.length} (${missingBytes} bytes): ${missing.map((e) => describeEntry(e as Json).slice(0, 90)).join(' || ')}`);
    writeFileSync(join(recDir, `store-before-${c.label}.jsonl`), redact(readFileSync(storeFile, 'utf8')).text);
    writeFileSync(join(recDir, `published-${c.label}.jsonl`), redact(missing.map((e) => `${JSON.stringify(e)}\n`).join('')).text);
    // 4. Publish: append what's missing, in transcript order.
    appendFileSync(storeFile, missing.map((e) => `${JSON.stringify(e)}\n`).join(''));
    l(`published ${missing.length} entries to ${storeFile}`);
    report.push({ label: c.label, found: src.file, foundIn: src.root, how, transcriptEntries: offered.length, storeBefore: inStore.length, missing: missing.length, missingBytes });
  }
  // 5. Serve again: resume each through the recovered store and through the
  // unrecovered copy, and ask about the part that had not been published.
  for (const [which, dir] of [
    ['recovered', hs.storeDir],
    ['unrecovered', unrecovered],
  ] as const) {
    for (const c of hs.conversations) {
      if (!c.sessionId) {
        continue;
      }
      const store = new Store(dir);
      const run = startRun({ name: c.name, options: { ...baseOptions(model, store), resume: c.sessionId } });
      // Awaited later; a rejection before then must not crash the process.
      run.done.catch(() => {});
      store.rec.attach(run.dir);
      const cons = consume(run, 'none', (s) => log(`${c.label} ${which}: ${s}`));
      run.send(user(QUESTIONS[c.label] as string));
      const answer = await Promise.race([cons.result, later(120_000).then(() => '(no answer in 120 s)')]);
      run.end();
      await run.done.catch((err: unknown) => log(`${c.label} ${which}: run.done rejected: ${String(err)}`));
      log(`${c.label} ${which}: run ${run.dir}; answer ${JSON.stringify(answer)}`);
      report.push({ label: c.label, resumeFrom: which, run: run.dir, answer });
    }
  }
  writeFileSync(join(recDir, 'recover.json'), `${JSON.stringify(report, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Analysis

interface Line {
  file: string;
  line: number;
  entry: Json;
  canon: string;
  bytes: number;
}

function transcriptLinesOf(file: string, root: string): Line[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      const text = redact(l).text;
      const entry = JSON.parse(text) as Json;
      return { file: relative(root, file), line: i + 1, entry, canon: canon(entry), bytes: l.length + 1 };
    });
}

function mainTranscripts(root: string): string[] {
  const projects = join(root, 'projects');
  return walkJsonl(projects).filter((f) => relative(projects, f).split('/').length === 2);
}

// First-seen time of each transcript line, keyed by absolute file path + line.
function seenTimes(watchFile: string): Map<string, number> {
  const seen = new Map<string, number>();
  for (const ev of readJsonl(watchFile)) {
    if (ev.file) {
      const k = `${join(String(ev.root), String(ev.file))}:${String(ev.line)}`;
      if (!seen.has(k)) {
        seen.set(k, toMs(String(ev.ts)));
      }
    }
  }
  return seen;
}

// Store appends of a run, in order: loaded entries (resume) have no time.
function storeEntries(runDir: string): { ts: number | undefined; canon: string; entry: Json }[] {
  const out: { ts: number | undefined; canon: string; entry: Json }[] = [];
  for (const c of readJsonl(join(runDir, 'store-appends.jsonl'))) {
    if (c.event === 'load') {
      if (c.found && c.file && existsSync(String(c.file))) {
        // The file has grown since load(); what load() returned is whatever
        // precedes this run's first append, handled by the caller.
      }
      continue;
    }
    for (const e of c.entries as Json[]) {
      out.push({ ts: toMs(String(c.ts)), canon: canon(e), entry: e });
    }
  }
  return out;
}

// Each final transcript line against the store: when (if ever) it was
// appended. Entries a resume loaded from the store count as 'loaded'.
function lineTable(lines: Line[], stored: { ts: number | undefined; canon: string }[], loaded: string[], seen: Map<string, number>, abs: (l: Line) => string, t0: number, windows: { at: number; label: string }[]): { rows: string[]; notInStore: Line[] } {
  const bag = new Map<string, { ts: number | undefined }[]>();
  for (const s of stored) {
    bag.set(s.canon, [...(bag.get(s.canon) ?? []), s]);
  }
  const loadedBag = new Map<string, number>();
  for (const k of loaded) {
    loadedBag.set(k, (loadedBag.get(k) ?? 0) + 1);
  }
  const windowOf = (t: number | undefined): string => {
    if (t === undefined) {
      return '';
    }
    let w = 'before';
    for (const x of windows) {
      if (t >= x.at) {
        w = x.label;
      }
    }
    return w;
  };
  const rows: string[] = [];
  const notInStore: Line[] = [];
  for (const l of lines) {
    const disk = seen.get(abs(l));
    let storeCol: string;
    const ln = loadedBag.get(l.canon) ?? 0;
    const q = bag.get(l.canon);
    if (ln > 0) {
      loadedBag.set(l.canon, ln - 1);
      storeCol = 'loaded (resume)';
    } else if (q && q.length > 0) {
      const s = q.shift();
      storeCol = `${rel(s?.ts, t0)} [${windowOf(s?.ts)}]`;
    } else {
      storeCol = 'NOT IN STORE';
      notInStore.push(l);
    }
    rows.push(`  ${String(l.line).padStart(3)} ${describeEntry(l.entry).slice(0, 150).padEnd(150)} | disk ${rel(disk, t0)}${disk !== undefined ? ` [${windowOf(disk)}]` : ''} | store ${storeCol}`);
  }
  return { rows, notInStore };
}

function flagsSummary(lines: Line[], stored: { canon: string }[]): string {
  const storedSet = new Set(stored.map((s) => s.canon));
  const partial = lines.filter((l) => isPartial(l.entry));
  const marker = lines.filter((l) => isMarker(l.entry));
  const denial = lines.filter((l) => l.entry.toolDenialKind);
  const f = (xs: Line[]): string => (xs.length === 0 ? 'no' : xs.map((l) => `line ${l.line} (${storedSet.has(l.canon) ? 'in store' : 'NOT in store'})`).join(', '));
  return `partial reply (isAbortedMidStream): ${f(partial)}; "[Request interrupted...]" marker: ${f(marker)}; rejected tool_result: ${f(denial)}`;
}

// Q1 analysis: one run.
function analyseRun(dir: string): string {
  const out: string[] = [];
  const w = (s = ''): void => {
    out.push(s);
  };
  const stop = JSON.parse(readFileSync(join(dir, 'stop.json'), 'utf8')) as Json;
  const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { configDir: string };
  const t0 = toMs(String(stop.stopAt));
  w(`# ${relative(PACKAGE_ROOT, dir)}`);
  w(`stop: ${String(stop.method)} ${String(stop.point)} at ${String(stop.stopAt)} (t0); claude pid ${String(stop.pid)} (the real binary; spawned directly by host pid ${String(stop.hostPid)})`);
  const exit = stop.exit as Json | string;
  if (typeof exit === 'object') {
    w(`claude exit: code ${String(exit.code)} signal ${String(exit.signal)} at ${rel(toMs(String(exit.at)), t0)}`);
  } else {
    w(`claude exit: ${exit}`);
  }
  for (const k of ['interruptReturnedAt', 'resultAt', 'endAt']) {
    if (stop[k]) {
      w(`${k}: ${rel(toMs(String(stop[k])), t0)}`);
    }
  }
  if (stop.interruptError) {
    w(`interrupt error: ${String(stop.interruptError)}`);
  }
  w(`claude's children at stop: ${JSON.stringify(stop.tree)}; alive when claude exited: ${JSON.stringify(stop.childrenAliveAtClaudeExit)}`);
  for (const f of (stop.childFates as Json[]) ?? []) {
    w(`  child ${String(f.pid)} ${String(f.cmd)}: gone ${String(f.goneAt).startsWith('20') ? rel(toMs(String(f.goneAt)), t0) : String(f.goneAt)}`);
  }
  w(`wait.sh started ${String(stop.waitStarted)}; finished ${String(stop.waitFinished)}`);
  if (existsSync(join(dir, 'strace.txt'))) {
    const names = new Map<number, string>([
      [Number(stop.hostPid), 'host'],
      [Number(stop.pid), 'claude'],
    ]);
    for (const l of straceSection(join(dir, 'strace.txt'), names, t0, new Set([Number(stop.hostPid)]))) {
      w(l);
    }
  }
  const events = readJsonl(join(dir, 'harness-events.jsonl'));
  const qe = events.find((e) => e.event === 'query-error');
  w(`SDK query: ${qe ? `error "${String((qe.detail as Json)?.message)}"` : 'finished without error'}`);
  const finished = existsSync(join(dir, 'config-dir-manifest.json'));
  const root = finished ? join(dir, 'config-dir') : runJson.configDir;
  const files = mainTranscripts(root);
  const stored = storeEntries(dir);
  const seen = seenTimes(join(dir, 'transcript-watch.jsonl'));
  for (const file of files) {
    const lines = transcriptLinesOf(file, root);
    const abs = (l: Line): string => `${join(runJson.configDir, l.file)}:${l.line}`;
    const { rows, notInStore } = lineTable(lines, stored, [], seen, abs, t0, [{ at: t0, label: 'after stop' }]);
    const last = Math.max(...lines.map((l) => seen.get(abs(l)) ?? 0));
    w();
    w(`transcript ${relative(dir, file)}: ${lines.length} lines; store ${stored.length} entries; ${notInStore.length} lines not in store (${notInStore.reduce((n, l) => n + l.bytes, 0)} bytes)`);
    w(`last transcript line on disk at ${rel(last || undefined, t0)}`);
    w(flagsSummary(lines, stored));
    w('line | entry | first on disk (vs stop) | appended to store (vs stop)');
    for (const r of rows) {
      w(r);
    }
    const extra = stored.filter((s) => !lines.some((l) => l.canon === s.canon));
    w(`${extra.length} store entries not in the transcript`);
  }
  const dbg = readdirSync(dir).filter((n) => n.startsWith('debug-'));
  for (const d of dbg) {
    const hits = readFileSync(join(dir, d), 'utf8')
      .split('\n')
      .filter((l) => /shutdown|signal|SIGINT|SIGTERM|abort|interrupt|stdin|EPIPE|orphan|exit/i.test(l))
      .slice(-40);
    w();
    w(`${d} (lines mentioning shutdown/signal/abort/interrupt/stdin/exit, last 40):`);
    for (const h of hits) {
      w(`  ${h.slice(0, 220)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

interface StraceEvent {
  pid: number;
  t: number;
  text: string;
}

function parseStrace(path: string): { events: StraceEvent[]; exe: Map<number, string> } {
  const events: StraceEvent[] = [];
  const exe = new Map<number, string>();
  if (!existsSync(path)) {
    return { events, exe };
  }
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const m = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/.exec(raw);
    if (!m) {
      continue;
    }
    const pid = Number(m[1]);
    const t = Number(m[2]) * 1000;
    const text = m[3] as string;
    const ex = /^execve\("([^"]+)"/.exec(text);
    if (ex && !text.includes('= -1')) {
      exe.set(pid, basename(ex[1] as string));
    }
    if (text.startsWith('---') || text.startsWith('+++') || /^(kill|tgkill|tkill)\(/.test(text) || text.startsWith('exit_group(') || text.startsWith('<... exit_group')) {
      events.push({ pid, t, text });
    }
  }
  return { events, exe };
}

// Signals each process received (with sender) and how it ended, from strace.
function straceSection(path: string, names: Map<number, string>, t0: number, killers: Set<number>): string[] {
  const out: string[] = [];
  const { events, exe } = parseStrace(path);
  if (events.length === 0) {
    return out;
  }
  const nameOf = (pid: number): string => names.get(pid) ?? `${exe.get(pid) ?? '?'}`;
  const interesting = new Set<number>(names.keys());
  for (const [pid, name] of exe) {
    if (['bash', 'sleep', 'sh'].includes(name)) {
      interesting.add(pid);
    }
  }
  out.push('== processes (strace -f -ttt: signals received and their sender, kill calls, exits)');
  for (const e of events) {
    if (!interesting.has(e.pid)) {
      continue;
    }
    if (e.text.startsWith('---')) {
      const sender = /si_pid=(\d+)/.exec(e.text);
      const sig = /--- (SIG[A-Z0-9]+)/.exec(e.text)?.[1];
      if (sig === 'SIGCHLD' || sig === 'SIGURG') {
        continue;
      }
      out.push(`  ${rel(e.t, t0).padStart(12)} ${nameOf(e.pid)}(${e.pid}) received ${sig}${sender ? ` from ${nameOf(Number(sender[1]))}(${sender[1]})` : ''}`);
    } else if (e.text.startsWith('+++')) {
      out.push(`  ${rel(e.t, t0).padStart(12)} ${nameOf(e.pid)}(${e.pid}) ${e.text.replace(/\+\+\+/g, '').trim()}`);
    } else if (/^(kill|tgkill|tkill)\(/.test(e.text) && killers.has(e.pid)) {
      out.push(`  ${rel(e.t, t0).padStart(12)} ${nameOf(e.pid)}(${e.pid}) ${e.text.slice(0, 80)}`);
    }
  }
  return out;
}

// Q2/Q3 analysis: one drive dir.
function analyseDrive(driveDir: string): string {
  const out: string[] = [];
  const w = (s = ''): void => {
    out.push(s);
  };
  const hs = JSON.parse(readFileSync(join(driveDir, 'host-state.json'), 'utf8')) as { hostPid: number; pgid: number; variant: string; storeDir?: string; conversations: Conv[] };
  const snaps = readJsonl(join(driveDir, 'snapshots.jsonl'));
  const presses = snaps.filter((s) => String(s.label).startsWith('PRESS') || s.label === 'KILL').map((s) => ({ at: toMs(String(s.ts)), label: String(s.label) }));
  const t0 = presses[0]?.at ?? 0;
  w(`# ${relative(PACKAGE_ROOT, driveDir)}`);
  w(`variant ${hs.variant}; host pid ${hs.hostPid} (leads process group ${hs.pgid}); t0 = ${presses[0]?.label ?? '?'} at ${isoFromEpoch(t0 / 1000)}`);
  for (const p of presses) {
    w(`  ${p.label} at ${rel(p.at, t0)}`);
  }
  for (const s of snaps.filter((x) => String(x.label).includes('not sent'))) {
    w(`  ${String(s.label)} at ${rel(toMs(String(s.ts)), t0)}`);
  }
  const names = new Map<number, string>([[hs.hostPid, 'host']]);
  for (const c of hs.conversations) {
    if (c.pid) {
      names.set(c.pid, `${c.label}:claude`);
    }
  }
  const { events } = parseStrace(join(driveDir, 'strace.txt'));
  w();
  for (const l of straceSection(join(driveDir, 'strace.txt'), names, t0, new Set([hs.hostPid]))) {
    w(l);
  }
  w();
  w('== snapshots (driver): lines on disk / entries appended to the store / claude alive');
  for (const s of snaps) {
    if (!s.convs) {
      continue;
    }
    const cs = (s.convs as Json[]).map((c) => `${String(c.label)} ${String(c.lines)}/${String(c.stored)}/${c.claudeAlive ? 'alive' : 'gone'}`).join('  ');
    w(`  ${rel(toMs(String(s.ts)), t0).padStart(12)} ${String(s.label).padEnd(22)} host ${s.hostAlive ? 'alive' : 'gone'}  ${cs}`);
  }
  const seen = seenTimes(join(driveDir, 'transcript-watch.jsonl'));
  const windows = [...presses];
  const hostExit = events.find((e) => e.pid === hs.hostPid && e.text.startsWith('+++'));
  if (hostExit) {
    windows.push({ at: hostExit.t, label: 'after host exit' });
    windows.sort((a, b) => a.at - b.at);
  }
  for (const c of hs.conversations) {
    w();
    w(`== ${c.label}: run ${relative(PACKAGE_ROOT, c.runDir)}; session ${c.sessionId}${c.resumedFrom ? ' (resumed through the store)' : ''}`);
    // The final transcript is copied (redacted) into the drive dir the first
    // time the drive is analysed: a resumed one lives only in /tmp, and a run
    // whose host died never got the harness's config-dir copy.
    const saved = join(driveDir, 'transcripts', `${c.label}.jsonl`);
    const savedFrom = `${saved}.source`;
    const live = findTranscript(c);
    if (live && !existsSync(saved)) {
      mkdirSync(dirname(saved), { recursive: true });
      writeFileSync(saved, redact(readFileSync(live, 'utf8')).text);
      writeFileSync(savedFrom, `${live}\n`);
    }
    if (!existsSync(saved)) {
      w('  transcript: not found (config dir or /tmp/claude-resume-*)');
      continue;
    }
    const origin = readFileSync(savedFrom, 'utf8').trim();
    const root = origin.slice(0, origin.indexOf('/projects/'));
    w(`  transcript left at ${origin}${root.startsWith(tmpdir()) ? ' (SDK resume temp dir)' : " (the run's config dir)"}; copy: ${relative(PACKAGE_ROOT, saved)} (line numbers below are its lines)`);
    const lines = transcriptLinesOf(saved, dirname(saved));
    const stored = storeEntries(c.runDir);
    // A resumed transcript starts with what load() returned; those lines are
    // the ones before this run's first append.
    let loaded: string[] = [];
    if (c.resumedFrom && stored[0]) {
      const firstIdx = lines.findIndex((l) => l.canon === stored[0]?.canon);
      loaded = lines.slice(0, Math.max(0, firstIdx)).map((l) => l.canon);
    }
    const abs = (l: Line): string => `${origin}:${l.line}`;
    const { rows, notInStore } = lineTable(lines, stored, loaded, seen, abs, t0, windows);
    w(`  ${lines.length} lines; ${loaded.length} loaded by resume; ${stored.length} appended this run; ${notInStore.length} lines NOT in the store (${notInStore.reduce((n, l) => n + l.bytes, 0)} bytes)`);
    w(`  ${flagsSummary(lines, stored)}`);
    w('  line | entry | first on disk | appended to store   (times vs t0; [window])');
    for (const r of rows) {
      w(r);
    }
    const extra = stored.filter((s) => !lines.some((l) => l.canon === s.canon));
    w(`  ${extra.length} store entries not in the final transcript`);
    const dbg = readdirSync(c.runDir).filter((n) => n.startsWith('debug-'));
    for (const d of dbg) {
      const hits = readFileSync(join(c.runDir, d), 'utf8')
        .split('\n')
        .filter((l) => /shutdown|signal|SIGINT|SIGTERM|abort|interrupt|stdin|EPIPE|orphan|exit/i.test(l))
        .slice(-25);
      w(`  ${d} (shutdown/signal/abort/stdin/exit lines, last 25):`);
      for (const h of hits) {
        w(`    ${h.slice(0, 200)}`);
      }
    }
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
const usage =
  'usage:\n  stop <model> <abort|interrupt|sigint|sigterm> <reply|tool>\n  drive <model> <press-interrupt|press-abort> <host|group> <gap ms>\n  drive <model> kill-fresh\n  drive <model> kill-resume <seed dir>\n  seed <model>\n  recover <model> <kill drive dir>\n  --analyse <dir> [...]\n';
if (mode === '--analyse') {
  for (const dir of rest) {
    const text = existsSync(join(dir, 'host-state.json')) ? analyseDrive(dir) : analyseRun(dir);
    writeFileSync(join(dir, 'analysis.txt'), text);
    process.stdout.write(text);
  }
} else if (mode === 'stop' && rest[0] && ['abort', 'interrupt', 'sigint', 'sigterm'].includes(rest[1] ?? '') && ['reply', 'tool'].includes(rest[2] ?? '')) {
  await stopOne(rest[0], rest[1] as 'abort', rest[2] as 'reply');
} else if (mode === 'host' && rest[0] && rest[1] && rest[2]) {
  await host(rest[0], rest[1], rest[2] as Variant, rest[3]);
} else if (mode === 'drive' && rest[0] && (rest[1] === 'press-interrupt' || rest[1] === 'press-abort') && (rest[2] === 'host' || rest[2] === 'group') && rest[3]) {
  await drive(rest[0], rest[1], rest[2], Number(rest[3]));
} else if (mode === 'drive' && rest[0] && rest[1] === 'kill-fresh') {
  await drive(rest[0], 'kill-fresh', 'host', 0);
} else if (mode === 'drive' && rest[0] && rest[1] === 'kill-resume' && rest[2]) {
  await drive(rest[0], 'kill-resume', 'host', 0, rest[2]);
} else if (mode === 'seed' && rest[0]) {
  await seedRun(rest[0]);
} else if (mode === 'recover' && rest[0] && rest[1]) {
  await recover(rest[0], rest[1]);
} else {
  process.stderr.write(usage);
  process.exit(2);
}
