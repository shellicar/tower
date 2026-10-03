// A check, against tower's own test broker, that everything the participant
// hands its outbox reaches the stream, once and in order, whatever happens to
// the network, the broker or the process on the way. It needs the broker up
// with its streams (`docker compose -f compose.test.yaml`), so it is run
// through the recipe that brings that up and takes it down:
//
//   just --justfile mvp/justfile --working-directory mvp broker-run 'apps/claude-code-participant/scripts/outbox-check.sh'
//
// Each case starts outbox-harness.ts (the real broker, outbox and disk store
// around one conversation) in a config dir of its own, does what the case
// names to the broker or the process, and compares what the stream holds for
// the conversation with what was handed over. The broker is stopped,
// paused, restarted and given a stream limit along the way, and is left as it
// was found.

import { strict as assert } from 'node:assert';
import { type ChildProcessByStdio, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { jetstreamManager } from '@nats-io/jetstream';
import { Objm } from '@nats-io/obj';
import { connect } from '@nats-io/transport-node';

const natsUrl = process.env.NATS_URL;
if (natsUrl !== 'nats://127.0.0.1:31416') {
  console.error('outbox-check: NATS_URL must be the test broker, nats://127.0.0.1:31416; run it through just broker-run');
  process.exit(2);
}

const STREAM = 'conv-approval';
const BUCKET = 'durable';
const MVP = fileURLToPath(new URL('../../..', import.meta.url));
const APP = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = fileURLToPath(new URL('./outbox-harness.ts', import.meta.url));
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const started = Date.now();
const say = (line: string) => console.log(`[+${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s] ${line}`);

function compose(...args: string[]): void {
  execFileSync('docker', ['compose', '-f', 'compose.test.yaml', ...args], { cwd: MVP, stdio: 'inherit' });
}

const connection = await connect({ servers: natsUrl, maxReconnectAttempts: -1 });
const manager = await jetstreamManager(connection);
const objects = await new Objm(connection).open(BUCKET);

type Stored = { subject: string; body: Record<string, unknown> };

/** What the stream holds for the conversation, in stream order. */
async function stored(conversationId: string): Promise<Stored[]> {
  const found: Stored[] = [];
  const { state } = await manager.streams.info(STREAM);
  const prefix = `conv.v2.${conversationId}.`;
  for (let seq = state.first_seq; seq <= state.last_seq; seq += 1) {
    const message = await manager.streams.getMessage(STREAM, { seq }).catch(() => null);
    if (message?.subject.startsWith(prefix)) {
      found.push({ subject: message.subject, body: message.json<Record<string, unknown>>() });
    }
  }
  return found;
}

/** Each stored message as a short label: a message's own name, or the leaf of its subject. */
function labels(messages: Stored[], names: Map<string, string>): string[] {
  return messages.map(({ subject, body }) => (subject.endsWith('.changes.message') ? (names.get(body.id as string) ?? `unknown:${String(body.id)}`) : subject.split('.').slice(-1)[0]) as string);
}

async function until<T>(what: string, timeoutMs: number, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (value !== undefined) {
        return value;
      }
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
    }
    await delay(500);
  }
}

type Harness = {
  send(command: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): Promise<void>;
  exited: Promise<number | null>;
  stderr: string[];
};

/** Starts a harness for the conversation and waits until it has resumed what is in its config dir. */
async function startHarness(configDir: string, conversationId: string, extraEnv: Record<string, string> = {}): Promise<Harness> {
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(process.execPath, ['--import', 'tsx', HARNESS], {
    cwd: APP,
    env: { ...process.env, NATS_URL: natsUrl, HARNESS_CONFIG_DIR: configDir, HARNESS_CONVERSATION_ID: conversationId, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: string[] = [];
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderr.push(line);
    console.error(`    harness: ${line}`);
  });
  const answers: Record<string, unknown>[] = [];
  let waiting: ((answer: Record<string, unknown>) => void) | undefined;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const answer = JSON.parse(line) as Record<string, unknown>;
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      resolve(answer);
    } else {
      answers.push(answer);
    }
  });
  const next = () =>
    new Promise<Record<string, unknown>>((resolve) => {
      const early = answers.shift();
      if (early !== undefined) {
        resolve(early);
      } else {
        waiting = resolve;
      }
    });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const harness: Harness = {
    send: (command) => {
      child.stdin.write(`${JSON.stringify(command)}\n`);
      return next();
    },
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
    exited,
    stderr,
  };
  assert.deepEqual(await next(), { ready: true });
  return harness;
}

/** Assistant entries as Claude Code writes them, named for the labels. */
class Entries {
  public readonly names = new Map<string, string>();

  public text(name: string, text = name): Record<string, unknown> {
    const uuid = randomUUID();
    this.names.set(uuid, name);
    return { type: 'assistant', uuid, message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text }] } };
  }

  public image(name: string): Record<string, unknown> {
    const uuid = randomUUID();
    this.names.set(uuid, name);
    return { type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: ONE_PIXEL_PNG } }] }] } };
  }
}

function emptyOutbox(configDir: string, conversationId: string): string[] {
  try {
    return readdirSync(join(configDir, 'outbox', conversationId));
  } catch {
    return [];
  }
}

async function append(harness: Harness, ...entries: Record<string, unknown>[]): Promise<number> {
  const before = Date.now();
  await harness.send({ append: entries });
  return Date.now() - before;
}

type Case = { name: string; run: () => Promise<void> };
const cases: Case[] = [];
const run = (name: string, body: () => Promise<void>) => cases.push({ name, run: body });

function scratch(): { configDir: string; conversationId: string; entries: Entries } {
  return { configDir: mkdtempSync(join(tmpdir(), 'outbox-check-')), conversationId: randomUUID(), entries: new Entries() };
}

async function expectStream(conversationId: string, entries: Entries, expected: string[], timeoutMs: number): Promise<void> {
  await until(`the stream to hold ${expected.join(', ')}`, timeoutMs, async () => {
    const held = labels(await stored(conversationId), entries.names);
    return held.length >= expected.length ? held : undefined;
  });
  // Longer than the stream's duplicate window is not needed: anything sent twice arrives within seconds.
  await delay(3000);
  assert.deepEqual(labels(await stored(conversationId), entries.names), expected);
}

run('a drop of a few seconds', async () => {
  const { configDir, conversationId, entries } = scratch();
  const harness = await startHarness(configDir, conversationId);
  await append(harness, entries.text('a1'), entries.text('a2'));
  await expectStream(conversationId, entries, ['a1', 'a2'], 30_000);
  compose('stop', 'nats');
  const took = await append(harness, entries.text('b1'), entries.text('b2'), entries.text('b3'));
  assert.ok(took < 2000, `append took ${took} ms with the broker down`);
  await delay(4000);
  compose('start', 'nats');
  await expectStream(conversationId, entries, ['a1', 'a2', 'b1', 'b2', 'b3'], 90_000);
  assert.deepEqual(emptyOutbox(configDir, conversationId), []);
  await harness.kill();
});

run('a drop longer than 30 seconds', async () => {
  const { configDir, conversationId, entries } = scratch();
  const harness = await startHarness(configDir, conversationId);
  await append(harness, entries.text('a1'));
  await expectStream(conversationId, entries, ['a1'], 30_000);
  compose('stop', 'nats');
  await append(harness, entries.text('b1'));
  await delay(20_000);
  await append(harness, entries.text('b2'));
  await delay(20_000);
  await append(harness, entries.text('b3'));
  compose('start', 'nats');
  await expectStream(conversationId, entries, ['a1', 'b1', 'b2', 'b3'], 90_000);
  assert.deepEqual(emptyOutbox(configDir, conversationId), []);
  await harness.kill();
});

run('a silent drop (the broker paused, its connections still open)', async () => {
  const { configDir, conversationId, entries } = scratch();
  const harness = await startHarness(configDir, conversationId);
  await append(harness, entries.text('a1'));
  await expectStream(conversationId, entries, ['a1'], 30_000);
  compose('pause', 'nats');
  try {
    await append(harness, entries.text('b1'), entries.text('b2'));
    await delay(25_000);
    await append(harness, entries.text('b3'));
  } finally {
    compose('unpause', 'nats');
  }
  await expectStream(conversationId, entries, ['a1', 'b1', 'b2', 'b3'], 90_000);
  assert.deepEqual(emptyOutbox(configDir, conversationId), []);
  await harness.kill();
});

run('a kill with entries not yet sent, then a restart', async () => {
  const { configDir, conversationId, entries } = scratch();
  const first = await startHarness(configDir, conversationId);
  compose('stop', 'nats');
  await append(first, entries.text('b1'), entries.text('b2'), entries.text('b3'));
  await first.kill();
  assert.equal(emptyOutbox(configDir, conversationId).length, 3, 'the three entries are on disk');
  compose('start', 'nats');
  const second = await startHarness(configDir, conversationId);
  await expectStream(conversationId, entries, ['b1', 'b2', 'b3'], 90_000);
  assert.deepEqual(emptyOutbox(configDir, conversationId), []);
  await second.kill();
});

run('a crash between the acknowledgement and the delete', async () => {
  const { configDir, conversationId, entries } = scratch();
  const first = await startHarness(configDir, conversationId, { CRASH_AFTER_ACK: '1' });
  // Written while the broker is down, so all three are on disk before the first is acknowledged and the process dies.
  compose('stop', 'nats');
  await append(first, entries.text('c1'), entries.text('c2'), entries.text('c3'));
  compose('start', 'nats');
  await first.exited;
  const afterCrash = await until('the stream to hold the first message', 60_000, async () => {
    const held = labels(await stored(conversationId), entries.names);
    return held.length > 0 ? held : undefined;
  });
  assert.deepEqual(afterCrash, ['c1'], 'the stream has the first message, which was acknowledged before the crash');
  const second = await startHarness(configDir, conversationId);
  await expectStream(conversationId, entries, ['c1', 'c2', 'c3'], 60_000);
  assert.deepEqual(emptyOutbox(configDir, conversationId), []);
  await second.kill();
});

run('an entry with an image while the broker is unreachable', async () => {
  const { configDir, conversationId, entries } = scratch();
  const first = await startHarness(configDir, conversationId);
  compose('stop', 'nats');
  const withImage = entries.image('pic');
  await append(first, entries.text('d1'), withImage, entries.text('d2'));
  await first.kill();
  compose('start', 'nats');
  const second = await startHarness(configDir, conversationId);
  await expectStream(conversationId, entries, ['d1', 'pic', 'd2'], 90_000);
  const message = (await stored(conversationId)).find(({ body }) => body.id === withImage.uuid);
  assert.ok(message !== undefined, 'the message with the image is in the stream');
  const content = message.body.content as { content: { source: Record<string, unknown> }[] }[];
  const source = content[0]?.content[0]?.source ?? {};
  assert.equal(source.type, 'object');
  const bytes = await objects.getBlob(source.id as string);
  assert.deepEqual(Buffer.from(bytes ?? []), Buffer.from(ONE_PIXEL_PNG, 'base64'));
  await second.kill();
});

run('a message the stream refuses, then the cause removed', async () => {
  const { configDir, conversationId, entries } = scratch();
  const info = await manager.streams.info(STREAM);
  const original = info.config.max_msg_size;
  const harness = await startHarness(configDir, conversationId);
  try {
    await manager.streams.update(STREAM, { ...info.config, max_msg_size: 4000 });
    await append(harness, entries.text('e1'), entries.text('e2', 'y'.repeat(6000)), entries.text('e3'));
    await delay(8000);
    assert.deepEqual(labels(await stored(conversationId), entries.names), ['e1'], 'only what the stream took');
    assert.ok(
      harness.stderr.some((line) => line.includes('is kept and tried again')),
      'the refusal is logged',
    );
  } finally {
    await manager.streams.update(STREAM, { ...info.config, max_msg_size: original });
  }
  await expectStream(conversationId, entries, ['e1', 'e2', 'e3'], 60_000);
  assert.deepEqual(emptyOutbox(configDir, conversationId), []);
  await harness.kill();
});

run('a message over 1 MB', async () => {
  const { configDir, conversationId, entries } = scratch();
  const harness = await startHarness(configDir, conversationId);
  await append(harness, entries.text('f1'), entries.text('huge', 'z'.repeat(1_100_000)), entries.text('f3'));
  await expectStream(conversationId, entries, ['f1', 'f3'], 60_000);
  assert.ok(
    harness.stderr.some((line) => line.includes('is dropped')),
    'the drop is logged',
  );
  assert.deepEqual(emptyOutbox(configDir, conversationId), []);
  await harness.kill();
});

run('detached published while earlier messages are still waiting', async () => {
  const { configDir, conversationId, entries } = scratch();
  const harness = await startHarness(configDir, conversationId);
  await harness.send({ attach: true });
  await expectStream(conversationId, entries, ['attached'], 30_000);
  compose('stop', 'nats');
  await append(harness, entries.text('g1'), entries.text('g2'));
  await harness.send({ detach: true });
  await delay(3000);
  compose('start', 'nats');
  await expectStream(conversationId, entries, ['attached', 'g1', 'g2', 'detached'], 90_000);
  await harness.kill();
});

let failed = 0;
try {
  for (const { name, run: body } of cases) {
    say(`case: ${name}`);
    try {
      await body();
      say(`PASS ${name}`);
    } catch (err) {
      failed += 1;
      say(`FAIL ${name}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      // A case that failed partway may have left the broker stopped or paused.
      for (const verb of ['unpause', 'start']) {
        try {
          compose(verb, 'nats');
        } catch {
          // already running
        }
      }
    }
  }
} finally {
  await connection.close();
}
say(failed === 0 ? `all ${cases.length} cases passed` : `${failed} of ${cases.length} cases failed`);
process.exit(failed === 0 ? 0 : 1);
