// Publishes a sample conversation of extra messages through the participant's
// own publish path (ConversationChanges) to a broker, so tower can show them
// and the stream can be read back. The entries are the recorded and hand-written
// ones in test/entries.ts: a prompt with its reminders, thinking, a tool
// exchange and the turn-finished line; a cancelled query with its interrupt
// marker; an API error; "No response requested."; a subagent hand-back and
// the notice of a finished task, in a query Claude Code starts itself; and a
// compaction.
//
//   NATS_URL=nats://127.0.0.1:31416 node --import tsx scripts/publish-extras.ts [conversation id]
//
// Against the test broker, from the repository root:
//
//   just --justfile mvp/justfile --working-directory mvp broker-run 'apps/claude-code-participant/scripts/publish-extras.sh'
//
// It reads the conversation's messages back from the stream, prints one line
// per message, and exits 1 when the kinds are not the kinds expected or a
// message is not as docs/spec/conversation.md says (test/conversationSchema.ts).
// NATS_URL has no default, and the live deployment's port is refused.

import { randomUUID } from 'node:crypto';
import { connect } from '@nats-io/transport-node';
import type { IBroker } from '../src/Broker.js';
import { ConversationChanges } from '../src/ConversationChanges.js';
import type { RecordEntry } from '../src/ConversationEntries.js';
import type { IHost } from '../src/Host.js';
import type { IIds } from '../src/Ids.js';
import type { ITimer } from '../src/Timer.js';
import { messageProblems } from '../test/conversationSchema.js';
import { ANSWER, API_ERROR, COMPACT_BOUNDARY, COMPACT_SUMMARY, DATE_ATTACHMENT, INTERRUPT_MARKER, NO_RESPONSE, PARTIAL_REPLY, PROMPT, RECORDED_TOKENS_REMINDER, SECOND_PROMPT, SUBAGENT_REPORT, TASK_NOTICE, TASK_NOTICE_REPLY, THINKING, TOOL_USE, TURN_DURATION } from '../test/entries.js';

const natsUrl = process.env.NATS_URL;
if (natsUrl === undefined || natsUrl.endsWith(':4222')) {
  console.error('usage: NATS_URL=<a test broker, never the deployment on 4222> publish-extras.ts [conversation id]');
  process.exit(2);
}

const conversationId = process.argv[2] ?? randomUUID();
const messageSubject = `conv.v2.${conversationId}.changes.message`;
/** The stream that holds a conversation's changes (stream-init.sh, AUDIT_STREAM). */
const STREAM = 'conv-approval';
const HUMAN = { kind: 'human' };

const nc = await connect({ servers: natsUrl });

/** The conversation's messages as the stream holds them, oldest first, read through the JetStream API's direct get. */
async function storedMessages(): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  let seq = 1;
  for (;;) {
    const reply = (await nc.request(`$JS.API.STREAM.MSG.GET.${STREAM}`, JSON.stringify({ seq, next_by_subj: messageSubject }))).json<{ message?: { seq: number; data: string }; error?: { code: number; description: string } }>();
    if (reply.error?.code === 404) {
      return bodies;
    }
    if (reply.message === undefined) {
      throw new Error(`reading ${STREAM} failed: ${JSON.stringify(reply.error)}`);
    }
    bodies.push(JSON.parse(Buffer.from(reply.message.data, 'base64').toString('utf8')));
    seq = reply.message.seq + 1;
  }
}

const broker: IBroker = {
  connect: async () => {},
  publish: (subject, body) => nc.publish(subject, JSON.stringify(body)),
  subscribe: () => {
    throw new Error('publish-extras does not subscribe');
  },
  storeObject: () => Promise.reject(new Error('publish-extras stores no files')),
  drain: () => nc.drain(),
  close: () => nc.close(),
};

// A message's `ts` orders it within its conversation, so each one gets a later
// millisecond than the one before.
let lastMs = 0;
const timer: ITimer = {
  now: () => performance.now(),
  timestamp: () => {
    lastMs = Math.max(Date.now(), lastMs + 1);
    return new Date(lastMs).toISOString();
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  every: () => () => {},
};

const ids: IIds = { mint: () => randomUUID() };
const host: IHost = { deadline: () => () => {}, letEnd: () => {}, exit: process.exit, log: (line) => console.error(`publish-extras: ${line}`) };

const changes = new ConversationChanges(conversationId, { broker, timer, ids, host, instanceId: 'publish-extras', durableBucket: 'unused', abort: () => {} });

function prompt(uuid: string, text: string, timestamp: string): RecordEntry {
  return { isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, uuid, timestamp, promptSource: 'sdk', turnOrigin: 'sdk' };
}

const TOOL_RESULT: RecordEntry = {
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_018yQgWWFdcauitggzkBdjjb', type: 'tool_result', content: 'red.png: a 32x32 PNG, solid red' }] },
  uuid: 'fb53da29-2143-434a-a644-6067c7216c31',
  timestamp: '2026-09-30T18:45:20.694Z',
  sourceToolAssistantUUID: TOOL_USE.uuid,
};

// 1. A prompt with its reminders, a reply that thinks and reads, the answer and the turn-finished line.
await changes.openQuery(randomUUID(), HUMAN);
await changes.commit([PROMPT, DATE_ATTACHMENT, THINKING, TOOL_USE, TOOL_RESULT, RECORDED_TOKENS_REMINDER, ANSWER, TURN_DURATION]);
await changes.close('completed');

// 2. A reply cut short by a cancel, and the marker Claude Code writes for it.
await changes.openQuery(randomUUID(), HUMAN);
await changes.commit([SECOND_PROMPT, PARTIAL_REPLY, INTERRUPT_MARKER]);
await changes.close('cancelled');

// 3. A prompt the API failed to answer.
await changes.openQuery(randomUUID(), HUMAN);
await changes.commit([prompt('3f1b7a52-8c40-4d19-b6e3-0a9d2c5f7e61', 'Summarise the last answer.', '2026-10-03T14:31:10.000+10:00'), API_ERROR]);
await changes.close('aborted');

// 4. A prompt left unanswered after a restart.
await changes.openQuery(randomUUID(), HUMAN);
await changes.commit([prompt('8a2e6d14-5b97-4c03-a1f8-7d0c3e9b5a26', 'Carry on.', '2026-10-03T14:30:00.000+10:00'), NO_RESPONSE]);
await changes.close('completed');

// 5. A turn Claude Code starts itself: a subagent's hand-back, then the notice of a finished task.
await changes.commit([SUBAGENT_REPORT, TASK_NOTICE, TASK_NOTICE_REPLY]);
await changes.close('completed');

// 6. A compaction: the boundary, then the summary that replaces what came before.
await changes.commit([COMPACT_BOUNDARY, COMPACT_SUMMARY]);
await changes.close('completed');

await nc.flush();
await new Promise((resolve) => setTimeout(resolve, 500));

const messages = await storedMessages();
const problems = messages.flatMap((body) => messageProblems(body).map((problem) => `${String(body.id)} ${problem}`));
for (const body of messages) {
  const blocks = (body.content as { type: string; text?: string }[]).map((block) => (block.type === 'text' ? String(block.text).slice(0, 48).replaceAll('\n', ' ') : block.type)).join(' | ');
  const audience = body.audience === undefined ? 'both' : JSON.stringify(body.audience);
  console.log(`${String(body.role).padEnd(9)} ${String(body.kind ?? '-').padEnd(22)} audience=${audience.padEnd(31)} from=${JSON.stringify(body.from ?? null).padEnd(28)} ${blocks}`);
}

const EXPECTED = ['-', 'date', '-', '-', '-', 'total-tokens-reminder', '-', 'turn-finished', '-', '-', 'interrupted', '-', 'api-error', '-', 'no-response', 'subagent-report', 'task-finished', '-', '-', 'compaction'];
const kinds = messages.map((body) => String(body.kind ?? '-'));
console.log(`conversation ${conversationId}: ${messages.length} messages on ${STREAM}, ${problems.length} not as the spec says`);
for (const problem of problems) {
  console.error(`not as the spec says: ${problem}`);
}
await nc.drain();
if (JSON.stringify(kinds) !== JSON.stringify(EXPECTED)) {
  console.error(`expected kinds ${JSON.stringify(EXPECTED)}\nsaw ${JSON.stringify(kinds)}`);
  process.exit(1);
}
if (problems.length > 0) {
  process.exit(1);
}
