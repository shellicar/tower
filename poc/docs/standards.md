# Coding standards

Applies to every component. The reader is an experienced C++/C#/TypeScript developer
learning Rust from this code — write the Rust a thoughtful reviewer would hold up as
how it should be done.

## Correctness first

- `cargo fmt` clean; `cargo clippy -- -D warnings` clean.
- No `unwrap`/`expect` outside tests. Errors are values: `Result` everywhere,
  `anyhow` at the binary edge is fine; a typed error enum where a caller branches on
  the failure.
- Make illegal states unrepresentable: enums over booleans-and-flags, exhaustive
  `match` (no catch-all arm on protocol enums — a new variant should break the build,
  except where the spec requires unknown types to be skipped).
- Wire shapes as serde types in one `protocol` module, tagged unions via
  `#[serde(tag = "type")]`, mirroring the spec exactly.

## Dependency inversion, the Rust way

The reader values DI and SOLID. Honour the intent, not the C# ceremony:

- Put a **trait at each real seam** — the boundary you'd want to fake in a test.
  The agent's model client is the canonical one: the turn loop depends on a trait,
  the SSE/HTTP implementation lives behind it, tests drive the loop with a scripted
  fake.
- Constructor injection: dependencies passed in at construction (generics preferred,
  `dyn Trait` where it simplifies), no globals, no service locators.
- **No speculative abstraction.** A trait with exactly one implementation and no test
  double is ceremony — Rust punishes gratuitous indirection. Single responsibility
  shows up as small modules and small functions, not as one interface per struct.

## Structure

- One binary per component; modules split by responsibility (protocol, bridge/NATS,
  model client, terminal/UI, app wiring) — no 800-line `main.rs`.
- `main` is wiring only: parse args, construct, run. Logic lives in lib code that
  tests can reach.
- Tests for the logic that has any: event folding, protocol serde round-trips, turn
  state transitions. No tests for glue.

## Platform pins

- Stable Rust, edition 2024. Tokio for async. `async-nats` for NATS, `serde`/
  `serde_json` for wire shapes. HTTP: `reqwest` (client) / `axum` (server) unless the
  brief says otherwise.
- Comments explain *why*, not what. Doc comments on public items of the protocol
  module.

## Tower frontend (TypeScript)

- `strict: true`, no `any`, no `@ts-ignore`.
- Same seam rule: the WS event feed behind an interface so the folding logic is
  testable without a socket.
