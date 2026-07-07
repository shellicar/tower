# Brief: tower-wasm

Build the **tower** component of the POC described in `spec.md` — as an all-Rust
variant. Read the spec first; on any conflict, the spec wins (except where this brief
explicitly overrides: frontend technology and ports). You are building exactly one
component — other sessions are building the rest against the same spec, and none of
you share code. Your only contract is the spec.

Another session is building the same component with a TypeScript frontend; you are
the Rust/WASM counterpart. You never interact with it.

## What you build

A dashboard webapp in two parts, both Rust:

**Backend (axum)** — serves the frontend on **port 8093** (overrides the spec's 8091,
which the other tower owns) and exposes a WebSocket. A NATS client subscribed to
`agent.announce` and `agent.*.events`; every event is forwarded over the WebSocket
tagged with its agent id. Discovery per the spec: an `agent_ready` on the announce
subject, OR any event from an unknown agent id on the events wildcard, means a new
agent exists.

**Frontend (egui via eframe, compiled to WASM)** — a dashboard of movable, resizable
panels: one egui `Window` per discovered agent, appearing when the agent is
discovered. Each panel shows the agent's live event feed and the current
conversation: user text from `turn_started`, assistant text accumulating from
`text_delta`s, errors visible. Unknown event types are shown generically, not dropped
on the floor. The frontend connects to the backend's WebSocket. Trunk (or the
equivalent you'd really use) for the WASM build. Tower only watches — it sends
nothing in this POC.

Share the protocol types between backend and frontend as a common crate in one cargo
workspace — that sharing is a genuine advantage of the all-Rust shape; use it.

## Constraints

- Follow `standards.md` (in this directory).

- Rust throughout, idiomatic.
- Work entirely inside your current working directory.
- Install toolchains non-invasively if missing: rustup with `--no-modify-path`
  (plus the `wasm32-unknown-unknown` target and trunk via cargo) — never touch
  global config or shell rc files.
- **Parallel isolation**: other component sessions are running on this machine at the
  same time. Use your OWN NATS container on your OWN port —
  `docker run -d --name poc-nats-tower-wasm -p 4226:4222 nats:latest` — and pass
  `nats://localhost:4226` to the backend and your stub agents. Web port 8093 is
  yours. Do not touch containers or ports you did not create (8090, 8091, 8092 and
  NATS ports 4222–4225 belong to others).

## Proving it

The agents don't exist in your session. Write a throwaway stub — a script that plays
two agents per the spec: each announces, then loops emitting
`turn_started` / spaced `text_delta`s / `turn_ended` on its own events subject.
Harness code is scratch, clearly separated; the deliverable is tower-wasm alone.

Prove it in two parts:

1. **Backend wire**: with the stub running, a WebSocket client (a script is fine)
   connected to the backend receives both agents' events, tagged with their ids.
2. **Frontend**: the WASM build compiles and serves; the event-folding logic
   (events in → per-agent conversation state) lives in the shared crate or a pure
   module and is unit-tested natively. If you can exercise the served page headlessly,
   do; otherwise state clearly what was and wasn't verified end to end.

## Harness rules

- Do not leave background or long-lived processes running via Exec (the NATS
  container is the one exception; you may leave it up).
- Always pass an explicit timeout to every Exec call.
- Bake a hard 120-second self-termination into the backend binary as a backstop so
  nothing is left running.

## Done when

The backend builds and relays both stub agents' events over its WebSocket; the WASM
frontend builds and serves on 8093 with one movable, resizable panel per agent; the
event-folding tests pass — with nothing but the NATS container left running.

## Desirable (only if the core is done)

- Staleness: if heartbeats arrive (spec desirable), mark an agent stale when they
  stop; otherwise mark stale after 30s of silence.
