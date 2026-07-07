// Throwaway harness: plays two agents per the spec so tower has something to
// watch. Not part of the deliverable. Self-terminates.
//
// Usage: node stub-agents.mjs [natsUrl] [seconds]

import { connect } from "nats";

const natsUrl = process.argv[2] ?? "nats://localhost:4225";
const runSeconds = Number(process.argv[3] ?? 30);

const nc = await connect({ servers: natsUrl });
const enc = (obj) => JSON.stringify(obj);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playAgent(id, phrase) {
  const events = `agent.${id}.events`;
  const ready = enc({ type: "agent_ready", agentId: id });
  nc.publish("agent.announce", ready);
  nc.publish(events, ready);

  let turn = 0;
  for (;;) {
    turn += 1;
    const turnId = `t-${turn}`;
    nc.publish(
      events,
      enc({ type: "turn_started", turnId, text: `Question ${turn} for ${id}?`, from: { kind: "human" } }),
    );
    for (const word of `${phrase} (turn ${turn})`.split(" ")) {
      await sleep(120);
      nc.publish(events, enc({ type: "text_delta", turnId, text: `${word} ` }));
    }
    nc.publish(events, enc({ type: "turn_ended", turnId, stopReason: "end_turn" }));
    // One rejected-input error and one unknown event type, so those paths show.
    if (turn === 1) {
      nc.publish(events, enc({ type: "error", message: "turn already in progress" }));
      nc.publish(events, enc({ type: "mystery_event", detail: "unknown type, should render generically" }));
    }
    await sleep(1500);
  }
}

playAgent("agent-alpha", "The quick brown fox answers your question with confidence");
playAgent("agent-beta", "Streaming replies arrive word by word from beta");

await sleep(runSeconds * 1000);
await nc.drain();
process.exit(0);
