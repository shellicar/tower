# Brief: tui

Build the **tui** component of the POC described in `spec.md`. Read the spec first;
on any conflict, the spec wins. You are building exactly one component — three other
sessions are building the others against the same spec, and none of you share code.
Your only contract is the spec.

## What you build

A Rust terminal client. CLI arg: the agent id to attach to (NATS URL optional,
default `nats://localhost:4222`).

- Subscribe to `agent.{id}.events`; publish `user_input` (with
  `from: { kind: "human" }`) to `agent.{id}.messages`.
- Render the conversation: user messages (from `turn_started`'s `text`), assistant
  text streaming live as `text_delta`s arrive, errors visibly.
- A text input line; enter sends. Input is rejected by the agent mid-turn — show the
  resulting `error` rather than pretending it sent.
- Unknown event types are skipped silently (forward compatibility, per the spec).

TUI libraries are allowed — ratatui + crossterm is a fine choice. Use the crates
you'd really use (async-nats, tokio, serde).

## Constraints

- Follow `standards.md` (in this directory).

- Rust, idiomatic.
- Work entirely inside your current working directory.
- Install the toolchain non-invasively if missing: rustup with `--no-modify-path`,
  never touch global config or shell rc files.
- **Parallel isolation**: other component sessions are running on this machine at the
  same time. Use your OWN NATS container on your OWN port —
  `docker run -d --name poc-nats-tui -p 4224:4222 nats:latest` — and pass
  `nats://localhost:4224` to the TUI and your stub agent. Do not touch containers or
  ports you did not create.

## Proving it

The agent doesn't exist in your session. Write a throwaway stub — a script or small
binary that plays the agent side per the spec: announces, then for each `user_input`
received emits `turn_started` / several spaced `text_delta`s / `turn_ended` on the
events subject. Harness code is scratch, clearly separated; the deliverable is the
TUI alone.

You cannot interactively drive a TUI, so prove it in two parts:

1. **Logic**: factor the event-folding (events in → conversation state) so it's
   testable without a terminal, and test it: deltas accumulate, turns seal, errors
   record, unknown types skip.
2. **Wire**: run the TUI against the stub with its input fed programmatically (e.g.
   a PTY, or piped stdin fallback) and capture that a round trip renders.

## Harness rules

- Do not leave background or long-lived processes running via Exec (the NATS
  container is the one exception; you may leave it up).
- Always pass an explicit timeout to every Exec call.
- Bake a hard 120-second self-termination into the TUI binary as a backstop so
  nothing is left running.

## Done when

The TUI builds, attaches to the stub agent over real NATS, sends input, renders the
streamed reply live, and the event-folding logic passes its tests — with nothing but
the NATS container left running.

## Desirable (only if the core is done)

- On attach, call `agent.{id}.history` (NATS request/reply, per the spec) and render
  the returned messages before consuming live events.
