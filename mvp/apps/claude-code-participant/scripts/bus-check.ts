// A live check of the participant on the bus: it starts the participant as
// main.ts runs it, configures it over stdin, and drives it from a second NATS
// connection the way tower would. It shows, in order: ready and pulses; a
// service and its attached; a say accepted and its text in Claude Code's
// transcript; a second say refused while the first runs; a cancel that
// interrupts; a say against Claude Code's own tip; and the events shutdown
// publishes after SIGINT.
//
//   NATS_URL=nats://127.0.0.1:31416 PARTICIPANT_WORLD=... PARTICIPANT_DURABLE_BUCKET=... PARTICIPANT_CONFIG_DIR=... \
//     node --import tsx scripts/bus-check.ts <cwd>
//
// Everything it shows goes to stdout as one JSON object per line, stamped
// with the time since start; the participant's own diagnostics go to stderr.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { connect } from '@nats-io/transport-node';
import { lastMessageId } from '../src/ClaudeCodeRecord.js';

const [cwd] = process.argv.slice(2);
const { NATS_URL: natsUrl, PARTICIPANT_WORLD: world, PARTICIPANT_CONFIG_DIR: configDir } = process.env;
if (cwd === undefined || natsUrl === undefined || world === undefined || configDir === undefined) {
  console.error('usage: NATS_URL=... PARTICIPANT_WORLD=... PARTICIPANT_DURABLE_BUCKET=... PARTICIPANT_CONFIG_DIR=... bus-check.ts <cwd>');
  process.exit(2);
}

const started = Date.now();
const show = (what: string, value: unknown = {}) => console.log(JSON.stringify({ at: Date.now() - started, [what]: value }));

const CONTROL_LINES = [{ model: { name: 'claude-sonnet-5', maxTokens: 8000, thinking: 'disabled', thinkingDisplay: 'omitted', effort: 'low' } }, { system: { preset: true } }, { permissionMode: 'default' }];

const conversationId = randomUUID();
const events: { subject: string; body: unknown }[] = [];
const nc = await connect({ servers: natsUrl });
// One subscription, so the events arrive in the order they were published.
nc.subscribe('>', {
  callback: (_err, msg) => {
    if (msg.subject.startsWith(`agent.v1.${world}.telemetry.`) || msg.subject.startsWith(`conv.v2.${conversationId}.attachment.`)) {
      const body = msg.json<unknown>();
      events.push({ subject: msg.subject, body });
      show('event', { subject: msg.subject, body });
    }
  },
});
await nc.flush();

async function request(subject: string, body: Record<string, unknown>): Promise<unknown> {
  const reply = await nc.request(subject, JSON.stringify({ ts: new Date().toISOString(), ...body }), { timeout: 30_000 });
  const answer = reply.json<unknown>();
  show('request', { subject: subject.split('.').slice(-1)[0], body, reply: answer });
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

function transcript(): Record<string, unknown>[] {
  const projects = join(configDir as string, 'projects');
  if (!existsSync(projects)) {
    return [];
  }
  for (const dir of readdirSync(projects)) {
    const file = join(projects, dir, `${conversationId}.jsonl`);
    if (existsSync(file)) {
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    }
  }
  return [];
}

function transcriptText(): string {
  const projects = join(configDir as string, 'projects');
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const file = join(projects, dir, `${conversationId}.jsonl`);
    if (existsSync(file)) {
      return readFileSync(file, 'utf8');
    }
  }
  return '';
}

/** Each user entry's text, as Claude Code recorded it. */
function userTexts(): string[] {
  return transcript()
    .filter((entry) => entry.type === 'user')
    .map((entry) => {
      const content = (entry.message as { content: unknown }).content;
      return typeof content === 'string' ? content : (content as { type: string; text?: string }[]).map((block) => block.text ?? `[${block.type}]`).join(' ');
    });
}

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const participant = spawn(process.execPath, ['--import', 'tsx', main], { stdio: ['pipe', 'pipe', 'inherit'] });
const exited = new Promise<number | null>((resolve) => participant.once('exit', (code) => resolve(code)));
const replies = createInterface({ input: participant.stdout });
replies.on('line', (line) => show('controlReply', JSON.parse(line)));
for (const line of CONTROL_LINES) {
  participant.stdin.write(`${JSON.stringify(line)}\n`);
}

const count = (leaf: string) => events.filter((event) => event.subject === `agent.v1.${world}.telemetry.${leaf}`).length;

// ready, then pulses 30 s apart.
await until('ready', () => count('ready') === 1, 60_000);
await until('a second pulse', () => count('pulse') >= 2, 45_000);

// service, then attached.
await request(`agent.v1.${world}.requests.service`, { conversationId, cwd });
await until('attached', () => events.some((event) => event.subject.endsWith('.attachment.attached')), 5_000);

// A say accepted; a second one while it runs, refused.
const first = (await request(`conv.v2.${conversationId}.requests.say`, {
  from: { kind: 'human' },
  text: 'Write a 1500-word essay about the history of lighthouses. Do not use any tools.',
  precondition: { tip: null },
})) as { id?: string };
await request(`conv.v2.${conversationId}.requests.say`, { from: { kind: 'human' }, text: 'And another thing.', precondition: { tip: null } });
await until('the say in the transcript', () => userTexts().some((text) => text.includes('lighthouses')), 30_000);
show('transcriptUserTexts', userTexts());

// A cancel that interrupts: the query then ends, and a second cancel says so.
await delay(5000);
await request(`conv.v2.${conversationId}.requests.cancel`, { id: first.id });
await until('the query to end', () => transcriptText().includes('[Request interrupted by user'), 30_000);
await delay(1000);
await request(`conv.v2.${conversationId}.requests.cancel`, { id: first.id });
show('transcriptAfterCancel', { userTexts: userTexts(), types: transcript().map((entry) => entry.type) });

// A say against Claude Code's own tip: a stale one refused, the right one accepted.
const tip = lastMessageId(transcriptText());
await request(`conv.v2.${conversationId}.requests.say`, { from: { kind: 'human' }, text: 'Stale premise.', precondition: { tip: null } });
const before = transcript().length;
await request(`conv.v2.${conversationId}.requests.say`, { from: { kind: 'human' }, text: 'Reply with the single word: done.', precondition: { tip } });
await until(
  'a reply to the last say',
  () =>
    transcript()
      .slice(before)
      .some((entry) => entry.type === 'assistant'),
  60_000,
);
await delay(2000);
show('transcriptUserTexts', userTexts());

// Shutdown: SIGINT, then the events it publishes, in order.
const mark = events.length;
participant.kill('SIGINT');
const code = await exited;
await delay(500);
show('shutdown', { exitCode: code, publishedInOrder: events.slice(mark).map((event) => event.subject) });
await nc.drain();
