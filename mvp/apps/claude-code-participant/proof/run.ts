// Resume-from-published proof, run inside `just broker-run` (NATS_URL is the
// test broker). For each shape in proof/plan.json:
//   live:   starts the participant, drives the shape over the bus, records every
//           message published on the conversation's subjects, shuts the
//           participant down and snapshots its config dir.
//   resume: (on a fresh broker) republishes the recorded changes, then for each
//           method restores the snapshot and resumes by proof/resume.ts, which
//           captures the request its probe sends.
// Then compares the requests (proof/compare.ts).

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { lastMessageId, readRecord } from '../src/ClaudeCodeRecord.js';
import { compareRun } from './compare.js';
import { CONTROL_LINES, type Json, type Plan, readLines, readPlan, type ShapeMeta, shapeOutDir, WORK } from './lib.js';
import { SHAPES, type Shape } from './shapes.js';

const natsUrl = process.env.NATS_URL;
if (natsUrl === undefined || natsUrl === '') {
  console.error('NATS_URL is required: run this through `just broker-run`.');
  process.exit(2);
}

const plan = readPlan();
const started = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${line}`);

async function until(what: string, test: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(100);
  }
}

function transcriptPath(configDir: string, id: string): string | undefined {
  const projects = join(configDir, 'projects');
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const file = join(projects, dir, `${id}.jsonl`);
    if (existsSync(file)) {
      return file;
    }
  }
  return undefined;
}

/** Runs one shape live. */
async function live(shape: Shape, nc: NatsConnection): Promise<void> {
  const out = shapeOutDir(plan.run, shape.name);
  const work = join(WORK, shape.name);
  const configDir = join(work, 'config');
  const cwd = join(work, 'cwd');
  const snapshot = join(work, 'snapshot');
  rmSync(out, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true });
  for (const [name, text] of Object.entries(shape.files ?? {})) {
    writeFileSync(join(cwd, name), text);
  }
  const id = randomUUID();
  const world = `proof-${shape.name}-${id.slice(0, 8)}`;
  const controlLines = [...CONTROL_LINES, ...(shape.control ?? [])];
  const meta: ShapeMeta = { shape: shape.name, id, world, cwd, configDir, snapshot, controlLines };
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 1)}\n`);

  // Every message on the conversation's subjects, in arrival order.
  const recorded: Json[] = [];
  const changeCount = () => recorded.filter((m) => String(m.subject).includes('.changes.')).length;
  let closed = 0;
  nc.subscribe(`conv.v2.${id}.>`, {
    callback: (_err, msg) => {
      const body = msg.json<Json>();
      recorded.push({ subject: msg.subject, body });
      if (msg.subject.endsWith('.changes.query.closed')) {
        closed += 1;
      }
    },
  });
  let ready = false;
  nc.subscribe(`agent.v1.${world}.telemetry.ready`, {
    callback: () => {
      ready = true;
    },
  });
  await nc.flush();

  const logFd = openSync(join(out, 'participant.log'), 'w');
  const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
  const participant: ChildProcess = spawn(process.execPath, ['--import', 'tsx', main], {
    stdio: ['pipe', 'pipe', logFd],
    env: {
      ...process.env,
      NATS_URL: natsUrl,
      PARTICIPANT_WORLD: world,
      PARTICIPANT_DURABLE_BUCKET: 'durable',
      PARTICIPANT_CONFIG_DIR: configDir,
      PROOF_PUBLISH_ENTRIES: '1',
      PROOF_SAY_WHILE_LIVE: '1',
      OTEL_LOG_RAW_API_BODIES: `file:${join(out, 'live-bodies')}`,
      TZ: 'UTC',
    },
  });
  const exited = new Promise<number | null>((resolve) => participant.once('exit', (code) => resolve(code)));
  const replies = createInterface({ input: participant.stdout as NodeJS.ReadableStream })[Symbol.asyncIterator]();
  for (const line of controlLines) {
    participant.stdin?.write(`${JSON.stringify(line)}\n`);
    const reply = await replies.next();
    if (reply.done || String(reply.value).includes('"error"')) {
      throw new Error(`control line refused: ${JSON.stringify(line)} -> ${String(reply.value)}`);
    }
  }
  await until('ready', () => ready, 90_000);

  const request = async (subject: string, body: Json): Promise<Json> => {
    const reply = await nc.request(subject, JSON.stringify({ ts: new Date().toISOString(), ...body }), { timeout: 60_000 });
    return reply.json<Json>();
  };
  const service = await request(`agent.v1.${world}.requests.service`, { conversationId: id, cwd });
  log(`${shape.name}: service ${JSON.stringify(service)}`);
  if (service.accepted !== true) {
    throw new Error(`service refused: ${JSON.stringify(service)}`);
  }

  const say = async (text: string): Promise<Json> => {
    const tip = (await readRecord(configDir, id))?.tip ?? null;
    const reply = await request(`conv.v2.${id}.requests.say`, { from: { kind: 'human' }, text, precondition: { tip } });
    log(`${shape.name}: say ${JSON.stringify(text.slice(0, 50))} -> ${JSON.stringify(reply)}`);
    if (reply.accepted !== true) {
      throw new Error(`say refused: ${JSON.stringify(reply)}`);
    }
    return reply;
  };
  /** Waits until nothing has been published for `idleMs`. */
  const quiet = async (idleMs: number): Promise<void> => {
    let count = recorded.length;
    let since = Date.now();
    while (Date.now() - since < idleMs) {
      await delay(500);
      if (recorded.length !== count) {
        count = recorded.length;
        since = Date.now();
      }
    }
  };

  for (const step of shape.steps) {
    const before = closed;
    await say(step.say);
    if ('midTurn' in step) {
      await delay(step.afterMs);
      await say(step.midTurn);
      await until('the first query to close', () => closed > before, 240_000);
      await quiet(20_000);
    } else if ('closed' in step) {
      await until(`${step.closed} queries to close`, () => closed >= before + step.closed, 240_000);
      await quiet(5_000);
    } else {
      await until('the query to close', () => closed > before, 240_000);
      await quiet(3_000);
    }
  }
  log(`${shape.name}: ${changeCount()} changes published, ${closed} queries closed`);

  // Shutdown: closing the participant's stdin starts it.
  participant.stdin?.end();
  const code = await Promise.race([exited, delay(60_000).then(() => 'timeout' as const)]);
  if (code === 'timeout') {
    participant.kill('SIGINT');
    await exited;
  }
  await delay(500);

  writeFileSync(join(out, 'changes.jsonl'), recorded.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const transcript = transcriptPath(configDir, id);
  if (transcript !== undefined) {
    writeFileSync(join(out, 'local-record.jsonl'), readFileSync(transcript));
    log(`${shape.name}: local record tip ${lastMessageId(readFileSync(transcript, 'utf8'))}`);
  }
  cpSync(configDir, snapshot, { recursive: true, preserveTimestamps: true });
  log(`${shape.name}: participant exited ${String(code)}, snapshot saved`);
}

/** Puts a shape's recorded changes back on the (fresh) broker, so a resume can read them. */
async function republish(shape: Shape, nc: NatsConnection): Promise<void> {
  const lines = readLines(join(shapeOutDir(plan.run, shape.name), 'changes.jsonl'));
  let n = 0;
  for (const line of lines) {
    if (String(line.subject).includes('.changes.')) {
      nc.publish(String(line.subject), JSON.stringify(line.body));
      n += 1;
    }
  }
  await nc.flush();
  await delay(500);
  log(`${shape.name}: republished ${n} changes`);
}

async function resume(shape: Shape, method: string): Promise<void> {
  const out = shapeOutDir(plan.run, shape.name);
  const dir = join(out, 'methods', method.replace(/[^A-Za-z0-9,@:_-]/g, '_').replace(/:/g, '-'));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const logFd = openSync(join(dir, 'log.txt'), 'w');
  const script = fileURLToPath(new URL('./resume.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, NATS_URL: natsUrl, PROOF_OUT: out, PROOF_METHOD: method, PROOF_METHOD_DIR: dir, TZ: 'UTC' },
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 240_000);
    child.once('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const result = existsSync(join(dir, 'result.json')) ? (JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Json) : {};
  log(`${shape.name}: resume ${method} exited ${String(code)} ${JSON.stringify(result).slice(0, 200)}`);
}

if (plan.phase === 'compare') {
  compareRun(plan);
  process.exit(0);
}

const nc = await connect({ servers: natsUrl });
try {
  const shapes = plan.shapes.map((name) => {
    const shape = SHAPES.find((s) => s.name === name);
    if (shape === undefined) {
      throw new Error(`unknown shape ${name}`);
    }
    return shape;
  });
  for (const shape of shapes) {
    try {
      if (plan.phase === 'live' || plan.phase === 'both') {
        await live(shape, nc);
      } else {
        await republish(shape, nc);
      }
      if (plan.phase !== 'live') {
        for (const method of plan.methods) {
          await resume(shape, method);
        }
      }
    } catch (err) {
      log(`${shape.name}: FAILED ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }
  await nc.drain();
} finally {
  const run: Plan = plan;
  compareRun(run);
}
