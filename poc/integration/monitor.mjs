// Live tail of what a ptyspike-wrapped CLI transmits and receives on the wire.
// Same idea as claude-sdk-cli's demo-monitor.mjs, against the v2 tree.
//
//   NATS_URL=nats://localhost:4222 node monitor.mjs [conversationId]
//
// With a conversationId, narrows conv traffic to that conversation; agent
// telemetry is always shown whole. `->` is traffic the CLI transmits
// (changes, telemetry); `<-` is traffic it receives (requests.*).
import { connect } from 'nats';

const url = process.env.NATS_URL ?? 'nats://localhost:4222';
const conv = process.argv[2] ?? '*';

const nc = await connect({ servers: url });
const subjects = [`conv.v2.${conv}.>`, 'agent.v1.>'];
process.stdout.write(`monitoring ${subjects.join(' and ')} on ${url}\n`);

const decoder = new TextDecoder();
for (const subject of subjects) {
  const sub = nc.subscribe(subject);
  (async () => {
    for await (const m of sub) {
      const direction = m.subject.includes('.requests.') ? '<-' : '->';
      const reply = m.reply ? `  (reply: ${m.reply})` : '';
      process.stdout.write(`${direction} ${m.subject}${reply}  ${decoder.decode(m.data)}\n`);
    }
  })();
}
