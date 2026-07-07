# Brief: fake-model

Build the **fake-model** component of the POC described in `spec.md`. Read the spec
first; on any conflict, the spec wins. You are building exactly one component — three
other sessions are building the others against the same spec, and none of you share
code. Your only contract is the spec.

## What you build

A Rust HTTP server implementing the **Fake model contract** section of the spec:
`POST /v1/messages` on port 8090, Anthropic-Messages-shaped request body, SSE
streaming response (`message_start`, `content_block_delta` per word with ~50ms delay,
`message_stop`), `400` with `{ "error": "..." }` on an invalid body.

No NATS. No other endpoints. The reply text is scripted from the last user message —
a canned sentence that quotes it back is fine.

## Constraints

- Follow `standards.md` (in this directory).

- Rust. Use the crates you'd really use (axum/hyper, tokio, serde). Idiomatic code.
- Work entirely inside your current working directory.
- Install the toolchain non-invasively if missing: rustup with `--no-modify-path`,
  never touch global config or shell rc files.

## Proving it

Prove the contract with curl (or a small test): a valid request streams the SSE
sequence in order with visible word-by-word deltas; an invalid body returns 400 JSON.
Show both.

## Harness rules

- Do not leave background or long-lived processes running via Exec. Start the server,
  test it, kill it — within a single bounded command where possible.
- Always pass an explicit timeout to every Exec call.
- Bake a hard 120-second self-termination into the server binary as a backstop so
  nothing is left running.

## Done when

The server builds, a valid POST streams the specified SSE event sequence, an invalid
POST returns 400, and nothing is left running afterwards.
