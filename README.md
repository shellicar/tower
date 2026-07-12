# tower

> The central management plane for a fleet of Claude sessions.

## What this is

Tower makes a fleet of LLM sessions visible, addressable, and eventually
orchestrated, over NATS. This repository holds the design documents, the wire
specs, and the proof of concept. There is no product build here yet: the specs
are the deliverable, and implementations live in their own repositories and
conform to them.

## Motivation

I run a large fleet of concurrent Claude sessions, managed by hand over tmux:
window-hopping to monitor, capture-pane to read state, send-keys to deliver
messages. Nobody manages 200 servers by ssh'ing into each one. Tower is the
central plane; `tmux attach` is ssh, and it stays.

## The specs

The wire contract. One concern per document, structured by the master spec:

- [`docs/spec/nats-spec.md`](docs/spec/nats-spec.md): the master document. Namespacing,
  message structure, evolution rules, the planes, authority, storage, and the
  system principles with the reasoning that produced them.
- [`docs/spec/conversation-spec.md`](docs/spec/conversation-spec.md): the conversation
  concern. The tree of messages, the committal change stream, telemetry,
  `say`/`cancel` with preconditions.
- [`docs/spec/approval-spec.md`](docs/spec/approval-spec.md): the approval concern. The
  authorization exchange: raise, answer, settle.
- [`docs/spec/conformance.md`](docs/spec/conformance.md) and
  [`docs/spec/scenarios.md`](docs/spec/scenarios.md): how implementations prove they
  carry the specs, and the fixture scenarios that prove it.
- [`docs/spec/content-vocabulary.md`](docs/spec/content-vocabulary.md): the standard by
  which a tool's output is presented. Understanding recorded ahead of its
  design pass.

## The design docs

- [`docs/planning/project-state.md`](docs/planning/project-state.md): read first. Maps the
  design documents and says where things stand.
- [`docs/planning/multi-transport-architecture.md`](docs/planning/multi-transport-architecture.md):
  the capabilities spec. Agent, bridge, protocol, the layers.
- [`docs/planning/orchestration-layer.md`](docs/planning/orchestration-layer.md): the three
  concerns above the agent: routing, control plane, orchestration logic.
- [`docs/roadmap.md`](docs/roadmap.md): CLI to tower v1, in stages that are
  each independently valuable.

## The POC

[`poc/`](poc/) holds the NATS proof of concept: five components built by
separate sessions that never saw each other's code, interoperating on first
contact because the spec was the only surface.

```sh
cd poc
./dev.sh   # NATS expected running; brings up fake-model, two agents, tower backend, vite
./tui.sh   # attach the terminal client to agent-one
```

## Status

Stage 1 (the tap) shipped in the node CLI and its contract was superseded by
the concern specs. Stage 2, implementing the specs, is next. See
[`docs/roadmap.md`](docs/roadmap.md).
