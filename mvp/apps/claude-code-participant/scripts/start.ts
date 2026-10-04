// Starts the participant with its environment and configures it over stdin:
// the model, Claude Code's own system prompt, auto permission mode, and
// Claude Code's sandbox. Each control line and its reply are printed; if any
// reply is an error it says which, closes the participant's stdin (which
// starts its shutdown) and exits 1 once the participant has gone. Otherwise
// it forwards each line typed in its own terminal to the participant's stdin
// and prints the participant's reply, until the participant exits; it then
// exits with the participant's own exit code. When the terminal's input ends
// (Ctrl-D), it closes the participant's stdin, which starts its shutdown.
//
//   NATS_URL=nats://127.0.0.1:31416 [PARTICIPANT_WORLD=claude-code] [PARTICIPANT_DURABLE_BUCKET=durable] [PARTICIPANT_LOGIN_DIR=/abs/dir] \
//     node --env-file-if-exists=.env --import tsx scripts/start.ts
//
// Any of these can also come from an optional .env in the app directory;
// the environment wins over it. NATS_URL is required, with no default.
// PARTICIPANT_WORLD defaults to claude-code. PARTICIPANT_DURABLE_BUCKET
// defaults to durable, the bucket stream-init creates. The config dir is
// ${XDG_DATA_HOME:-$HOME/.local/share}/tower/worlds/<world> (a relative
// XDG_DATA_HOME counts as unset), created if it isn't there. On macOS the
// participant logs in from PARTICIPANT_LOGIN_DIR, by default
// ${XDG_DATA_HOME:-$HOME/.local/share}/tower/login, which login.ts fills;
// run it once first. Ctrl-C and
// SIGTERM are passed to the participant, one for one: the first starts its
// shutdown, a second moves it on a stage. The participant's stderr (its
// diagnostics, and Claude Code's) comes through as it is.

import { type ChildProcessByStdio, type SpawnOptions, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describeError } from '../src/describeError.js';

const CONTROL_LINES = [{ model: { name: 'claude-sonnet-5-5', maxTokens: 120000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'medium' } }, { system: { preset: true } }, { permissionMode: 'auto' }, { claudeSettings: { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } } }];

const natsUrl = process.env.NATS_URL;
if (natsUrl === undefined || natsUrl === '') {
  console.error('usage: NATS_URL=nats://host:port [PARTICIPANT_WORLD=claude-code] [PARTICIPANT_DURABLE_BUCKET=durable] start.ts');
  console.error('NATS_URL is required, with no default.');
  process.exit(2);
}
const world = process.env.PARTICIPANT_WORLD || 'claude-code';
const durableBucket = process.env.PARTICIPANT_DURABLE_BUCKET || 'durable';
const configDir = join(dataHome(process.env), 'tower', 'worlds', world);
mkdirSync(configDir, { recursive: true, mode: 0o700 });
// Where login.ts logs the participant in; read on macOS only.
const loginDir = process.env.PARTICIPANT_LOGIN_DIR || join(dataHome(process.env), 'tower', 'login');

console.log(`start: world ${world}, durable bucket ${durableBucket}, config dir ${configDir}, NATS ${natsUrl}`);

function dataHome(env: NodeJS.ProcessEnv): string {
  const xdgDataHome = env.XDG_DATA_HOME;
  return xdgDataHome !== undefined && isAbsolute(xdgDataHome) ? xdgDataHome : join(homedir(), '.local', 'share');
}

function spawnInOwnSession(command: string, args: string[], options: Omit<SpawnOptions, 'detached'>): ChildProcessByStdio<Writable, Readable, null> {
  return spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
}

function shellExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? 128 + (signal === null ? 0 : constants.signals[signal]);
}

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const participant = spawnInOwnSession(process.execPath, ['--import', 'tsx', main], {
  env: { ...process.env, NATS_URL: natsUrl, PARTICIPANT_WORLD: world, PARTICIPANT_DURABLE_BUCKET: durableBucket, PARTICIPANT_CONFIG_DIR: configDir, PARTICIPANT_LOGIN_DIR: loginDir },
});
// A failed write to the participant's stdin is logged; the exit code is still the participant's.
participant.stdin.on('error', (err) => {
  console.error(`start: writing to the participant's stdin failed: ${describeError(err)}`);
});
const exited = new Promise<number>((resolve) => {
  participant.once('exit', (code, signal) => resolve(shellExitCode(code, signal)));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`start: ${signal}, passed to the participant`);
    participant.kill(signal);
  });
}

// The participant answers every line with exactly one reply line, in order,
// so the next reply is the answer to the line just sent.
const replies = createInterface({ input: participant.stdout })[Symbol.asyncIterator]();

async function send(line: unknown): Promise<Record<string, unknown> | undefined> {
  const text = JSON.stringify(line);
  console.log(`start: sent  ${text}`);
  participant.stdin.write(`${text}\n`);
  const reply = await replies.next();
  if (reply.done) {
    return undefined;
  }
  console.log(`start: reply ${reply.value}`);
  return JSON.parse(reply.value) as Record<string, unknown>;
}

for (const line of CONTROL_LINES) {
  const reply = await send(line);
  if (reply === undefined) {
    console.error('start: the participant exited before it answered every control line');
    process.exit(await exited);
  }
  if ('error' in reply) {
    console.error(`start: the participant refused ${JSON.stringify(line)}: ${String(reply.error)}`);
    console.error('start: stopping the participant');
    participant.stdin.end();
    await exited;
    process.exit(1);
  }
}
console.log('start: every control line accepted; the participant publishes ready once it has connected and every required setting is set');

// Each line typed in this terminal goes to the participant's stdin as it is.
// The terminal stays in line mode so Ctrl-C still reaches the signal handlers above.
// When this terminal's input ends, the participant's stdin is closed, which starts its shutdown.
createInterface({ input: process.stdin, terminal: false })
  .on('line', (line) => {
    participant.stdin.write(`${line}\n`);
  })
  .on('close', () => {
    console.log("start: end of input, closing the participant's stdin");
    participant.stdin.end();
  });

// Anything more the participant writes on stdout, including the reply to each forwarded line, is printed, so its pipe never fills.
void (async () => {
  for (let next = await replies.next(); !next.done; next = await replies.next()) {
    console.log(`start: participant stdout ${next.value}`);
  }
})();

const code = await exited;
console.log(`start: the participant exited with ${code}`);
process.exit(code);
