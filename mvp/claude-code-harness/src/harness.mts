// The proof harness: runs Claude Code through the Agent SDK as one query()
// fed a stream of messages and records everything raw into a run directory.
//
// Isolation is the harness's baseline, not the proof's choice (Stephen,
// 26 Sep: "the whole point is this is the BASELINE"). Every run gets:
// settingSources [] (no user, project or local settings, no CLAUDE.md), the
// agent's own CLAUDE_CONFIG_DIR (one per proof name, reused by every run of
// it), the shared login (CLAUDE_SECURESTORAGE_CONFIG_DIR empty), and an
// environment stripped of a parent Claude Code session's variables. It also
// sets the working directory (the proof's own, reused across its runs) and
// pathToClaudeCodeExecutable (the capture wrapper, which runs the SDK's own
// bundled binary). Each run's directory gets a filtered copy of the config
// directory as it stands after the run, which holds everything the agent has
// accumulated, not only that run's files.
//
// Everything else comes from the proof: "let each do its own settings". The
// harness has no defaults of its own.

import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Options, type Query, query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { redact, stamp } from './record.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const RUNS_ROOT = join(PACKAGE_ROOT, 'runs');
const WRAPPER = join(PACKAGE_ROOT, 'bin', 'claude-capture');

const STATE_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness');

// Each agent's CLAUDE_CONFIG_DIR, config-dirs/<name>/, named after the proof
// and reused by every run of it: "as long as each agent gets its own
// directory, and can keep reusing it, ie its not a random directory every
// run, that would cause issues" (Stephen, 26 Sep); "its ONE directory PER
// agent" (27 Sep). Created on first use. Only resetConfigDir deletes it, for a
// clean start; agents reset it through the package script, never by hand.
//
// TODO: undecided. Where it lives. Outside the repo is what's built: nothing
// Claude Code writes there can reach the repo unfiltered (with the shared
// login no credential file should be written there, but that rests on the
// login staying shared), and the run directory gets a filtered copy. The
// alternative, under runs/, keeps everything in one place, but anything
// Claude Code writes lands in the repo unfiltered.
const CONFIG_DIRS_ROOT = join(STATE_ROOT, 'config-dirs');

// Where an earlier resetConfigDir moved config directories aside
// (config-dirs/.reset/<name>-<timestamp>/), before a reset deleted instead.
// Kept as it is; resetConfigDir refuses the name `.reset` so a reset can
// never delete it.
//
// TODO: undecided. A proof named `.reset` passes startRun's name check, so
// its startRun would use this folder as its live CLAUDE_CONFIG_DIR. Refusing
// the name there too keeps the folder out of reach of any run; leaving it
// keeps startRun's name check as it is.
const RESET_ROOT_NAME = '.reset';

// Each proof's working directory, named after the proof and reused by every
// run of it. Created the first time, never cleared. resetConfigDir does not
// touch it.
const WORK_ROOT = join(STATE_ROOT, 'work');

// What a parent Claude Code session passes down to the processes it starts.
// Source: claude 2.1.282, the env it builds for child processes (CLAUDECODE,
// CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION,
// CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_PID, AI_AGENT, CLAUDE_EFFORT), its
// Bash tool's list (adds CLAUDE_CODE_EXECPATH, CLAUDE_CODE_INVOKED_SKILLS),
// its MCP/hook env (CLAUDE_PROJECT_DIR), and what a live session's shell was
// seen to hold (CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_MESSAGING_SOCKET,
// CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_CODE_BRIDGE_SESSION_ID). Generic names
// it also sets (GIT_EDITOR, TRACEPARENT, TMPDIR) are left alone: a user's
// own shell sets those too.
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
];

// Files never copied out of the config directory, whatever they hold.
const NEVER_COPY = new Set(['.credentials.json']);

// What the harness sets is not the proof's to pass: settingSources (the
// isolation baseline), cwd (the proof's own directory) and the executable.
// CLAUDE_CONFIG_DIR (the agent's own) and CLAUDE_SECURESTORAGE_CONFIG_DIR in
// options.env are overridden the same way.
export type HarnessOptions = Omit<Options, 'pathToClaudeCodeExecutable' | 'settingSources' | 'cwd'> & { model: string };

export interface StartRunArgs {
  // The proof's name: the agent. Names the run directory
  // (runs/<timestamp>-<name>/), the working directory
  // (~/.local/state/tower-claude-code-harness/work/<name>/) and the config
  // directory (~/.local/state/tower-claude-code-harness/config-dirs/<name>/).
  // Every run under one name shares the last two.
  name: string;
  options: HarnessOptions;
}

export interface RunResult {
  dir: string;
}

export interface Run {
  readonly id: string;
  readonly dir: string;
  readonly configDir: string;
  readonly cwd: string;
  // The SDK's query object, for any control call (setModel,
  // setPermissionMode, ...). Calls made on it directly are not logged in
  // harness-events.jsonl; their effect shows in the binary's stdin capture.
  readonly query: Query;
  // Push one message into the running Claude Code.
  send(message: SDKUserMessage): void;
  // Close the input stream. Claude Code exits once it's done.
  end(): void;
  interrupt(): ReturnType<Query['interrupt']>;
  // Every SDK message, in order. One consumer.
  messages(): AsyncIterable<SDKMessage>;
  // Settles after the query has finished, the binary has exited and the
  // config directory has been copied. Rejects with the query's error, if
  // any, after all of that.
  readonly done: Promise<RunResult>;
}

class Channel<T> implements AsyncIterable<T> {
  readonly items: T[] = [];
  waiting: ((result: IteratorResult<T>) => void) | undefined;
  closed = false;

  push(item: T): void {
    if (this.closed) {
      throw new Error('harness: channel is closed');
    }
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

function sdkEntry(): string {
  return fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
}

// The binary the SDK would run by default: its own per-platform package.
function resolveRealBinary(): string {
  const fromSdk = createRequire(sdkEntry());
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return fromSdk.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${name}`);
}

function sdkVersion(): string {
  const pkg = JSON.parse(readFileSync(join(dirname(sdkEntry()), 'package.json'), 'utf8')) as { version: string };
  return pkg.version;
}

// Options as recorded: functions and objects that don't serialise are named,
// env is reduced to its names (values can be secrets).
function describeOptions(options: HarnessOptions): unknown {
  return JSON.parse(
    JSON.stringify(options, (key, value) => {
      if (key === 'env' && value && typeof value === 'object') {
        return { names: Object.keys(value).sort() };
      }
      if (typeof value === 'function') {
        return '[function]';
      }
      if (value instanceof AbortController) {
        return '[AbortController]';
      }
      return value;
    }),
  );
}

function jsonLine(value: unknown): string {
  return `${redact(JSON.stringify(value)).text}\n`;
}

interface CopyManifest {
  copied: string[];
  skipped: string[];
  symlinks: Record<string, string>;
  redactedFiles: Record<string, number>;
}

function copyConfigDir(from: string, to: string): CopyManifest {
  const manifest: CopyManifest = { copied: [], skipped: [], symlinks: {}, redactedFiles: {} };
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(from, rel))) {
      const relPath = rel ? join(rel, entry) : entry;
      const srcPath = join(from, relPath);
      const stat = lstatSync(srcPath);
      if (NEVER_COPY.has(entry)) {
        manifest.skipped.push(relPath);
      } else if (stat.isSymbolicLink()) {
        manifest.symlinks[relPath] = readlinkSync(srcPath);
      } else if (stat.isDirectory()) {
        mkdirSync(join(to, relPath), { recursive: true });
        walk(relPath);
      } else if (stat.isFile()) {
        // latin1 maps bytes 1:1, so a file with no match is copied unchanged.
        const { text, count } = redact(readFileSync(srcPath).toString('latin1'));
        if (count > 0) {
          manifest.redactedFiles[relPath] = count;
        }
        writeFileSync(join(to, relPath), Buffer.from(text, 'latin1'));
        manifest.copied.push(relPath);
      } else {
        manifest.skipped.push(relPath);
      }
    }
  };
  mkdirSync(to, { recursive: true });
  walk('');
  return manifest;
}

// The query can finish a moment before the wrapper has written its exit
// record; wait for every spawn's exit.json before copying the config dir.
async function waitForBinaryExit(captureDir: string, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const spawns = existsSync(captureDir) ? readdirSync(captureDir) : [];
    const running = spawns.filter((s) => !existsSync(join(captureDir, s, 'exit.json')));
    if (running.length === 0 || Date.now() >= deadline) {
      return running;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Field 22 of /proc/<pid>/stat (the process's start time, in clock ticks
// since boot) and its state, or undefined when the pid has no /proc entry.
// The fields are counted after the last ')', since the command name in
// field 2 can hold spaces and parentheses.
function procStat(pid: number): { state: string; starttime: string } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0] ?? '?', starttime: f[19] ?? '?' };
  } catch {
    return undefined;
  }
}

export interface LiveClaudeCode {
  file: string;
  pid: number;
  procStart: string;
  starttimeNow: string;
}

// Every Claude Code still running with this config directory, by its own
// record, sessions/<pid>.json: live when the pid is alive (not a zombie) and
// the file's procStart equals field 22 of /proc/<pid>/stat, so a reused pid
// doesn't count. Proof 17 validated this check (208/208).
//
// TODO: undecided. What fails open here:
// - No /proc (macOS): every pid reads as not running.
// - A pid file that can't be read or parsed (such as one half-written by a
//   starting Claude Code) is skipped, not counted as live.
// - A Claude Code that has started but not yet written its pid file, and a
//   run whose Claude Code has exited but whose harness is still copying the
//   config directory into the run directory, have no pid file.
// - A run can start between this check and the delete.
// With a delete these matter more than they did with a move: a reset that
// slips through deletes files a running Claude Code is using, and a reset
// during a run's final copy leaves that run's config-dir/ record partial.
export function liveClaudeCodes(configDir: string): LiveClaudeCode[] {
  const sessions = join(configDir, 'sessions');
  let names: string[] = [];
  try {
    names = readdirSync(sessions).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const live: LiveClaudeCode[] = [];
  for (const n of names) {
    const file = join(sessions, n);
    let d: { pid?: unknown; procStart?: unknown };
    try {
      d = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown; procStart?: unknown };
    } catch {
      continue;
    }
    const pid = Number(d.pid);
    const st = Number.isInteger(pid) && pid > 0 ? procStat(pid) : undefined;
    if (st && st.state !== 'Z' && st.state !== 'X' && st.starttime === String(d.procStart)) {
      live.push({ file, pid, procStart: String(d.procStart), starttimeNow: st.starttime });
    }
  }
  return live;
}

export interface ResetResult {
  configDir: string;
  // Whether an old directory was there and was deleted.
  deleted: boolean;
}

// A clean start for one agent. Agents run it through the package script
// (src/reset-config-dir.mts, `pnpm reset-config-dir <name>`), never rm by
// hand: "deleting is fine / what i meant is, we shouldnt make the agents use
// rm / ie they use a script to do it 'safely'" (Stephen, 27 Sep). Deletes
// config-dirs/<name>/, whole, and makes a new empty one in its place. Each
// run's runs/<id>/config-dir/ copy is the record of what was there. The
// working directory is left as it is.
//
// Refuses when any Claude Code is still running with that directory (see
// liveClaudeCodes); for the names `.` and `..`, which would point at
// config-dirs/ itself or the state folder above it; and for `.reset`, the
// folder an earlier move-aside reset filled, which is kept. It only ever
// deletes config-dirs/<name>/: rmSync removes a symlink itself, never what
// it points at, and never follows links inside the directory.
//
// TODO: undecided. The per-run config directories from before one-per-agent,
// config-dirs/<timestamp>-<name>/, pass the name check, so a reset under one
// of those names deletes a directory the README says is kept. Refusing names
// of that shape keeps those old records safe; leaving it keeps the name check
// as simple as startRun's.
export function resetConfigDir(name: string): ResetResult {
  checkName(name);
  if (name === '.' || name === '..') {
    throw new Error(`harness: cannot reset ${JSON.stringify(name)}: it names config-dirs/ itself or the folder above it, not an agent's config directory`);
  }
  if (name === RESET_ROOT_NAME) {
    throw new Error(`harness: cannot reset ${JSON.stringify(name)}: it is the folder an earlier reset moved config directories into, which is kept`);
  }
  const configDir = join(CONFIG_DIRS_ROOT, name);
  // The one directory a reset may delete: a direct child of config-dirs/
  // named exactly `name`.
  if (dirname(configDir) !== CONFIG_DIRS_ROOT || basename(configDir) !== name) {
    throw new Error(`harness: cannot reset ${JSON.stringify(name)}: ${configDir} is not directly inside ${CONFIG_DIRS_ROOT}`);
  }
  // TODO: undecided. A name with no config directory yet (never run) gets a
  // new empty one and nothing is deleted. The alternative is to refuse, which
  // would catch a misspelt name.
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
    return { configDir, deleted: false };
  }
  const live = liveClaudeCodes(configDir);
  if (live.length > 0) {
    const which = live.map((l) => `pid ${l.pid} (${l.file}, procStart ${l.procStart}, /proc starttime ${l.starttimeNow})`).join('; ');
    throw new Error(`harness: cannot reset ${JSON.stringify(name)}: Claude Code is still running with ${configDir}: ${which}`);
  }
  rmSync(configDir, { recursive: true });
  mkdirSync(configDir);
  return { configDir, deleted: true };
}

function checkName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`harness: run name must match [A-Za-z0-9._-]+, got ${JSON.stringify(name)}`);
  }
}

export function startRun(args: StartRunArgs): Run {
  const { name, options } = args;
  // TODO: undecided. startRun still accepts `.` and `..`, which resetConfigDir
  // refuses: `.` gives Claude Code all of config-dirs/ as its config
  // directory and work/ as its working directory, `..` the state folder and
  // its parent. Refusing them here too keeps every run inside its own
  // directory; leaving them keeps startRun's name check as it was.
  checkName(name);
  if (typeof options?.model !== 'string' || options.model.trim() === '') {
    throw new Error('harness: options.model is required');
  }

  const startedAt = stamp();
  const id = `${startedAt.replace(/[:.]/g, '')}-${name}`;
  const dir = join(RUNS_ROOT, id);
  const captureDir = join(dir, 'claude');
  // Shared by every run under this name, one after another or at the same
  // time, with no lock and no per-run separation inside it: sharing is the
  // point. Claude Code keeps its own state here (transcripts under projects/,
  // sessions/<pid>.json per running process, .claude.json), and a proof tests
  // Claude Code against that state as a real participant would meet it, such
  // as an orphaned Claude Code meeting a newly started one on one session.
  // A clean start is a reset first: `pnpm reset-config-dir <name>`.
  const configDir = join(CONFIG_DIRS_ROOT, name);
  const cwd = join(WORK_ROOT, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  const realBinary = resolveRealBinary();

  // A parent Claude Code's session variables are stripped (Stephen, 26 Sep:
  // the runs are isolated), from options.env too, since a proof building its
  // env from process.env would carry them in.
  const base: Record<string, string | undefined> = { ...(options.env ?? process.env) };
  const stripped = PARENT_SESSION_VARS.filter((name) => name in base);
  for (const name of stripped) {
    delete base[name];
  }

  // The login (Stephen, 26 Sep, way 1): settings and config in the agent's
  // own CLAUDE_CONFIG_DIR, the login in the default store. An empty
  // CLAUDE_SECURESTORAGE_CONFIG_DIR makes Claude Code use ~/.claude for the
  // credential file, its refresh lock and (macOS) the default Keychain item,
  // so this run and Stephen's own Claude Code share one login and one
  // refresh lock. Undocumented in 2.1.282; see README.
  //
  // CLAUDE_CONFIG_DIR is always the agent's own, even if options.env names one.
  const env: Record<string, string | undefined> = {
    ...base,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    HARNESS_CAPTURE_DIR: captureDir,
    HARNESS_REAL_CLAUDE: realBinary,
  };

  writeFileSync(
    join(dir, 'run.json'),
    jsonLine({
      id,
      startedAt,
      configDir,
      cwd,
      settingSources: [],
      realBinary,
      wrapper: WRAPPER,
      sdkVersion: sdkVersion(),
      strippedEnv: stripped,
      options: describeOptions(options),
    }),
  );

  const events = createWriteStream(join(dir, 'harness-events.jsonl'));
  const sdkLog = createWriteStream(join(dir, 'sdk-messages.jsonl'));
  const event = (kind: string, detail?: unknown): void => {
    events.write(jsonLine({ ts: stamp(), event: kind, ...(detail === undefined ? {} : { detail }) }));
  };

  const inbox = new Channel<SDKUserMessage>();
  const outbox = new Channel<SDKMessage>();

  const q = query({
    prompt: inbox,
    // The harness's values last, so a proof that passes them anyway (from
    // untyped code) cannot switch the baseline off.
    options: { ...options, env, settingSources: [], cwd, pathToClaudeCodeExecutable: WRAPPER },
  });
  event('start');

  const done = (async (): Promise<RunResult> => {
    let error: unknown;
    try {
      for await (const message of q) {
        sdkLog.write(jsonLine({ ts: stamp(), message }));
        outbox.push(message);
      }
      event('query-finished');
    } catch (err) {
      error = err;
      event('query-error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      outbox.close();
    }
    const stillRunning = await waitForBinaryExit(captureDir, 10_000);
    if (stillRunning.length > 0) {
      event('binary-still-running', { spawns: stillRunning });
    }
    const manifest = copyConfigDir(configDir, join(dir, 'config-dir'));
    writeFileSync(join(dir, 'config-dir-manifest.json'), jsonLine({ copiedAt: stamp(), from: configDir, ...manifest }));
    event('done');
    await Promise.all([new Promise((r) => sdkLog.end(r)), new Promise((r) => events.end(r))]);
    if (error !== undefined) {
      throw error;
    }
    return { dir };
  })();

  return {
    id,
    dir,
    configDir,
    cwd,
    query: q,
    send(message) {
      event('send', message);
      inbox.push(message);
    },
    end() {
      event('end');
      inbox.close();
    },
    async interrupt() {
      event('interrupt');
      const result = await q.interrupt();
      event('interrupt-returned', result ?? null);
      return result;
    },
    messages() {
      return outbox;
    },
    done,
  };
}
