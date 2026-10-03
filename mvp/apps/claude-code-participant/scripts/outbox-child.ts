// The participant's publish path with Claude Code left out, for outbox-integration.mjs to start, drive
// over stdin and kill. It starts the participant's presence as main.ts does, routes one conversation's
// changes, and hands entries to the session store the way the SDK's `append` does.
//
// Environment: NATS_URL, PARTICIPANT_WORLD, PARTICIPANT_DURABLE_BUCKET, PARTICIPANT_CONFIG_DIR, HOME, PATH,
// CONVERSATION_ID; CRASH_AFTER_ACK=1 makes the process kill itself (SIGKILL) right after the stream
// acknowledges its first publish, before the outbox deletes the row.
//
// Each stdin line is one JSON command, each answered with one stdout line:
//   {"append":[{"uuid":"u1","text":"hello"}]}  -> {"appended":["u1"]}, once the session store's append has returned
//   {"close":true}                             -> {"closed":true}, once the query's closure is queued
//   {"quit":true}                              -> {"quit":true}, after the outbox has published what it can and the connection has drained

import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { IBroker } from '../src/Broker.js';
import { ConversationChanges } from '../src/ConversationChanges.js';
import { composeConfig } from '../src/composition.js';
import { participantServices } from '../src/container.js';
import { IHost } from '../src/Host.js';
import { IIds } from '../src/Ids.js';
import { Outbox } from '../src/Outbox.js';
import { Presence } from '../src/Presence.js';
import { ServingGate } from '../src/ServingGate.js';
import { IPublisher, PublishingSessionStore } from '../src/SessionStore.js';
import { ITimer } from '../src/Timer.js';

const conversationId = process.env.CONVERSATION_ID;
if (conversationId === undefined) {
  throw new Error('CONVERSATION_ID is required');
}

const provider = participantServices(composeConfig(process.env, tmpdir(), process.getuid?.(), process.platform), process.platform).buildProvider();

if (process.env.CRASH_AFTER_ACK === '1') {
  const broker = provider.resolve(IBroker);
  const publishAcked = broker.publishAcked.bind(broker);
  broker.publishAcked = async (subject, payload, msgId) => {
    await publishAcked(subject, payload, msgId);
    process.kill(process.pid, 'SIGKILL');
  };
}

provider.resolve(ServingGate).open();
await provider.resolve(Presence).start();

const changes = new ConversationChanges(conversationId, {
  broker: provider.resolve(IBroker),
  outbox: provider.resolve(Outbox),
  timer: provider.resolve(ITimer),
  ids: provider.resolve(IIds),
  host: provider.resolve(IHost),
  instanceId: 'outbox-child',
  durableBucket: process.env.PARTICIPANT_DURABLE_BUCKET ?? '',
  abort: () => {},
});
provider.resolve(IPublisher).route(conversationId, changes);
const store = provider.resolve(PublishingSessionStore);

const say = (line: unknown) => console.log(JSON.stringify(line));
say({ ready: true });

for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { append?: { uuid: string; text: string }[]; close?: boolean; quit?: boolean };
  if (command.append !== undefined) {
    const entries = command.append.map(({ uuid, text }) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } }));
    await store.append({ projectKey: '-outbox', sessionId: conversationId }, entries);
    say({ appended: command.append.map(({ uuid }) => uuid) });
  } else if (command.close === true) {
    await changes.close('completed');
    say({ closed: true });
  } else if (command.quit === true) {
    await provider.resolve(Presence).disconnect('drain');
    say({ quit: true });
    break;
  }
}
