// Starts a new conversation in a world: sends `service` for a fresh
// conversation id and the given working directory, then prints the id and
// the reply. `{"accepted":true}` means the participant has launched Claude
// Code for it and published `attached`.
//
//   NATS_URL=nats://127.0.0.1:31416 [PARTICIPANT_WORLD=claude-code] \
//     node --import tsx scripts/new-conversation.ts <absolute cwd>
//
// NATS_URL is required, with no default. PARTICIPANT_WORLD defaults to
// claude-code. The cwd is sent as given; the participant rejects one that
// isn't an absolute path to a directory (reason invalid_cwd).

import { randomUUID } from 'node:crypto';
import { connect, RequestError } from '@nats-io/transport-node';
import { describeError } from '../src/describeError.js';

const LAUNCH_TIMEOUT_MS = 30_000;

const [cwd] = process.argv.slice(2);
const natsUrl = process.env.NATS_URL;
if (cwd === undefined || natsUrl === undefined || natsUrl === '') {
  console.error('usage: NATS_URL=nats://host:port [PARTICIPANT_WORLD=claude-code] new-conversation.ts <absolute cwd>');
  console.error('NATS_URL is required: an unset one would otherwise fall through to 4222, the live deployment.');
  process.exit(2);
}
const world = process.env.PARTICIPANT_WORLD || 'claude-code';
const subject = `agent.v1.${world}.requests.service`;

const conversationId = randomUUID();
console.log(`conversation ${conversationId}`);

const nc = await connect({ servers: natsUrl });
try {
  const reply = await nc.request(subject, JSON.stringify({ ts: new Date().toISOString(), conversationId, cwd }), { timeout: LAUNCH_TIMEOUT_MS });
  console.log(`${subject} ${JSON.stringify(reply.json<unknown>())}`);
} catch (err) {
  const meaning = err instanceof RequestError && err.isNoResponders() ? ` (no participant is serving world ${world})` : '';
  console.error(`${subject} failed: ${describeError(err)}${meaning}`);
  process.exitCode = 1;
} finally {
  await nc.close();
}
