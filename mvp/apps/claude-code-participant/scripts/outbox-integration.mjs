// Integration test of the participant's outbox against tower's own test broker.
// Run it through the recipe that brings that broker up and down around it:
//
//   just --justfile mvp/justfile --working-directory mvp broker-run 'apps/claude-code-participant/scripts/outbox-integration.sh'
//
// Each scenario starts the participant's publish path as a child process (outbox-child.ts), hands it
// entries over stdin, interferes with the broker or the process, and asserts what the stream holds.
// The broker is stopped, started and paused with docker compose, so this only runs where that works.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';

const natsUrl = process.env.NATS_URL;
if (natsUrl === undefined || !natsUrl.includes(':31416')) {
  throw new Error('NATS_URL must be the test broker (port 31416); run this through the broker-run recipe');
}

const appDir = fileURLToPath(new URL('..', import.meta.url));
const mvpDir = join(appDir, '..', '..');
const STREAM = 'conv-approval';

function docker(...args) {
  execFileSync('docker', ['compose', '-f', 'compose.test.yaml', ...args], { cwd: mvpDir, stdio: 'ignore' });
}

async function until(what, check, timeoutMs = 90_000) {
  const started = Date.now();
  for (;;) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch {
      // the broker may be down or just back
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(250);
  }
}

const observer = await connect({ servers: natsUrl, maxReconnectAttempts: -1 });
after(async () => {
  await observer.drain();
});

/** The ids of the messages the stream holds for a conversation, in stream order, with the subject leaf. */
async function stored(conversationId) {
  const manager = await jetstreamManager(observer);
  const info = await manager.streams.info(STREAM);
  const prefix = `conv.v2.${conversationId}.changes.`;
  const found = [];
  for (let seq = info.state.first_seq; seq <= info.state.last_seq; seq += 1) {
    let message;
    try {
      message = await manager.streams.getMessage(STREAM, { seq });
    } catch {
      continue;
    }
    if (message.subject.startsWith(prefix)) {
      const body = message.json();
      found.push(body.id ?? `${body.queryId}.${message.subject.slice(prefix.length)}`);
    }
  }
  return found;
}

async function untilStored(conversationId, expected) {
  return until(`${JSON.stringify(expected)} in the stream`, async () => {
    const found = await stored(conversationId);
    return found.length >= expected.length ? found : false;
  }).then((found) => found);
}

function outboxRows(configDir, where) {
  const db = new DatabaseSync(join(configDir, 'tower-participant-outbox.db'));
  try {
    return db.prepare(`SELECT msg_id, refused FROM outbox ${where} ORDER BY seq`).all();
  } finally {
    db.close();
  }
}

/** The participant's publish path as a child process, with the lines it writes. */
function startChild({ conversationId, configDir, world, crashAfterAck = false }) {
  const env = {
    ...process.env,
    NATS_URL: natsUrl,
    PARTICIPANT_WORLD: world,
    PARTICIPANT_DURABLE_BUCKET: 'durable',
    PARTICIPANT_CONFIG_DIR: configDir,
    CONVERSATION_ID: conversationId,
    CRASH_AFTER_ACK: crashAfterAck ? '1' : '0',
  };
  const child = spawn('node', ['--import', 'tsx', 'scripts/outbox-child.ts'], { cwd: appDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiting = [];
  const stderr = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const parsed = JSON.parse(line);
    const index = waiting.findIndex((w) => w.key in parsed);
    if (index >= 0) {
      waiting.splice(index, 1)[0].resolve(parsed);
    } else {
      lines.push(parsed);
    }
  });
  createInterface({ input: child.stderr }).on('line', (line) => stderr.push(line));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const reply = (key) =>
    new Promise((resolve) => {
      const index = lines.findIndex((l) => key in l);
      if (index >= 0) {
        resolve(lines.splice(index, 1)[0]);
      } else {
        waiting.push({ key, resolve });
      }
    });
  return {
    child,
    stderr,
    exited,
    ready: () => reply('ready'),
    send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
    /** Appends entries and resolves with how long `append` took to return, in ms. */
    async append(...entries) {
      const started = Date.now();
      child.stdin.write(`${JSON.stringify({ append: entries })}\n`);
      await reply('appended');
      return Date.now() - started;
    },
    async close() {
      child.stdin.write(`${JSON.stringify({ close: true })}\n`);
      await reply('closed');
    },
    async quit() {
      child.stdin.write(`${JSON.stringify({ quit: true })}\n`);
      await reply('quit');
      child.stdin.end();
      return exited;
    },
    kill: () => child.kill('SIGKILL'),
  };
}

function scenario() {
  const conversationId = randomUUID();
  const configDir = mkdtempSync(join(tmpdir(), 'outbox-integration-'));
  chmodSync(configDir, 0o700);
  return { conversationId, configDir, world: `outbox-${conversationId.slice(0, 8)}` };
}

const entry = (uuid, text = uuid) => ({ uuid, text });

/** Whatever happens in a scenario, the broker is left running. */
function restoreBroker() {
  try {
    docker('unpause', 'nats');
  } catch {
    // not paused
  }
  docker('start', 'nats');
}

describe('the participant outbox against the test broker', { concurrency: false }, () => {
  it('delivers, in order, what was appended during a drop of a few seconds', async () => {
    const s = scenario();
    const participant = startChild(s);
    await participant.ready();
    try {
      await participant.append(entry('a1'));
      await untilStored(s.conversationId, ['a1']);
      docker('stop', 'nats');
      await participant.append(entry('a2'), entry('a3'));
      await delay(3000);
      await participant.append(entry('a4'));
      docker('start', 'nats');
      await participant.close();
      const found = await untilStored(s.conversationId, ['a1', 'a2', 'a3', 'a4', 'a4']);
      assert.deepEqual(found.slice(0, 4), ['a1', 'a2', 'a3', 'a4']);
      assert.equal(found.length, 5);
      assert.match(found[4], /\.query\.closed$/);
      assert.deepEqual(outboxRows(s.configDir, ''), []);
    } finally {
      restoreBroker();
      await participant.quit();
    }
  });

  it('returns from append before the broker has acknowledged, even while it is down', async () => {
    const s = scenario();
    const participant = startChild(s);
    await participant.ready();
    try {
      docker('stop', 'nats');
      const tookMs = await participant.append(entry('b1'));
      assert.ok(tookMs < 2000, `append took ${tookMs} ms`);
    } finally {
      restoreBroker();
      await untilStored(s.conversationId, ['b1']);
      await participant.quit();
    }
  });

  it('delivers, in order, what was appended during a drop longer than the client keeps trying', async () => {
    const s = scenario();
    const participant = startChild(s);
    await participant.ready();
    try {
      await participant.append(entry('c1'));
      await untilStored(s.conversationId, ['c1']);
      docker('stop', 'nats');
      await participant.append(entry('c2'));
      await delay(45_000);
      await participant.append(entry('c3'));
      docker('start', 'nats');
      const found = await untilStored(s.conversationId, ['c1', 'c2', 'c3']);
      assert.deepEqual(found, ['c1', 'c2', 'c3']);
      assert.deepEqual(outboxRows(s.configDir, 'WHERE refused IS NOT NULL'), []);
      // The connection the participant's subscriptions share is still serving.
      const reply = await observer.request(`agent.v1.${s.world}.requests.drain`, '{}', { timeout: 5000 });
      assert.deepEqual(reply.json(), { rejected: true, reason: 'unsupported' });
    } finally {
      restoreBroker();
      await participant.quit();
    }
  });

  it('delivers, in order, what a killed participant left unsent, after a restart', async () => {
    const s = scenario();
    const first = startChild(s);
    await first.ready();
    await first.append(entry('d1'));
    await untilStored(s.conversationId, ['d1']);
    docker('stop', 'nats');
    await first.append(entry('d2'), entry('d3'));
    await first.append(entry('d4'));
    first.kill();
    assert.equal((await first.exited).signal, 'SIGKILL');
    docker('start', 'nats');
    await until('the broker', async () => (await stored(s.conversationId)).length >= 1);
    assert.deepEqual(await stored(s.conversationId), ['d1']);
    const second = startChild(s);
    await second.ready();
    try {
      const found = await untilStored(s.conversationId, ['d1', 'd2', 'd3', 'd4']);
      assert.deepEqual(found, ['d1', 'd2', 'd3', 'd4']);
      assert.deepEqual(outboxRows(s.configDir, 'WHERE refused IS NOT NULL'), []);
    } finally {
      await second.quit();
    }
  });

  it('stores a message once when the participant dies between the acknowledgement and the delete', async () => {
    const s = scenario();
    const first = startChild({ ...s, crashAfterAck: true });
    await first.ready();
    first.send({ append: [entry('e1'), entry('e2')] });
    assert.equal((await first.exited).signal, 'SIGKILL');
    assert.deepEqual(await stored(s.conversationId), ['e1']);
    assert.deepEqual(
      outboxRows(s.configDir, '').map((row) => row.msg_id),
      ['e1', 'e2'],
    );
    const second = startChild(s);
    await second.ready();
    try {
      const found = await untilStored(s.conversationId, ['e1', 'e2']);
      await delay(2000);
      assert.deepEqual(await stored(s.conversationId), ['e1', 'e2']);
      assert.equal(found.length, 2);
    } finally {
      await second.quit();
    }
  });

  it('keeps a message the stream rejects, and delivers the ones after it', async () => {
    const s = scenario();
    const manager = await jetstreamManager(observer);
    const info = await manager.streams.info(STREAM);
    await manager.streams.update(STREAM, { ...info.config, max_msg_size: 2048 });
    const participant = startChild(s);
    await participant.ready();
    try {
      await participant.append(entry('f1'), entry('f2', 'x'.repeat(4000)), entry('f3'));
      const found = await untilStored(s.conversationId, ['f1', 'f3']);
      assert.deepEqual(found, ['f1', 'f3']);
      const refused = await until('the refused row', () => {
        const rows = outboxRows(s.configDir, 'WHERE refused IS NOT NULL');
        return rows.length > 0 ? rows : false;
      });
      assert.deepEqual(
        refused.map((row) => row.msg_id),
        ['f2'],
      );
    } finally {
      await manager.streams.update(STREAM, info.config);
      await participant.quit();
    }
  });

  it('drops a message over 1 MB, logs it, and delivers the ones after it', async () => {
    const s = scenario();
    const participant = startChild(s);
    await participant.ready();
    try {
      await participant.append(entry('g1'), entry('g2', 'x'.repeat(1_100_000)), entry('g3'));
      const found = await untilStored(s.conversationId, ['g1', 'g3']);
      assert.deepEqual(found, ['g1', 'g3']);
      assert.ok(participant.stderr.some((line) => line.includes('outbox: message g2') && line.includes('so it is dropped')));
      assert.deepEqual(outboxRows(s.configDir, ''), []);
    } finally {
      await participant.quit();
    }
  });

  it('delivers, once each and in order, what was appended while the broker was paused (a silent drop)', async () => {
    const s = scenario();
    const participant = startChild(s);
    await participant.ready();
    try {
      await participant.append(entry('h1'));
      await untilStored(s.conversationId, ['h1']);
      docker('pause', 'nats');
      await participant.append(entry('h2'), entry('h3'));
      await delay(12_000);
      docker('unpause', 'nats');
      const found = await untilStored(s.conversationId, ['h1', 'h2', 'h3']);
      await delay(2000);
      assert.deepEqual(await stored(s.conversationId), ['h1', 'h2', 'h3']);
      assert.equal(found.length, 3);
    } finally {
      restoreBroker();
      await participant.quit();
    }
  });

  it('exits on its own after a graceful quit, having published everything', async () => {
    const s = scenario();
    const participant = startChild(s);
    await participant.ready();
    await participant.append(entry('i1'), entry('i2'));
    const exit = await participant.quit();
    assert.equal(exit.code, 0);
    assert.deepEqual(await stored(s.conversationId), ['i1', 'i2']);
  });
});
