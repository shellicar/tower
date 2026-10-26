// One served conversation on the real broker, the real outbox and the disk
// store, without Claude Code: what outbox-check.ts starts, kills and
// restarts. It reads one JSON command per line on stdin and answers each with
// one JSON line on stdout once the command is done.
//
//   {"attach":true}                  publishes `attached`
//   {"append":[<entry>, ...]}        hands the entries to the session store, as the SDK does, and answers once it returns
//   {"detach":true}                  publishes `detached`
//   {"quit":true}                    delivers what the stream takes now, closes the connection and exits
//
// It resumes whatever an earlier run left in the config dir's outbox when it
// starts, then answers {"ready":true}. With CRASH_AFTER_ACK set, the process
// kills itself at the first removal from the outbox, which is after the stream
// has acknowledged the message and before the message is deleted.
//
//   NATS_URL=... HARNESS_CONFIG_DIR=... HARNESS_CONVERSATION_ID=... [CRASH_AFTER_ACK=1] \
//     node --import tsx scripts/outbox-harness.ts

import { createInterface } from 'node:readline';
import { dependsOn } from '@shellicar/core-di';
import { IBroker } from '../src/Broker.js';
import type { Conversation } from '../src/Conversation.js';
import { participantServices } from '../src/container.js';
import { IHost } from '../src/Host.js';
import { IIds } from '../src/Ids.js';
import { Outbox } from '../src/Outbox.js';
import { DiskOutboxStore, IOutboxStore, type OutboxRecord, type StoredRecord } from '../src/OutboxStore.js';
import { ParticipantConfig } from '../src/ParticipantConfig.js';
import { ServedConversation } from '../src/ServedConversation.js';
import { IPublisher, PublishingSessionStore } from '../src/SessionStore.js';
import { ITimer } from '../src/Timer.js';

const { NATS_URL: natsUrl, HARNESS_CONFIG_DIR: configDir, HARNESS_CONVERSATION_ID: conversationId } = process.env;
if (natsUrl === undefined || configDir === undefined || conversationId === undefined) {
  console.error('usage: NATS_URL=... HARNESS_CONFIG_DIR=... HARNESS_CONVERSATION_ID=... outbox-harness.ts');
  process.exit(2);
}

const WORLD = 'outbox-check';
const BUCKET = 'durable';

/** The disk store, killing the process when it is told to remove a message: the stream has acknowledged it by then. */
class CrashingStore implements IOutboxStore {
  @dependsOn(DiskOutboxStore) private readonly disk!: DiskOutboxStore;

  public conversations(): Promise<string[]> {
    return this.disk.conversations();
  }

  public load(id: string): Promise<StoredRecord[]> {
    return this.disk.load(id);
  }

  public write(id: string, seq: number, record: OutboxRecord, blobs: readonly Uint8Array[]): Promise<void> {
    return this.disk.write(id, seq, record, blobs);
  }

  public readBlob(id: string, seq: number, index: number): Promise<Uint8Array> {
    return this.disk.readBlob(id, seq, index);
  }

  public remove(): Promise<void> {
    process.kill(process.pid, 'SIGKILL');
    return new Promise(() => {});
  }
}

const config = new ParticipantConfig({ natsUrl, world: WORLD, durableBucket: BUCKET, configDir, realHome: configDir, loginDir: null, inheritedEnv: {} }, configDir, null, '/unused', null);
const services = participantServices(config, 'linux');
services.register(DiskOutboxStore).asSelf();
if (process.env.CRASH_AFTER_ACK !== undefined) {
  services.register(CrashingStore).as(IOutboxStore);
}
const provider = services.buildProvider();
const broker = provider.resolve(IBroker);
const outbox = provider.resolve(Outbox);

await broker.connect();
await outbox.resume();

const silent = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) };
const stub = { id: conversationId, messages: silent, observe: () => {}, send: () => {}, interrupt: () => Promise.resolve() } as unknown as Conversation;
const served = new ServedConversation(stub, {
  broker,
  outbox,
  timer: provider.resolve(ITimer),
  ids: provider.resolve(IIds),
  host: provider.resolve(IHost),
  publisher: provider.resolve(IPublisher),
  configDir,
  durableBucket: BUCKET,
  world: WORLD,
  instanceId: `harness-${process.pid}`,
  isUnavailable: () => false,
});
const store = provider.resolve(PublishingSessionStore);

const reply = (value: Record<string, unknown>) => console.log(JSON.stringify(value));
reply({ ready: true });

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const command = JSON.parse(line) as { attach?: true; append?: Parameters<PublishingSessionStore['append']>[1]; detach?: true; quit?: true };
  if (command.attach) {
    await served.attach('/work', 30);
    reply({ done: 'attach' });
  } else if (command.append !== undefined) {
    await store.append({ projectKey: '-work', sessionId: conversationId }, command.append);
    reply({ done: 'append', count: command.append.length });
  } else if (command.detach) {
    await served.detach();
    reply({ done: 'detach' });
  } else if (command.quit) {
    await outbox.flush();
    await broker.close();
    reply({ done: 'quit' });
    process.exit(0);
  }
}
