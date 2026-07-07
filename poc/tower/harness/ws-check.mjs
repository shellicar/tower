// Throwaway harness: connects to the backend WebSocket and verifies that
// events from BOTH stub agents arrive, tagged with their agent ids.
//
// Usage: node ws-check.mjs [wsUrl] [seconds]
// Exits 0 with a summary if both agents were seen; 1 otherwise.

import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8091/ws";
const waitSeconds = Number(process.argv[3] ?? 15);

const seen = new Map(); // agentId -> { count, types: Set }

const ws = new WebSocket(url);
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  const entry = seen.get(msg.agentId) ?? { count: 0, types: new Set() };
  entry.count += 1;
  entry.types.add(msg.event?.type ?? "(untyped)");
  seen.set(msg.agentId, entry);
});
ws.on("error", (err) => {
  console.error("WS error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  ws.close();
  for (const [id, e] of seen) {
    console.log(`${id}: ${e.count} events, types: ${[...e.types].sort().join(", ")}`);
  }
  const ok = seen.size >= 2 && [...seen.values()].every((e) => e.types.has("text_delta"));
  console.log(ok ? "PASS: both agents relayed with ids and streaming deltas" : "FAIL");
  process.exit(ok ? 0 : 1);
}, waitSeconds * 1000);
