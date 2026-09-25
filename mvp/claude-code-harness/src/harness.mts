// The proof harness: runs Claude Code through the Agent SDK as one query()
// fed a stream of messages, in a fresh config directory of its own, and
// records everything raw into a run directory.
//
// It sets nothing about Claude Code's behaviour. Model, permission mode,
// tools, messages and interrupts come from the proof. What it does set:
// CLAUDE_CONFIG_DIR (a fresh directory per run) and
// pathToClaudeCodeExecutable (the capture wrapper, which runs the SDK's own
// bundled binary).

import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Options, type Query, query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { redact, stamp } from './record.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
const RUNS_ROOT = join(PACKAGE_ROOT, 'runs');
const WRAPPER = join(PACKAGE_ROOT, 'bin', 'claude-capture');

// TODO: undecided. Where the live config directory lives. It is outside the
// repo because, depending on the login way Stephen picks, Claude Code may
// write credentials into it, and no credential may land under the repo; the
// run directory gets a filtered copy. Alternatives: under runs/ (everything
// in one place, but credentials could land in the repo), or deleted after
// the copy (nothing lingers, but a later proof can't inspect or resume it).
const CONFIG_DIRS_ROOT = join(homedir(), '.local', 'state', 'tower-claude-code-harness', 'config-dirs');

// Files never copied out of the config directory, whatever they hold.
const NEVER_COPY = new Set(['.credentials.json']);

export type HarnessOptions = Omit<Options, 'pathToClaudeCodeExecutable'> & { model: string };

export interface StartRunArgs {
  // Names the run directory: runs/<timestamp>-<name>/.
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

export function startRun(args: StartRunArgs): Run {
  const { name, options } = args;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`harness: run name must match [A-Za-z0-9._-]+, got ${JSON.stringify(name)}`);
  }
  if (typeof options?.model !== 'string' || options.model.trim() === '') {
    throw new Error('harness: options.model is required');
  }

  const startedAt = stamp();
  const id = `${startedAt.replace(/[:.]/g, '')}-${name}`;
  const dir = join(RUNS_ROOT, id);
  const captureDir = join(dir, 'claude');
  const configDir = join(CONFIG_DIRS_ROOT, id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const realBinary = resolveRealBinary();

  // TODO: undecided. Whether to strip the environment inherited from a
  // parent Claude Code session. When a proof runs from inside Claude Code,
  // CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID,
  // CLAUDE_CODE_MESSAGING_SOCKET/TOKEN, CLAUDE_EFFORT and others are in
  // process.env and reach the child unchanged (the SDK only sets
  // CLAUDE_CODE_ENTRYPOINT when it's absent). Passing them through is the
  // SDK's default and what's built; stripping them keeps the parent out of
  // the proof but is a filter the harness would be choosing.
  //
  // CLAUDE_CONFIG_DIR is always the run's own, even if options.env names one.
  const env: Record<string, string | undefined> = {
    ...(options.env ?? process.env),
    CLAUDE_CONFIG_DIR: configDir,
    HARNESS_CAPTURE_DIR: captureDir,
    HARNESS_REAL_CLAUDE: realBinary,
  };

  writeFileSync(
    join(dir, 'run.json'),
    jsonLine({
      id,
      startedAt,
      configDir,
      realBinary,
      wrapper: WRAPPER,
      sdkVersion: sdkVersion(),
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
    options: { ...options, env, pathToClaudeCodeExecutable: WRAPPER },
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
