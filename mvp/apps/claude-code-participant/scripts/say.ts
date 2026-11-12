// Says something into a conversation from the terminal, as a human would
// from tower: sends `say` with the text, and a precondition tip that is the
// one given or null (an empty conversation), then prints the reply.
// `{"accepted":true,"id":...}` means the participant has passed the text to
// Claude Code; the answer isn't printed here.
//
//   NATS_URL=nats://127.0.0.1:31416 \
//     node --env-file-if-exists=.env --import tsx scripts/say.ts <conversation id> <text> [<tip message id>]
//
// NATS_URL is required, with no default. A say against a conversation that
// already has messages needs its tip: the id of its last message.

import { connect, RequestError } from '@nats-io/transport-node';
import { describeError } from '../src/describeError.js';

const [conversationId, text, tip] = process.argv.slice(2);
const natsUrl = process.env.NATS_URL;
if (conversationId === undefined || text === undefined || natsUrl === undefined || natsUrl === '') {
  console.error('usage: NATS_URL=nats://host:port say.ts <conversation id> <text> [<tip message id>]');
  console.error('NATS_URL is required: an unset one would otherwise fall through to 4222, the live deployment.');
  process.exit(2);
}
const subject = `conv.v2.${conversationId}.requests.say`;

const nc = await connect({ servers: natsUrl });
try {
  const body = { ts: new Date().toISOString(), from: { kind: 'human' }, text, precondition: { tip: tip ?? null } };
  const reply = await nc.request(subject, JSON.stringify(body), { timeout: 30_000 });
  console.log(`${subject} ${JSON.stringify(reply.json<unknown>())}`);
} catch (err) {
  const meaning = err instanceof RequestError && err.isNoResponders() ? ' (nothing is serving the conversation)' : '';
  console.error(`${subject} failed: ${describeError(err)}${meaning}`);
  process.exitCode = 1;
} finally {
  await nc.close();
}
