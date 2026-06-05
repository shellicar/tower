# Glossary

Terms that are **overloaded** — they mean different things at different layers or concerns. Each must be qualified; the unqualified word is ambiguous. The pattern: the words that need qualifying are exactly the ones that span layers or concerns. When a word means different things at different levels, name the level.

## client

- **Bridge client** (protocol level) — something that consumes a bridge's protocol: subscribes to events, sends requests. Lives outside the agent.
- **Transport client** (transport level) — something that initiates a transport connection (calls `connect()`). For OS pipes, neither side (inherited via spawn).

They can align (a WebSocket browser is both) or not (with NATS, both the agent's bridge and a peer are transport clients of the broker; only one is the bridge client).

## transport

- **The layer** (L3/L4) — how bytes move: fds, pipes, sockets, TCP.
- **Colloquial** — sometimes used for a whole bridge ("the NATS transport"). The precise word is **bridge**.

## orchestration

- **Control-plane orchestration** (Kubernetes sense) — orchestrating *resources*: spawn, schedule, lifecycle, health. Tower's job.
- **Workflow orchestration** (fleet sense) — orchestrating *the work*: which role does what, routing on verdicts. The orchestration logic.

## agent

- **Conceptual** — Harness + Model (Anthropic's framing).
- **The component** — the harness's entry point + turn loop (the "Agent" in the component map). The model is what it talks to, via the model adapter.
- **Agent process** — the running OS process hosting it.

## SDK (avoid as a component name)

Ambiguous three ways: the Anthropic SDK library, this project (`claude-sdk`), and the internal model-facing component. Use **model adapter** for the last.

## bridge vs bridge client

- **Bridge** — the agent-side component that translates protocol ↔ wire.
- **Bridge client** — the app-side end of the same wire.

Both are "the bridge" loosely; when it matters, say which side.
