// Publishes a sample conversation holding every kind of extra message through
// ConversationChanges to a real broker, then reads back what the broker's
// audit stream holds for it and checks each message against what was meant
// and against the `changes.message` schema in docs/spec/conversation.md.
// The entries are the recorded and hand-written ones in test/entries.ts, with
// fresh uuids and timestamps near now so each run is a conversation of its own.
//
//   NATS_URL=nats://127.0.0.1:31416 node --import tsx scripts/extras-check.ts
//
// Run from the participant's own directory. NATS_URL has no default, so the
// script never lands on the live deployment. Under the repo's `just broker-run`
// the broker is torn down when the script ends; against a broker brought up by
// hand the conversation stays, and tower (pointed at the same broker) shows it.
// Everything it prints goes to stdout as one JSON object per line.

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from '@nats-io/transport-node';
import { IBroker } from '../src/Broker.js';
import { ConversationChanges } from '../src/ConversationChanges.js';
import type { RecordEntry } from '../src/ConversationEntries.js';
import { NodeHost } from '../src/Host.js';
import { RandomIds } from '../src/Ids.js';
import { RealTimer } from '../src/Timer.js';
import { ANSWER, API_ERROR, CALL_A, COMPACT_BOUNDARY, COMPACT_SUMMARY, DATE_ATTACHMENT, ENVIRONMENT_ATTACHMENT, HAND_BACK, INTERRUPT_MARKER, NO_RESPONSE_REQUESTED, PARALLEL_ANSWER, PARTIAL_REPLY, PROMPT, RESULT_A, SECOND_PROMPT, TASK_NOTICE, THINKING, TURN_FINISHED } from '../test/entries.js';

const { NATS_URL: natsUrl } = process.env;
if (natsUrl === undefined) {
  console.error('usage: NATS_URL=nats://127.0.0.1:31416 node --import tsx scripts/extras-check.ts');
  process.exit(2);
}

type SafeParse = { safeParse(value: unknown): { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } };

/**
 * The `changes.message` schema exactly as docs/spec/conversation.md states it:
 * the spec's zod block, written to a temporary module with its `zod` import
 * pointed at the participant's own zod, and imported.
 */
async function specMessageSchema(): Promise<SafeParse> {
  const spec = await readFile(new URL('../../../../docs/spec/conversation.md', import.meta.url), 'utf8');
  const block = spec.slice(spec.indexOf('## Message schemas')).match(/```ts\n([\s\S]*?)\n```/)?.[1];
  if (block === undefined) {
    throw new Error('no zod block under "Message schemas" in docs/spec/conversation.md');
  }
  const module = join(await mkdtemp(join(tmpdir(), 'extras-check-')), 'conversation-schemas.ts');
  await writeFile(module, block.replace("from 'zod'", `from '${import.meta.resolve('zod')}'`));
  const schemas = (await import(pathToFileURL(module).href)) as { conversationChange: { message: SafeParse } };
  return schemas.conversationChange.message;
}

const messageSchema = await specMessageSchema();

const AUDIT_STREAM = 'conv-approval';
const conversationId = randomUUID();
const prefix = `conv.v2.${conversationId}.changes.`;
const show = (what: string, value: unknown = {}) => console.log(JSON.stringify({ [what]: value }));

/** Publishes to NATS as the participant's own broker does; the object store is not used by this sample. */
class CheckBroker extends IBroker {
  public constructor(private readonly nc: Awaited<ReturnType<typeof connect>>) {
    super();
  }

  public async connect(): Promise<void> {}

  public publish(subject: string, body: Record<string, unknown>): void {
    this.nc.publish(subject, JSON.stringify(body));
  }

  public subscribe(): never {
    throw new Error('the check does not subscribe through the broker');
  }

  public storeObject(): never {
    throw new Error('the sample holds no files');
  }

  public async drain(): Promise<void> {
    await this.nc.drain();
  }

  public async close(): Promise<void> {
    await this.nc.close();
  }
}

const nc = await connect({ servers: natsUrl });
const received: { subject: string; body: Record<string, unknown> }[] = [];
nc.subscribe(`${prefix}>`, {
  callback: (_err, msg) => {
    received.push({ subject: msg.subject, body: msg.json<Record<string, unknown>>() });
  },
});
await nc.flush();

const timer = new RealTimer();
const changes = new ConversationChanges(conversationId, { broker: new CheckBroker(nc), timer, ids: new RandomIds(), host: new NodeHost(), instanceId: 'inst-extras-check', durableBucket: 'unused', abort: () => {} });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A copy of `entry` with a fresh uuid and `timestamp`. */
function fresh(entry: RecordEntry, over: Record<string, unknown> = {}): RecordEntry {
  return { ...entry, uuid: randomUUID(), ...(entry.timestamp === undefined ? {} : { timestamp: ago(0) }), ...over };
}

function text(entry: RecordEntry, content: string): RecordEntry {
  return { ...entry, message: { ...(entry.message as object), content: [{ type: 'text', text: content }] } };
}

// What each published entry should come out as, by label.
type Expectation = { role: string; audience?: { model: boolean; user: boolean }; from?: unknown; content?: unknown; has?: string[] };
const expectations = new Map<string, Expectation>();
const labels = new Map<string, string>();

async function publish(label: string, entry: RecordEntry, expected: Expectation): Promise<RecordEntry> {
  await timer.sleep(5);
  await changes.commit([entry]);
  labels.set(entry.uuid as string, label);
  expectations.set(label, expected);
  return entry;
}

// Query 1: a prompt with its reminders, a tool call, the answer, the turn-finished line.
await changes.openQuery(randomUUID(), { kind: 'human' });
await publish('prompt', fresh(PROMPT, { message: { role: 'user', content: [{ type: 'text', text: 'Read a.txt and tell me what it says.' }] } }), { role: 'user', from: { kind: 'human' } });
await publish('environment reminder', fresh(ENVIRONMENT_ATTACHMENT), { role: 'system', audience: { model: true, user: false }, has: ['at'] });
await publish('date reminder', fresh(DATE_ATTACHMENT), { role: 'system', audience: { model: true, user: false }, has: ['at'] });
await publish('thinking', fresh(THINKING), { role: 'assistant' });
const call = fresh(CALL_A);
await publish('tool call', call, { role: 'assistant' });
await publish('tool result', fresh(RESULT_A, { sourceToolAssistantUUID: call.uuid }), { role: 'user' });
await publish('answer', fresh(text(ANSWER, 'a.txt says: alpha.')), { role: 'assistant' });
await publish('turn finished', fresh(TURN_FINISHED, { durationMs: 7000 }), { role: 'system', audience: { model: false, user: true }, content: [{ type: 'text', text: 'Worked for 7s' }], has: ['at'] });
await changes.close('completed');

// Query 2: a say cancelled mid-reply, the marker, and the synthetic reply Claude Code adds.
await changes.openQuery(randomUUID(), { kind: 'human' });
await publish('second prompt', fresh(SECOND_PROMPT), { role: 'user', from: { kind: 'human' } });
await publish('partial reply', fresh(PARTIAL_REPLY), { role: 'assistant' });
await publish('interrupt marker', fresh(INTERRUPT_MARKER), { role: 'user', audience: { model: true, user: true }, has: ['userContent', 'at'] });
await publish('no response requested', fresh(NO_RESPONSE_REQUESTED), { role: 'assistant', audience: { model: true, user: false } });
await changes.close('cancelled');

// Query 3: started by Claude Code itself when a background agent finishes, then an API error.
await publish('subagent hand-back', fresh(HAND_BACK), { role: 'user', from: { kind: 'agent' }, audience: { model: true, user: true } });
await publish('task finished', fresh(TASK_NOTICE), { role: 'user', from: { kind: 'orchestrator' }, audience: { model: true, user: true }, has: ['userContent'] });
const kept = await publish('reply to the notice', fresh(text(PARALLEL_ANSWER, 'The background task finished; its output was fine.')), { role: 'assistant' });
await publish('turn finished yesterday', fresh(TURN_FINISHED, { timestamp: ago(26 * 60 * 60 * 1000), durationMs: 65000 }), { role: 'system', audience: { model: false, user: true }, content: [{ type: 'text', text: 'Worked for 1m 5s' }], has: ['at'] });
await publish('API error', fresh(API_ERROR), { role: 'system', audience: { model: false, user: true } });
await changes.close('completed');

// Compaction: the boundary, then the summary that replaces everything before except the reply kept.
await changes.openQuery(randomUUID(), { kind: 'human' });
const boundary = fresh(COMPACT_BOUNDARY, { compactMetadata: { ...(COMPACT_BOUNDARY.compactMetadata as object), preservedMessages: { uuids: [kept.uuid], allUuids: [kept.uuid] } } });
await publish('compaction boundary', boundary, { role: 'system', audience: { model: false, user: true } });
await publish('compaction summary', fresh(COMPACT_SUMMARY, { parentUuid: boundary.uuid }), { role: 'user', audience: { model: true, user: true }, has: ['scope'] });
await publish('prompt after compaction', fresh(PROMPT, { message: { role: 'user', content: [{ type: 'text', text: 'Carry on.' }] } }), { role: 'user' });
await changes.close('completed');

await nc.flush();
const deadline = Date.now() + 5000;
while (received.length < labels.size + 4 && Date.now() < deadline) {
  await timer.sleep(50);
}

const messages = received.filter((event) => event.subject === `${prefix}message`).map((event) => event.body);
const failures: string[] = [];
for (const body of messages) {
  const label = labels.get(body.id as string) ?? 'unlabelled';
  const expected = expectations.get(label);
  const problems: string[] = [];
  const valid = messageSchema.safeParse(body);
  if (!valid.success) {
    problems.push(...(valid.error?.issues ?? []).map((issue) => `against the spec: ${issue.path.map(String).join('.')} ${issue.message}`));
  }
  if (expected === undefined) {
    problems.push('not expected');
  } else {
    if (body.role !== expected.role) {
      problems.push(`role ${String(body.role)} not ${expected.role}`);
    }
    if (JSON.stringify(body.audience) !== JSON.stringify(expected.audience)) {
      problems.push(`audience ${JSON.stringify(body.audience)} not ${JSON.stringify(expected.audience)}`);
    }
    if (expected.from !== undefined && JSON.stringify(body.from) !== JSON.stringify(expected.from)) {
      problems.push(`from ${JSON.stringify(body.from)} not ${JSON.stringify(expected.from)}`);
    }
    if (expected.content !== undefined && JSON.stringify(body.content) !== JSON.stringify(expected.content)) {
      problems.push(`content ${JSON.stringify(body.content)} not ${JSON.stringify(expected.content)}`);
    }
    for (const field of expected.has ?? []) {
      if (body[field] === undefined) {
        problems.push(`no ${field}`);
      }
    }
  }
  failures.push(...problems.map((problem) => `${label}: ${problem}`));
  show('message', { label, role: body.role, from: body.from, audience: body.audience, at: body.at, scope: body.scope, userContent: body.userContent, content: body.content });
}
if (messages.length !== labels.size) {
  failures.push(`${messages.length} messages seen on the wire, ${labels.size} published`);
}

// The audit stream's own count for this conversation's subjects.
const info = await nc.request(`$JS.API.STREAM.INFO.${AUDIT_STREAM}`, JSON.stringify({ subjects_filter: `${prefix}>` }), { timeout: 5000 });
const stream = info.json<{ state?: { subjects?: Record<string, number> }; error?: { description: string } }>();
const inStream = stream.state?.subjects?.[`${prefix}message`] ?? 0;
show('stream', { name: AUDIT_STREAM, messageSubject: `${prefix}message`, count: inStream, error: stream.error?.description });
if (inStream !== labels.size) {
  failures.push(`the ${AUDIT_STREAM} stream holds ${inStream} messages for the conversation, ${labels.size} published`);
}

show('conversation', { id: conversationId, messages: messages.length, failures });
await nc.drain();
process.exit(failures.length === 0 ? 0 : 1);
