// Proof 3: the SDK's session store as the commit signal (Stephen, 25 Sep:
// "as close is better, and as much as it can be that if claude code exits,
// what's published to tower is what the model sees"; "ctrl-c is what we're
// going for, not claude code being kill -9").
//
// The SDK's `sessionStore` option starts Claude Code with --session-mirror:
// after each local transcript write Claude Code prints a
// {type:"transcript_mirror", filePath, entries} frame on stdout, and the SDK
// hands those entries to `store.append()` (sdk.mjs, Query.readMessages). The
// proof's store records every call, stamped, to <run>/store-appends.jsonl
// (appendFileSync, so a record survives process.exit). A watcher records
// when each transcript line first appears on disk, to
// <run>/transcript-watch.jsonl. The capture wrapper already stamps every
// stdout line, frames included.
//
// Modes:
//
//   turns <model> <eager|batched>
//       One Claude Code, five turns: a plain reply; thinking + a Read call;
//       a long reply interrupted on its first text delta; a Bash `sleep 30`
//       interrupted 2 s after its tool_use; a plain reply.
//
//   resume <model> <files|store> <previous turns run dir>
//       Resumes the previous run's session and asks for the code word turn 1
//       gave it. Both keep a recording sessionStore.
//         files: resume passed as extraArgs {resume} so the SDK's store-resume
//                path is not taken; Claude Code resumes from its own
//                transcript file. The previous run's projects/ is copied into
//                this run's config dir by a spawnClaudeCodeProcess hook just
//                before the binary starts (the harness gives each run a fresh
//                config dir).
//         store: options.resume with the sessionStore; the store's load()
//                returns the previous run's transcript lines. The SDK
//                materialises them into a temporary config dir; the proof
//                watches os.tmpdir() for claude-resume-* and records what is
//                in it (names, sizes, modes; never file contents).
//
//   shutdown <model> <interrupt|abort> <1|2|3> [gap=<ms>] [pgroup]
//       Three Claude Codes mid-turn: A streaming a long count, B inside a
//       Bash script that sleeps 25 s, C streaming a long story. Once all three
//       are there, the proof sends itself SIGINT 1, 2 or 3 times, gap ms
//       apart (default 500)
//       (`pgroup`: to its whole process group, as a terminal Ctrl-C does;
//       needs `setsid`). The host's SIGINT handler:
//         press 1: stage 1. `interrupt`: query.interrupt() then end() the
//                  input, per run. `abort`: the run's AbortController.
//                  Then wait for every run to finish.
//         press 2: stage 2. SIGTERM to each real Claude Code process; stop
//                  waiting (main returns; node exits when nothing holds it).
//         press 3: stage 3. process.exit(130).
//       On exit the proof snapshots each transcript into
//       <run>/transcript-at-host-exit.jsonl and writes <run>/host-exit.json.
//       Run `--analyse` on the run dirs after the Claude Codes have exited;
//       it reads their final transcripts from the live config dirs.
//
//   --analyse <run dir> [...]
//
// A shutdown run is analysed after its Claude Codes have exited on their
// own, e.g. from mvp/claude-code-harness/:
//
//   timeout 200 node proofs/session-store.mts shutdown <model> abort 2 > runs/x.out 2>&1
//   sleep 35
//   node proofs/session-store.mts --analyse $(grep -o 'runs/2026[^ ]*shutdown-[abc]' runs/x.out | sort -u)
//
// `pgroup` runs under `timeout 200 setsid node ...`. With the capture
// wrapper in between, a process-group SIGINT reaches each Claude Code twice:
// directly, and forwarded by its wrapper.
//
// TODO: undecided. Everything in the shutdown handler above (interrupt vs
// AbortController for stage 1, SIGTERM for stage 2, process.exit for stage 3,
// what "stop waiting" means) is built only to show what each reaches; none of
// it is the participant's design. Stephen: "the mechanics are open".

import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, rmSync, existsSync, lstatSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import type { SDKMessage, SessionKey, SessionStore, SessionStoreEntry, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessOptions, Run } from '../src/harness.mts';
import { startRun } from '../src/harness.mts';
import { redact, stamp } from '../src/record.mts';

const QUIET_MS = 4000;

const WAIT_SH = (seconds: number): string => `date -u +%FT%T.%NZ > wait-started.txt\nsleep ${seconds}\necho waited\n`;

function waitStarted(cwd: string): string {
  const p = join(cwd, 'wait-started.txt');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : 'never';
}

type Json = Record<string, unknown>;

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
    const line = `${redact(JSON.stringify(value)).text}\n`;
    if (this.path) {
      appendFileSync(this.path, line);
    } else {
      this.pending.push(line);
    }
  }
}

class RecordingStore implements SessionStore {
  readonly rec = new Recorder('store-appends.jsonl');
  calls = 0;
  // resume/store: the transcript file load() returns.
  loadSource: string | undefined;
  loadGate: Promise<void> = Promise.resolve();

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.calls += 1;
    this.rec.write({ ts: stamp(), call: this.calls, key, count: entries.length, entries });
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    await this.loadGate;
    this.rec.write({ ts: stamp(), event: 'load', key, source: this.loadSource ?? null });
    if (!this.loadSource) {
      return null;
    }
    return readJsonl(this.loadSource) as SessionStoreEntry[];
  }
}

function readJsonl(path: string): Json[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Json);
}

// Records when each transcript line first appears on disk. fs.watch
// (inotify) triggers a scan; a 20 ms poll catches anything it misses.
class TranscriptWatcher {
  readonly rec = new Recorder('transcript-watch.jsonl');
  readonly offsets = new Map<string, { bytes: number; lines: number; partial: string }>();
  readonly roots = new Set<string>();
  readonly watchers: FSWatcher[] = [];
  readonly tmpSeen = new Map<string, string>();
  timer: NodeJS.Timeout | undefined;

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

  // resume/store: the SDK's temporary config dirs. Names, sizes and modes
  // only; .credentials.json is lstat'ed, never read.
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
      const projects = join(root, 'projects');
      if (!existsSync(projects)) {
        continue;
      }
      for (const file of walkJsonl(projects)) {
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
    const buf = readFileSync(file);
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

// ---------------------------------------------------------------------------
// Driving turns

interface Step {
  text: string;
  // Called for each SDK message while this step runs; returns true once it
  // has scheduled an interrupt.
  interruptOn?: (message: SDKMessage) => number | undefined;
}

function user(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
}

function firstTextDelta(message: SDKMessage): number | undefined {
  return message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta' ? 0 : undefined;
}

function bashToolUse(delayMs: number) {
  return (message: SDKMessage): number | undefined =>
    message.type === 'assistant' && message.message.content.some((b) => b.type === 'tool_use' && b.name === 'Bash') ? delayMs : undefined;
}

async function drive(run: Run, steps: Step[], log: (s: string) => void): Promise<void> {
  let index = 0;
  let interrupted = false;
  let resultSeen = false;
  let quiet: NodeJS.Timeout | undefined;
  let line = 0;
  const send = (): void => {
    log(`send step ${index + 1}: ${JSON.stringify(steps[index]?.text)}`);
    run.send(user(steps[index]?.text ?? ''));
  };
  const advance = (): void => {
    quiet = undefined;
    resultSeen = false;
    interrupted = false;
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
    const step = steps[index];
    if (!interrupted && step?.interruptOn) {
      const delay = step.interruptOn(message);
      if (delay !== undefined) {
        interrupted = true;
        log(`sdk line ${line}: interrupt in ${delay} ms`);
        setTimeout(() => {
          log('interrupt');
          void run.interrupt().catch((err: unknown) => log(`interrupt failed: ${String(err)}`));
        }, delay);
      }
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

function makeLog(rec: Recorder): (s: string) => void {
  return (s: string): void => {
    const line = `${stamp()} ${s}`;
    process.stdout.write(`${line}\n`);
    rec.write(line);
  };
}

// ---------------------------------------------------------------------------
// Modes

const baseOptions = (model: string, store: SessionStore, flush: 'eager' | 'batched'): HarnessOptions => ({
  model,
  includePartialMessages: true,
  tools: ['Read', 'Bash'],
  allowedTools: ['Read', 'Bash'],
  thinking: { type: 'adaptive', display: 'summarized' },
  sessionStore: store,
  sessionStoreFlush: flush,
});

async function turns(model: string, flush: 'eager' | 'batched'): Promise<void> {
  const store = new RecordingStore();
  const watcher = new TranscriptWatcher();
  const logRec = new Recorder('proof-log.txt');
  const run = startRun({ name: `session-store-turns-${flush}`, options: baseOptions(model, store, flush) });
  store.rec.attach(run.dir);
  watcher.rec.attach(run.dir);
  logRec.attach(run.dir);
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}`);
  writeFileSync(join(run.cwd, 'file-17.txt'), 'alpha\n');
  // Claude Code's Bash tool refuses a standalone `sleep`; a script is not.
  // It stamps when it starts, to show the tool was running when the
  // interrupt landed.
  writeFileSync(join(run.cwd, 'wait.sh'), WAIT_SH(30));
  rmSync(join(run.cwd, 'wait-started.txt'), { force: true });
  watcher.addRoot(run.configDir);
  watcher.start();
  await drive(
    run,
    [
      { text: 'Remember the code word PERIWINKLE for later. Reply with OK and nothing else.' },
      { text: 'Let N be the number of primes below 60; work it out before you act. Then read file-N.txt (N replaced by the number) from the working directory with the Read tool and reply with its contents only.' },
      { text: 'Count from 1 to 300, one number per line, no other text.', interruptOn: firstTextDelta },
      { text: 'Run `bash wait.sh` in the working directory with the Bash tool, then reply DONE.', interruptOn: bashToolUse(2000) },
      { text: 'Reply with the word DONE and nothing else.' },
    ],
    log,
  );
  log(`wait.sh started at: ${waitStarted(run.cwd)}`);
  await finish(run, watcher, log);
}

async function resume(model: string, how: 'files' | 'store', prevDir: string): Promise<void> {
  const prev = JSON.parse(readFileSync(join(prevDir, 'run.json'), 'utf8')) as { configDir: string; cwd: string };
  const prevProjects = join(prev.configDir, 'projects');
  const main = walkJsonl(prevProjects).filter((f) => !relative(prevProjects, f).includes('/subagents/') && relative(prevProjects, f).split('/').length === 2);
  if (main.length !== 1) {
    throw new Error(`expected one main transcript under ${prevProjects}, found ${main.length}`);
  }
  const transcript = main[0] as string;
  const sessionId = basename(transcript, '.jsonl');
  const store = new RecordingStore();
  const watcher = new TranscriptWatcher();
  const logRec = new Recorder('proof-log.txt');
  let release: () => void = () => {};
  const options = baseOptions(model, store, 'eager');
  if (how === 'store') {
    store.loadSource = transcript;
    // load() waits until the run dir is known, so its record lands there.
    store.loadGate = new Promise((r) => {
      release = r;
    });
    options.resume = sessionId;
  } else {
    options.extraArgs = { resume: sessionId };
    options.spawnClaudeCodeProcess = (o: SpawnOptions): SpawnedProcess => {
      const to = join(o.env.CLAUDE_CONFIG_DIR as string, 'projects');
      cpSync(prevProjects, to, { recursive: true });
      logRec.write(`${stamp()} spawn hook: copied ${prevProjects} -> ${to}`);
      return spawn(o.command, o.args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal }) as SpawnedProcess;
    };
  }
  // Same name as the previous run, so the same cwd and project key.
  const name = basename(prev.cwd);
  const run = startRun({ name, options: { ...options } });
  store.rec.attach(run.dir);
  watcher.rec.attach(run.dir);
  logRec.attach(run.dir);
  const log = makeLog(logRec);
  log(`run dir: ${run.dir}`);
  log(`resume ${how}: session ${sessionId} from ${transcript}`);
  log(`run config dir .credentials.json exists: ${existsSync(join(run.configDir, '.credentials.json'))}`);
  watcher.addRoot(run.configDir);
  watcher.start();
  release();
  await drive(run, [{ text: 'What code word did I ask you to remember earlier? Reply with just the word.' }], log);
  await finish(run, watcher, log);
  log(`claude-resume-* left in ${tmpdir()}: ${JSON.stringify(readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-')))}`);
}

async function finish(run: Run, watcher: TranscriptWatcher, log: (s: string) => void): Promise<void> {
  try {
    await run.done;
  } catch (err) {
    log(`run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
  // Give the SDK's cleanup of a temporary config dir a moment to happen.
  await new Promise((r) => setTimeout(r, 1500));
  watcher.stop();
  log('done');
  const analysis = analyse(run.dir);
  writeFileSync(join(run.dir, 'analysis.txt'), analysis);
  process.stdout.write(`\n${analysis}`);
}

// ---------------------------------------------------------------------------
// Shutdown

interface Participant {
  label: string;
  run: Run;
  store: RecordingStore;
  watcher: TranscriptWatcher;
  abort: AbortController;
  ready: boolean;
  done: Promise<unknown>;
}

function realClaudePids(run: Run): number[] {
  const out: number[] = [];
  const capture = join(run.dir, 'claude');
  for (const n of existsSync(capture) ? readdirSync(capture) : []) {
    try {
      const { wrapperPid } = JSON.parse(readFileSync(join(capture, n, 'argv.json'), 'utf8')) as { wrapperPid: number };
      const kids = readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, 'utf8').trim();
      for (const k of kids.split(/\s+/).filter(Boolean)) {
        out.push(Number(k));
      }
    } catch {}
  }
  return out;
}

async function shutdown(model: string, stage1: 'interrupt' | 'abort', presses: number, gapMs: number, pgroup: boolean): Promise<void> {
  if (pgroup) {
    const pgid = Number(readFileSync('/proc/self/stat', 'utf8').split(') ')[1]?.split(' ')[2]);
    if (pgid !== process.pid) {
      throw new Error(`pgroup needs this process to lead its process group (run under setsid); pgid ${pgid}, pid ${process.pid}`);
    }
  }
  const hostRec = new Recorder('host-log.txt');
  const log = makeLog(hostRec);
  const specs: { label: string; text: string; readyOn: (m: SDKMessage) => number | undefined }[] = [
    { label: 'a', text: 'Count from 1 to 400, one number per line, no other text.', readyOn: firstTextDelta },
    { label: 'b', text: 'Run `bash wait.sh` in the working directory with the Bash tool, then reply DONE.', readyOn: bashToolUse(1500) },
    { label: 'c', text: 'Write a 600-word story about a lighthouse keeper. No preamble.', readyOn: firstTextDelta },
  ];
  const parts: Participant[] = [];
  let allReady: () => void = () => {};
  const ready = new Promise<void>((r) => {
    allReady = r;
  });
  for (const spec of specs) {
    const store = new RecordingStore();
    const watcher = new TranscriptWatcher();
    const abort = new AbortController();
    const run = startRun({ name: `session-store-shutdown-${spec.label}`, options: { ...baseOptions(model, store, 'eager'), abortController: abort } });
    writeFileSync(join(run.cwd, 'wait.sh'), WAIT_SH(25));
    rmSync(join(run.cwd, 'wait-started.txt'), { force: true });
    store.rec.attach(run.dir);
    watcher.rec.attach(run.dir);
    watcher.addRoot(run.configDir);
    watcher.start();
    const p: Participant = { label: spec.label, run, store, watcher, abort, ready: false, done: Promise.resolve() };
    parts.push(p);
    log(`${spec.label}: run dir ${run.dir}`);
    run.send(user(spec.text));
    p.done = (async () => {
      let line = 0;
      let scheduled = false;
      try {
        for await (const m of run.messages()) {
          line += 1;
          if (!scheduled) {
            const delay = spec.readyOn(m);
            if (delay !== undefined) {
              scheduled = true;
              setTimeout(() => {
                p.ready = true;
                log(`${spec.label}: mid-turn (sdk line ${line})`);
                if (parts.length === specs.length && parts.every((q) => q.ready)) {
                  allReady();
                }
              }, delay);
            }
          }
          if (m.type === 'result') {
            log(`${spec.label}: sdk line ${line}: result ${m.subtype}`);
          }
        }
      } catch (err) {
        log(`${spec.label}: messages threw: ${String(err)}`);
      }
      try {
        await run.done;
        log(`${spec.label}: run.done settled`);
      } catch (err) {
        log(`${spec.label}: run.done rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  let stopWaiting: () => void = () => {};
  const stopped = new Promise<void>((r) => {
    stopWaiting = r;
  });
  let pressCount = 0;
  process.on('SIGINT', () => {
    pressCount += 1;
    log(`SIGINT ${pressCount}`);
    if (pressCount === 1) {
      log(`stage 1 (${stage1})`);
      for (const p of parts) {
        if (stage1 === 'interrupt') {
          void (async () => {
            try {
              await p.run.interrupt();
              log(`${p.label}: interrupt returned`);
            } catch (err) {
              log(`${p.label}: interrupt failed: ${String(err)}`);
            }
            p.run.end();
            log(`${p.label}: input ended`);
          })();
        } else {
          p.abort.abort();
          log(`${p.label}: aborted`);
        }
      }
    } else if (pressCount === 2) {
      log('stage 2: SIGTERM each Claude Code, stop waiting');
      for (const p of parts) {
        for (const pid of realClaudePids(p.run)) {
          try {
            process.kill(pid, 'SIGTERM');
            log(`${p.label}: SIGTERM ${pid}`);
          } catch (err) {
            log(`${p.label}: SIGTERM ${pid} failed: ${String(err)}`);
          }
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
      const projects = join(p.run.configDir, 'projects');
      const snapshot = walkJsonl(projects).map((f) => ({ file: relative(p.run.configDir, f), text: redact(readFileSync(f, 'utf8')).text }));
      writeFileSync(join(p.run.dir, 'transcript-at-host-exit.json'), JSON.stringify({ at, snapshot }));
      writeFileSync(join(p.run.dir, 'host-exit.json'), JSON.stringify({ at, code, presses: pressCount, stage1, pgroup, claudePids: realClaudePids(p.run) }, null, 2));
    }
    hostRec.write(`${at} exit ${code}`);
  });

  await ready;
  log(`all mid-turn; ${presses} press(es) ${gapMs} ms apart${pgroup ? ' to the process group' : ''}`);
  for (let i = 0; i < presses; i += 1) {
    if (pgroup) {
      process.kill(-process.pid, 'SIGINT');
    } else {
      process.kill(process.pid, 'SIGINT');
    }
    if (i < presses - 1) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  await Promise.race([Promise.allSettled(parts.map((p) => p.done)), stopped]);
  log('main: stopped waiting / all done; returning');
  log(`b: wait.sh started at: ${waitStarted(parts[1]?.run.cwd ?? '')}`);
  for (const p of parts) {
    p.watcher.stop();
  }
  // What keeps node alive after main returns, sampled without holding it.
  const sample = setInterval(() => {
    log(`still alive; active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`);
  }, 1000);
  sample.unref();
}

// ---------------------------------------------------------------------------
// Analysis

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

function readStamped(path: string): { ts: string; json: Json | undefined; raw: string }[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const sp = l.indexOf(' ');
      const raw = l.slice(sp + 1);
      let json: Json | undefined;
      try {
        json = JSON.parse(raw) as Json;
      } catch {}
      return { ts: l.slice(0, sp), json, raw };
    });
}

function ms(a: string | undefined, b: string | undefined): string {
  if (!a || !b) {
    return '-';
  }
  const t = (s: string): number => Date.parse(s.slice(0, 23) + 'Z') + Number(s.slice(23, 26)) / 1000;
  return (t(a) - t(b)).toFixed(1);
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
          return `text "${String(b.text).slice(0, 40).replace(/\n/g, '\\n')}"(${String(b.text).length})`;
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
  if (msg?.stop_reason) {
    what += ` stop=${String(msg.stop_reason)}`;
  }
  return what;
}

interface Located {
  file: string;
  line: number;
  entry: Json;
  canon: string;
}

function transcriptLines(root: string, redactLines: boolean): Located[] {
  const projects = join(root, 'projects');
  const out: Located[] = [];
  for (const f of walkJsonl(projects)) {
    const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '');
    lines.forEach((l, i) => {
      const text = redactLines ? redact(l).text : l;
      const entry = JSON.parse(text) as Json;
      out.push({ file: relative(root, f), line: i + 1, entry, canon: canon(entry) });
    });
  }
  return out;
}

function analyse(dir: string): string {
  const out: string[] = [];
  const w = (s = ''): void => {
    out.push(s);
  };
  const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { configDir: string };
  w(`# ${dir}`);

  // The store's view, in append-call order.
  const storePath = join(dir, 'store-appends.jsonl');
  const calls = existsSync(storePath) ? readJsonl(storePath) : [];
  const stored: { call: number; idx: number; ts: string; key: Json; entry: Json; canon: string }[] = [];
  for (const c of calls) {
    if (c.event === 'load') {
      w(`store load() called at ${String(c.ts)} key=${JSON.stringify(c.key)} source=${String(c.source)}`);
      continue;
    }
    (c.entries as Json[]).forEach((entry, idx) => {
      stored.push({ call: Number(c.call), idx, ts: String(c.ts), key: c.key as Json, entry, canon: canon(entry) });
    });
  }
  w(`store: ${calls.filter((c) => c.event !== 'load').length} append() calls, ${stored.length} entries (${storePath})`);

  // Transcripts: the harness copy (config-dir/, redacted) if the run
  // finished; else the live config dir (the host exited first).
  const copy = join(dir, 'config-dir');
  const finished = existsSync(join(dir, 'config-dir-manifest.json'));
  const tRoot = finished ? copy : runJson.configDir;
  const tLines = transcriptLines(tRoot, !finished);
  w(`transcript source: ${finished ? 'harness copy' : 'LIVE config dir (host exited before the harness copied it)'} ${tRoot}`);

  // Resume through the store writes into a temporary config dir; its lines
  // are known only from the watcher.
  const watch = existsSync(join(dir, 'transcript-watch.jsonl')) ? readJsonl(join(dir, 'transcript-watch.jsonl')) : [];
  for (const ev of watch.filter((e) => e.event === 'tmp-config-dir' || e.event === 'tmp-config-dir-gone')) {
    w(`watch: ${String(ev.ts)} ${String(ev.event)} ${String(ev.root)}${ev.listing ? ` ${JSON.stringify(ev.listing)}` : ''}`);
  }
  const otherRoots = [...new Set(watch.filter((e) => e.file && e.root !== runJson.configDir).map((e) => String(e.root)))];
  for (const r of otherRoots) {
    const n = watch.filter((e) => e.root === r && e.file).length;
    w(`watch: ${n} transcript lines were written under ${r} (not the run's config dir)`);
  }

  // Q1: stream equality, per file.
  w();
  w('== Q1: transcript lines vs store entries (per file, in order)');
  const byFile = new Map<string, Located[]>();
  for (const l of tLines) {
    byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);
  }
  const storeByKey = new Map<string, typeof stored>();
  for (const s of stored) {
    const k = `${String(s.key.sessionId)}${s.key.subpath ? `/${String(s.key.subpath)}` : ''}`;
    storeByKey.set(k, [...(storeByKey.get(k) ?? []), s]);
  }
  const usedStore = new Set<string>();
  for (const [file, lines] of byFile) {
    const rel = file.split('/').slice(2).join('/').replace(/\.jsonl$/, '');
    const s = storeByKey.get(rel) ?? [];
    w(`${file}: ${lines.length} lines; store key ${rel}: ${s.length} entries`);
    // A resumed session's file already holds the earlier lines; the store
    // sees only what this run wrote. Align on the store's first entry.
    const first = s[0];
    const offset = first ? Math.max(0, lines.findIndex((l) => l.canon === first.canon)) : 0;
    if (offset > 0) {
      w(`  lines 1-${offset} were in the file before this run's first append (not sent to the store); comparing from line ${offset + 1}`);
    }
    const n = Math.max(lines.length - offset, s.length);
    let equalInOrder = 0;
    for (let i = 0; i < n; i += 1) {
      const l = lines[i + offset];
      const e = s[i];
      const same = l && e && l.canon === e.canon;
      if (same) {
        equalInOrder += 1;
      }
      if (!same) {
        const elsewhere = l ? s.findIndex((x) => x.canon === l.canon) : -1;
        w(`  MISMATCH at ${i + offset + 1}: file ${l ? `line ${l.line} ${describeEntry(l.entry)}` : '(none)'} | store ${e ? `call ${e.call}#${e.idx} ${describeEntry(e.entry)}` : '(none)'}${elsewhere >= 0 ? ` | file line found in store at position ${elsewhere + 1}` : l ? ' | file line NOT in store' : ''}`);
      }
    }
    w(`  ${equalInOrder}/${n} positions deep-equal in order`);
    usedStore.add(rel);
  }
  for (const [k, s] of storeByKey) {
    if (!usedStore.has(k)) {
      w(`store key ${k}: ${s.length} entries with NO transcript file in ${tRoot}`);
    }
  }

  // Q2: timing per transcript line.
  w();
  w('== Q2: per transcript line; times in ms relative to the line first seen on disk');
  w('   frame = stdout transcript_mirror frame holding it; append = store.append() call; msg-out = binary stdout of the SDK message with that uuid; msg-sdk = harness received it from the SDK');
  const stdout = readdirSync(join(dir, 'claude'))
    .flatMap((n) => readStamped(join(dir, 'claude', n, 'stdout.txt')))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const outByUuid = new Map<string, string>();
  for (const l of stdout) {
    const u = l.json?.uuid;
    if (typeof u === 'string' && l.json?.type !== 'transcript_mirror' && !outByUuid.has(u)) {
      outByUuid.set(u, l.ts);
    }
  }
  const sdk = readJsonl(join(dir, 'sdk-messages.jsonl'));
  const sdkByUuid = new Map<string, { ts: string; line: number }>();
  sdk.forEach((s, i) => {
    const m = s.message as Json;
    if (typeof m.uuid === 'string' && m.type !== 'stream_event' && !sdkByUuid.has(m.uuid)) {
      sdkByUuid.set(m.uuid, { ts: String(s.ts), line: i + 1 });
    }
  });
  const seen = new Map<string, string>();
  for (const ev of watch) {
    if (ev.file) {
      const k = `${String(ev.file)}:${String(ev.line)}`;
      if (!seen.has(k)) {
        seen.set(k, String(ev.ts));
      }
    }
  }
  // Positional matching: the n-th line of a file against the n-th entry the
  // frames (and the store) carried for it. Lines without a uuid repeat
  // (ai-title, atis-latch), so matching by content alone would pick the
  // first copy. A position whose content differs is shown as '!='.
  const frameSeq = new Map<string, { ts: string; canon: string; stdoutLine: number }[]>();
  stdout.forEach((l, i) => {
    if (l.json?.type !== 'transcript_mirror') {
      return;
    }
    const fp = String(l.json.filePath);
    const rel = fp.startsWith(runJson.configDir) ? relative(runJson.configDir, fp) : fp;
    for (const e of (l.json.entries as Json[]) ?? []) {
      frameSeq.set(rel, [...(frameSeq.get(rel) ?? []), { ts: l.ts, canon: canon(e), stdoutLine: i }]);
    }
  });
  // Stream timing per API message id: message_start and message_stop as
  // the binary printed them.
  const streamById = new Map<string, { start?: string; stop?: string; text: number }>();
  let current: string | undefined;
  for (const l of stdout) {
    const ev = l.json?.type === 'stream_event' && l.json.parent_tool_use_id == null ? (l.json.event as Json) : undefined;
    if (!ev) {
      continue;
    }
    if (ev.type === 'message_start') {
      current = String((ev.message as Json).id);
      streamById.set(current, { start: l.ts, text: 0 });
    } else if (current && ev.type === 'content_block_delta' && (ev.delta as Json).type === 'text_delta') {
      const s = streamById.get(current);
      if (s) {
        s.text += String((ev.delta as Json).text).length;
      }
    } else if (current && ev.type === 'message_stop') {
      const s = streamById.get(current);
      if (s) {
        s.stop = l.ts;
      }
    }
  }
  w('   stream = message_stop of the entry\'s API message on binary stdout (streamed text chars in brackets)');
  for (const [file, lines] of byFile) {
    const fs = frameSeq.get(file) ?? [];
    const rel = file.split('/').slice(2).join('/').replace(/\.jsonl$/, '');
    const ss = storeByKey.get(rel) ?? [];
    const firstFrame = fs[0];
    const off = firstFrame ? Math.max(0, lines.findIndex((l) => l.canon === firstFrame.canon)) : 0;
    lines.forEach((l, i) => {
      const tFile = seen.get(`${l.file}:${l.line}`);
      const frame = i >= off ? fs[i - off] : undefined;
      const st = i >= off ? ss[i - off] : undefined;
      const u = typeof l.entry.uuid === 'string' ? l.entry.uuid : undefined;
      const out1 = u ? outByUuid.get(u) : undefined;
      const sd = u ? sdkByUuid.get(u) : undefined;
      const mid = l.entry.type === 'assistant' ? (l.entry.message as Json | undefined)?.id : undefined;
      const stream = typeof mid === 'string' ? streamById.get(mid) : undefined;
      w(
        `  ${rel.split('/').pop()}:${l.line} ${describeEntry(l.entry).slice(0, 80)} | disk ${tFile?.slice(11) ?? '-'} | frame ${ms(frame?.ts, tFile)}${frame && frame.canon !== l.canon ? '!=' : ''} | append ${ms(st?.ts, tFile)}${st ? ` (call ${st.call})` : ''}${st && st.canon !== l.canon ? '!=' : ''} | msg-out ${ms(out1, tFile)} | msg-sdk ${ms(sd?.ts, tFile)}${sd ? ` (sdk line ${sd.line})` : ''}${stream ? ` | stream ${ms(stream.stop, tFile)} [${stream.text}]` : ''}`,
      );
    });
  }
  w();
  w('   results: binary stdout time, harness receive time, and the store calls around them');
  sdk.forEach((s, i) => {
    const m = s.message as Json;
    if (m.type !== 'result') {
      return;
    }
    const out1 = stdout.find((l) => l.json?.type === 'result' && l.json?.uuid === m.uuid);
    const before = calls.filter((c) => c.event !== 'load' && String(c.ts) <= String(s.ts)).at(-1);
    const after = calls.find((c) => c.event !== 'load' && String(c.ts) > String(s.ts));
    w(`  sdk line ${i + 1} result/${String(m.subtype)} stdout ${out1?.ts ?? '-'} sdk ${String(s.ts)} | last append before: call ${String(before?.call ?? '-')} at ${String(before?.ts ?? '-')} | next append after: call ${String(after?.call ?? '-')} at ${String(after?.ts ?? '-')}`);
  });

  // Shutdown runs: what the host had when it exited, and what came after.
  const snapPath = join(dir, 'transcript-at-host-exit.json');
  if (existsSync(snapPath)) {
    const snap = JSON.parse(readFileSync(snapPath, 'utf8')) as { at: string; snapshot: { file: string; text: string }[] };
    const hostExit = JSON.parse(readFileSync(join(dir, 'host-exit.json'), 'utf8')) as Json;
    w();
    w(`== Q4: host exited at ${snap.at} (${JSON.stringify(hostExit)})`);
    const snapCanon = snap.snapshot.flatMap((s) => s.text.split('\n').filter((x) => x.trim() !== '').map((x) => canon(JSON.parse(x))));
    // Multisets: bookkeeping lines without a uuid repeat (ai-title,
    // atis-latch), so each final line consumes one matching store entry.
    const bag = (xs: string[]): Map<string, number> => {
      const m = new Map<string, number>();
      for (const x of xs) {
        m.set(x, (m.get(x) ?? 0) + 1);
      }
      return m;
    };
    const take = (m: Map<string, number>, k: string): boolean => {
      const n = m.get(k) ?? 0;
      if (n > 0) {
        m.set(k, n - 1);
        return true;
      }
      return false;
    };
    const storedBeforeExit = bag(stored.filter((s) => s.ts <= snap.at).map((s) => s.canon));
    const storedAfterExit = bag(stored.filter((s) => s.ts > snap.at).map((s) => s.canon));
    const snapBag = bag([...snapCanon]);
    for (const n of readdirSync(join(dir, 'claude'))) {
      const exit = join(dir, 'claude', n, 'exit.json');
      w(`claude/${n}/exit.json: ${existsSync(exit) ? readFileSync(exit, 'utf8').replace(/\s+/g, ' ') : 'MISSING (wrapper did not record an exit)'}`);
    }
    w('final transcript line | on disk at host exit | in store by host exit');
    let lost = 0;
    for (const l of tLines) {
      const onDisk = take(snapBag, l.canon);
      const inStore = take(storedBeforeExit, l.canon);
      if (!inStore) {
        lost += 1;
      }
      w(`  ${l.file.split('/').slice(2).join('/')}:${l.line} ${describeEntry(l.entry).slice(0, 100)} | ${onDisk ? 'disk' : 'NOT-ON-DISK'} | ${inStore ? 'store' : take(storedAfterExit, l.canon) ? 'store-AFTER-exit' : 'NOT-IN-STORE'}`);
    }
    w(`  ${lost} of ${tLines.length} final transcript lines never reached append() before the host exited`);
    const extra = stored.filter((s) => !tLines.some((l) => l.canon === s.canon));
    w(`  ${extra.length} store entries not in the final transcript`);
  }
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2);
if (mode === '--analyse') {
  for (const dir of rest) {
    const text = analyse(dir);
    writeFileSync(join(dir, 'analysis.txt'), text);
    process.stdout.write(text);
  }
} else if (mode === 'turns' && rest[0] && (rest[1] === 'eager' || rest[1] === 'batched')) {
  await turns(rest[0], rest[1]);
} else if (mode === 'resume' && rest[0] && (rest[1] === 'files' || rest[1] === 'store') && rest[2]) {
  await resume(rest[0], rest[1], rest[2]);
} else if (mode === 'shutdown' && rest[0] && (rest[1] === 'interrupt' || rest[1] === 'abort') && ['1', '2', '3'].includes(rest[2] ?? '')) {
  const gap = rest.find((a) => a.startsWith('gap='));
  await shutdown(rest[0], rest[1], Number(rest[2]), gap ? Number(gap.slice(4)) : 500, rest.includes('pgroup'));
} else {
  process.stderr.write(
    'usage:\n  node proofs/session-store.mts turns <model> <eager|batched>\n  node proofs/session-store.mts resume <model> <files|store> <prev run dir>\n  node proofs/session-store.mts shutdown <model> <interrupt|abort> <1|2|3> [gap=<ms>] [pgroup]\n  node proofs/session-store.mts --analyse <run dir> [...]\n',
  );
  process.exit(2);
}
