// Integration driver: watches all agent events on the shared broker, then runs
// one turn against each real agent and prints everything seen.
import { connect, StringCodec } from "nats";

const sc = StringCodec();
const nc = await connect({ servers: "nats://localhost:4222" });

const seen = [];
(async () => {
  const sub = nc.subscribe("agent.*.events");
  for await (const m of sub) {
    const id = m.subject.split(".")[1];
    seen.push([id, JSON.parse(sc.decode(m.data))]);
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(id, text) {
  nc.publish(
    `agent.${id}.messages`,
    sc.encode(JSON.stringify({ type: "user_input", from: { kind: "human" }, text })),
  );
}

await sleep(1000); // let agents announce
await turn("alpha", "Hello from integration, agent alpha!");
await sleep(4000);
await turn("beta", "And hello agent beta.");
await sleep(4000);

for (const [id, ev] of seen) {
  const extra =
    ev.type === "text_delta" ? JSON.stringify(ev.text)
    : ev.type === "turn_ended" ? ev.stopReason
    : ev.type === "turn_started" ? JSON.stringify(ev.text)
    : ev.message ?? "";
  console.log(`${id}  ${ev.type}  ${extra}`);
}

const types = new Set(seen.map(([, e]) => e.type));
const ids = new Set(seen.map(([id]) => id));
const ok =
  ids.has("alpha") && ids.has("beta") &&
  ["agent_ready", "turn_started", "text_delta", "turn_ended"].every((t) => types.has(t));
console.log(ok ? "INTEGRATION OK" : "INTEGRATION INCOMPLETE");
await nc.close();
process.exit(ok ? 0 : 1);
