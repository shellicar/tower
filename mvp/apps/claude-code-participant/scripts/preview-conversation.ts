// Publishes a finished Claude Code session into the preview environment as
// the participant would have published it: the session's record goes through
// the participant's own publishing path, under a new conversation id, which
// it prints. Each message carries its entry's original time as `ts`, and goes
// to the stream under an id scoped to the conversation, so each run of one
// session is stored as a conversation of its own.
//
//   NATS_URL=nats://127.0.0.1:31417 node --env-file-if-exists=.env --import tsx scripts/preview-conversation.ts <session id>
//
// NATS_URL is required, with no default, and anything but the preview broker
// (nats://127.0.0.1:31417) is refused before anything is read or sent. The
// transcript is found under ${CLAUDE_CONFIG_DIR:-~/.claude}/projects, and read
// through the Agent SDK's importSessionToStore, subagents' records included
// (the participant publishes none of them). Files go to the preview's
// `durable` bucket. It lists each place where the published messages' `ts`
// order and their publish order disagree. The
// outbox is a temporary directory, removed once everything in it is
// delivered; if anything is left, the script says where and exits 1.

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSessionToStore } from '@anthropic-ai/claude-agent-sdk';
import { IBroker, NatsBroker } from '../src/Broker.js';
import { ConversationChanges } from '../src/ConversationChanges.js';
import { participantServices } from '../src/container.js';
import { describeError } from '../src/describeError.js';
import { IHost } from '../src/Host.js';
import { IIds } from '../src/Ids.js';
import { Outbox } from '../src/Outbox.js';
import { IOutboxStore } from '../src/OutboxStore.js';
import { ParticipantConfig } from '../src/ParticipantConfig.js';
import { IPublisher } from '../src/SessionStore.js';
import { ITimer } from '../src/Timer.js';
import { deliveryId, EntryClock, orderDisagreements, type PublishedMessage, TranscriptReplay } from '../src/TranscriptReplay.js';

const PREVIEW_URL = 'nats://127.0.0.1:31417';
const DURABLE_BUCKET = 'durable';
const WORLD = 'preview';

const [sessionId] = process.argv.slice(2);
const natsUrl = process.env.NATS_URL;
if (sessionId === undefined) {
  console.error(`usage: NATS_URL=${PREVIEW_URL} preview-conversation.ts <session id>`);
  process.exit(2);
}
if (natsUrl !== PREVIEW_URL) {
  console.error(`NATS_URL must be the preview broker, ${PREVIEW_URL}; it is ${natsUrl === undefined ? 'unset' : natsUrl}. Nothing was published.`);
  process.exit(2);
}

/** Every transcript of the session under the projects directory: one file each project it is found in. */
async function transcriptsOf(id: string): Promise<string[]> {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const found: string[] = [];
  for (const project of await readdir(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) {
      continue;
    }
    const names = await readdir(join(projects, project.name));
    if (names.includes(`${id}.jsonl`)) {
      found.push(join(projects, project.name, `${id}.jsonl`));
    }
  }
  return found;
}

type Published = PublishedMessage & { role: unknown; blocks: string };

/**
 * The broker, sending each message under an id scoped to the conversation it
 * replays, and noting each message the stream has taken, in the order it took
 * them.
 */
class RecordingBroker extends NatsBroker {
  public readonly messages: Published[] = [];
  public conversationId: string | undefined;

  public override async publishToStream(subject: string, body: Record<string, unknown>, id: string): Promise<void> {
    if (this.conversationId === undefined) {
      throw new Error('no conversation is being replayed');
    }
    await super.publishToStream(subject, body, deliveryId(this.conversationId, id));
    if (subject.endsWith('.changes.message')) {
      const content = Array.isArray(body.content) ? (body.content as { type?: unknown }[]) : [];
      this.messages.push({ id: String(body.id), ts: String(body.ts), role: body.role, blocks: content.map((block) => String(block.type)).join(',') });
    }
  }
}

const transcripts = await transcriptsOf(sessionId);
if (transcripts.length !== 1) {
  // TODO(claude): undecided: what a session id found in more than one project directory means. Refused for now, naming each.
  console.error(transcripts.length === 0 ? `no transcript of session ${sessionId} was found` : `session ${sessionId} has more than one transcript: ${transcripts.join(', ')}`);
  process.exit(1);
}
console.log(`session ${sessionId}`);
console.log(`transcript ${transcripts[0]}`);

const outboxDir = await mkdtemp(join(tmpdir(), 'tower-preview-'));
const config = new ParticipantConfig({ natsUrl, world: WORLD, durableBucket: DURABLE_BUCKET, configDir: outboxDir, realHome: homedir(), loginDir: null, inheritedEnv: {} }, outboxDir, null, '/unused', null);
const services = participantServices(config, process.platform);
services.register(RecordingBroker).as(IBroker);
const provider = services.buildProvider();
const broker = provider.resolve(IBroker) as RecordingBroker;
const outbox = provider.resolve(Outbox);
const ids = provider.resolve(IIds);
const publisher = provider.resolve(IPublisher);

try {
  await broker.connect();
} catch (err) {
  console.error(`connecting to ${natsUrl} failed: ${describeError(err)}`);
  await rm(outboxDir, { recursive: true, force: true });
  process.exit(1);
}

const conversationId = ids.mint();
broker.conversationId = conversationId;
console.log(`conversation ${conversationId}`);

const clock = new EntryClock(provider.resolve(ITimer));
const changes = new ConversationChanges(conversationId, {
  lane: outbox.lane(conversationId),
  timer: clock,
  ids,
  host: provider.resolve(IHost),
  // TODO(claude): undecided: which instance a replayed conversation's messages name. A fresh id each run for now, with no `attached` or `detached` published for it.
  instanceId: ids.mint(),
  durableBucket: DURABLE_BUCKET,
  abort: () => {},
});
const unroute = publisher.route(sessionId, changes);

let failed = false;
try {
  await importSessionToStore(sessionId, new TranscriptReplay(publisher, changes, ids, clock));
} catch (err) {
  console.error(`reading session ${sessionId} failed: ${describeError(err)}`);
  failed = true;
}
unroute();
await outbox.flush();
const left = await provider.resolve(IOutboxStore).load(conversationId);
await broker.close();

console.log(`published ${broker.messages.length} messages`);
const places = orderDisagreements(broker.messages);
console.log(`${places.length} places where ts order and publish order disagree`);
for (const [index, place] of places.entries()) {
  console.log(`place ${index + 1}: after ${place.latest.id} (${place.latest.role} ${place.latest.blocks}) at ${place.latest.ts}, published later with an earlier ts:`);
  for (const message of place.earlier) {
    console.log(`  ${message.id} (${message.role} ${message.blocks}) at ${message.ts}`);
  }
}

if (left.length > 0) {
  console.error(`${left.length} messages were not delivered; they are kept in ${outboxDir}`);
  process.exit(1);
}
await rm(outboxDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
