# Brief: agent

Build the **agent** component of the POC described in `spec.md`. Read the spec first;
on any conflict, the spec wins. You are building exactly one component — three other
sessions are building the others against the same spec, and none of you share code.
Your only contract is the spec.

## What you build

A headless Rust process:

- **Up**: a NATS bridge. Connect to NATS (default `nats://localhost:4222`), publish
  `agent_ready` on `agent.announce` and on `agent.{id}.events`, subscribe to
  `agent.{id}.messages`.
- **Down**: a real streaming HTTP client to the fake model (default
  `http://localhost:8090`): POST `/v1/messages` with the conversation, consume the
  SSE stream chunk by chunk.
- **Between**: the turn loop per the spec's **Turn semantics** — one turn at a time,
  reject input mid-turn with an `error` event, `turn_started` (carrying `text` and
  `from`) → one `text_delta` per SSE text chunk → `turn_ended`. In-memory
  conversation only.

CLI args per the spec's **agent** responsibilities: optional agent id (generate
`agent-xxxx` if absent), NATS URL, model URL.

The streaming HTTP client is the point of this component: real connection handling,
real incremental SSE parsing. Use the crates you'd really use (async-nats, reqwest or
hyper, tokio, serde) — but consume the SSE stream as it arrives; do not buffer the
whole response.

## Constraints

- Follow `standards.md` (in this directory).

- Rust, idiomatic.
- Work entirely inside your current working directory.
- Install the toolchain non-invasively if missing: rustup with `--no-modify-path`,
  never touch global config or shell rc files.
- **Parallel isolation**: other component sessions are running on this machine at the
  same time. Use your OWN NATS container on your OWN port —
  `docker run -d --name poc-nats-agent -p 4223:4222 nats:latest` — and pass
  `nats://localhost:4223` to everything you run. Your stub model server must bind
  port 8092, NOT 8090 (another session owns it). Do not touch containers or ports you
  did not create.

## Proving it

The other components don't exist in your session. For testing you may write throwaway
harness pieces — a stub SSE server matching the spec's fake-model contract, and a NATS
script that plays client (publish `user_input`, subscribe to the events subject).
Harness code is scratch, clearly separated; the deliverable is the agent alone.

Show one full turn end to end: `user_input` published on NATS → `turn_started`,
multiple `text_delta`s, `turn_ended` observed on the events subject. Also show a
mid-turn `user_input` being rejected with an `error` event, and a model failure
producing `error` + `turn_ended` with `stopReason: "error"`.

## Harness rules

- Do not leave background or long-lived processes running via Exec (the NATS
  container is the one exception; you may leave it up).
- Always pass an explicit timeout to every Exec call.
- Bake a hard 120-second self-termination into the agent binary as a backstop so
  nothing is left running.

## Done when

The agent builds, announces itself, and the three scenarios above are demonstrated
over real NATS with the SSE stream consumed incrementally — and nothing but the NATS
container is left running.

## Desirable (only if the core is done)

- History request/reply on `agent.{id}.history` per the spec.
- Heartbeat: republish `agent_ready` every 10s.
