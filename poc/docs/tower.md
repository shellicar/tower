# Brief: tower

Build the **tower** component of the POC described in `spec.md`. Read the spec first;
on any conflict, the spec wins. You are building exactly one component — three other
sessions are building the others against the same spec, and none of you share code.
Your only contract is the spec.

## What you build

A dashboard webapp in two parts:

**Backend (Rust, axum)** — serves the frontend on port 8091 and exposes a WebSocket.
A NATS client (default `nats://localhost:4222`) subscribed to `agent.announce` and
`agent.*.events`; every event is forwarded over the WebSocket tagged with its agent
id. Discovery per the spec: an `agent_ready` on the announce subject, OR any event
from an unknown agent id on the events wildcard, means a new agent exists.

**Frontend (TypeScript)** — a responsive dashboard of movable, resizable panels; one
panel per discovered agent, appearing when the agent is discovered. Each panel shows
the agent's live event feed and the current conversation: user text from
`turn_started`, assistant text accumulating from `text_delta`s, errors visible.
Unknown event types are shown generically, not dropped on the floor. Use the
libraries you'd really use (a grid/panel library is fine); Vite for the build is
fine. Tower only watches — it sends nothing in this POC.

## Constraints

- Follow `standards.md` (in this directory).

- Backend Rust, frontend TypeScript, both idiomatic.
- Work entirely inside your current working directory.
- Install toolchains non-invasively if missing: rustup with `--no-modify-path`, node
  via a local install — never touch global config or shell rc files.
- **Parallel isolation**: other component sessions are running on this machine at the
  same time. Use your OWN NATS container on your OWN port —
  `docker run -d --name poc-nats-tower -p 4225:4222 nats:latest` — and pass
  `nats://localhost:4225` to the backend and your stub agents. Port 8091 for the web
  server is yours as specified. Do not touch containers or ports you did not create.

## Proving it

The agents don't exist in your session. Write a throwaway stub — a script that plays
two agents per the spec: each announces, then loops emitting
`turn_started` / spaced `text_delta`s / `turn_ended` on its own events subject.
Harness code is scratch, clearly separated; the deliverable is tower alone.

Prove it in two parts:

1. **Backend wire**: with the stub running, a WebSocket client (a script is fine)
   connected to the backend receives both agents' events, tagged with their ids.
2. **Frontend**: exercise it headlessly if you can (e.g. a headless browser check
   that two panels appear and text accumulates); if not, verify the frontend's
   event-folding logic with unit tests and state clearly what was and wasn't
   verified end to end.

## Harness rules

- Do not leave background or long-lived processes running via Exec (the NATS
  container is the one exception; you may leave it up).
- Always pass an explicit timeout to every Exec call.
- Bake a hard 120-second self-termination into the backend binary as a backstop so
  nothing is left running.

## Done when

The backend builds and relays both stub agents' events over its WebSocket; the
frontend builds and shows one live panel per agent, movable and resizable — with
nothing but the NATS container left running.

## Desirable (only if the core is done)

- Staleness: if heartbeats arrive (spec desirable), mark an agent stale when they
  stop; otherwise mark stale after 30s of silence.
