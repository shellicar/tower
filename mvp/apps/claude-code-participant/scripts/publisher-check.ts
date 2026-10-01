// A live check of what the participant publishes on a conversation's
// `changes`: it starts the participant as main.ts runs it, configures it over
// stdin, and drives it from a second NATS connection the way tower would.
// It shows, in order: a say whose reply thinks, reads an image and answers,
// each message published with its ids; the image stored in the durable
// bucket before the tool result that references it; the query closed
// `completed`; a say premised on the last message published, cancelled and
// closed `cancelled`; and a say premised on the tip after the cancel.
//
//   NATS_URL=nats://127.0.0.1:31416 PARTICIPANT_WORLD=... PARTICIPANT_DURABLE_BUCKET=... PARTICIPANT_CONFIG_DIR=... \
//     node --import tsx scripts/publisher-check.ts <cwd>
//
// <cwd> must hold red.png. Everything it shows goes to stdout as one JSON
// object per line, stamped with the time since start; the participant's own
// diagnostics go to stderr.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Objm } from '@nats-io/obj';
import { connect } from '@nats-io/transport-node';

const [cwd] = process.argv.slice(2);
const { NATS_URL: natsUrl, PARTICIPANT_WORLD: world, PARTICIPANT_DURABLE_BUCKET: bucket, PARTICIPANT_CONFIG_DIR: configDir } = process.env;
if (cwd === undefined || natsUrl === undefined || world === undefined || bucket === undefined || configDir === undefined) {
  console.error('usage: NATS_URL=... PARTICIPANT_WORLD=... PARTICIPANT_DURABLE_BUCKET=... PARTICIPANT_CONFIG_DIR=... publisher-check.ts <cwd>');
  process.exit(2);
}

const started = Date.now();
const show = (what: string, value: unknown = {}) => console.log(JSON.stringify({ at: Date.now() - started, [what]: value }));

const CONTROL_LINES = [{ model: { name: 'claude-sonnet-5', maxTokens: 8000, thinking: 'adaptive', thinkingDisplay: 'summarized', effort: 'high' } }, { system: { preset: true } }, { permissionMode: 'default' }];

const conversationId = randomUUID();
const changesPrefix = `conv.v2.${conversationId}.changes.`;
type Change = { subject: string; body: Record<string, unknown> };
const changes: Change[] = [];
const nc = await connect({ servers: natsUrl });

/** A content block cut down to what shows its shape: long text and bytes shortened. */
function brief(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.map(brief);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, key === 'signature' ? '…' : brief(field)]));
  }
  return value;
}

// One subscription, so the object store's writes and the changes arrive in
// the order the participant sent them.
nc.subscribe('>', {
  callback: (_err, msg) => {
    if (msg.subject.startsWith(`$O.${bucket}.M.`)) {
      show('durableObjectStored', { subject: msg.subject, meta: msg.json<unknown>() });
    } else if (msg.subject.startsWith(changesPrefix)) {
      const body = msg.json<Record<string, unknown>>();
      changes.push({ subject: msg.subject, body });
      show('change', { leaf: msg.subject.slice(changesPrefix.length), body: brief(body) });
    }
  },
});
await nc.flush();

async function request(subject: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const reply = await nc.request(subject, JSON.stringify({ ts: new Date().toISOString(), ...body }), { timeout: 30_000 });
  const answer = reply.json<Record<string, unknown>>();
  show('request', { leaf: subject.split('.').slice(-1)[0], body, reply: answer });
  return answer;
}

async function until(what: string, test: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(100);
  }
}

const messages = (queryId?: unknown) => changes.filter((change) => change.subject.endsWith('.changes.message') && (queryId === undefined || change.body.queryId === queryId)).map((change) => change.body);
const closure = (queryId: unknown) => changes.find((change) => change.subject.endsWith('.changes.query.closed') && change.body.queryId === queryId)?.body;
const lastPublished = () => messages().at(-1)?.id as string | undefined;

async function say(text: string, tip: string | null): Promise<string> {
  const reply = await request(`conv.v2.${conversationId}.requests.say`, { from: { kind: 'human' }, text, precondition: { tip } });
  if (reply.accepted !== true) {
    throw new Error(`say not accepted: ${JSON.stringify(reply)}`);
  }
  return reply.id as string;
}

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const participant = spawn(process.execPath, ['--import', 'tsx', main], { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = new Promise<number | null>((resolve) => participant.once('exit', (code) => resolve(code)));
createInterface({ input: participant.stdout }).on('line', (line) => show('controlReply', JSON.parse(line)));
for (const line of CONTROL_LINES) {
  participant.stdin.write(`${JSON.stringify(line)}\n`);
}

let ready = false;
nc.subscribe(`agent.v1.${world}.telemetry.ready`, {
  callback: () => {
    ready = true;
  },
});
await until('ready', () => ready, 60_000);
await request(`agent.v1.${world}.requests.service`, { conversationId, cwd });

// 1. A reply that thinks, reads an image and answers, closed completed.
const first = await say('Think about how to do this first. Then say in one sentence what you will do, use the Read tool to read ./red.png, and tell me its colour in one short sentence.', null);
await until('the first query to close', () => closure(first) !== undefined, 120_000);
show('firstQuery', {
  queryId: first,
  messages: messages(first).map((body) => ({ id: body.id, queryId: body.queryId, turnId: body.turnId, role: body.role, from: body.from, blocks: (body.content as { type: string }[]).map((block) => block.type) })),
  closure: closure(first),
});

// The image: read back from the durable bucket and compared with the file.
const toolResult = messages(first).find((body) => (body.content as { type: string }[]).some((block) => block.type === 'tool_result'));
if (toolResult === undefined) {
  throw new Error('no tool result was published');
}
const reference = (toolResult.content as { content: { source: Record<string, string | number> }[] }[])[0]?.content[0]?.source ?? {};
const store = await new Objm(nc).open(bucket);
const info = await store.info(reference.id as string);
const stored = await store.getBlob(reference.id as string);
show('durableObject', {
  reference,
  info: { name: info?.name, size: info?.size, metadata: info?.metadata, digest: info?.digest },
  sameBytesAsFile: stored !== null && Buffer.from(stored).equals(readFileSync(join(cwd, 'red.png'))),
});

// 2. A say premised on the last message published, cancelled mid-reply.
const second = await say('Write a 1500-word essay about the history of lighthouses. Do not use any tools.', lastPublished() ?? null);
await delay(6000);
await request(`conv.v2.${conversationId}.requests.cancel`, { id: second });
await until('the cancelled query to close', () => closure(second) !== undefined, 60_000);
show('cancelledQuery', { queryId: second, messages: messages(second).map((body) => ({ id: body.id, turnId: body.turnId, role: body.role, blocks: (body.content as { type: string }[]).map((block) => block.type) })), closure: closure(second) });

// 3. A say premised on the tip tower sees after the cancel.
const third = await say('Reply with the single word: done.', lastPublished() ?? null);
await until('the third query to close', () => closure(third) !== undefined, 120_000);
show('thirdQuery', { queryId: third, messages: messages(third).map((body) => ({ id: body.id, turnId: body.turnId, role: body.role, content: brief(body.content) })), closure: closure(third) });

participant.kill('SIGINT');
show('shutdown', { exitCode: await exited });
await nc.drain();
