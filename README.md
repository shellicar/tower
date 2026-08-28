# tower

> The central management plane for a fleet of Claude sessions.

## What this is

Tower makes a fleet of LLM sessions visible, addressable, and eventually
orchestrated, over NATS. This repository holds the design documents, the wire
specs, the proof of concept, and the v1 MVP in [`mvp/`](mvp/): `towerd` (the
daemon that folds the wire into views), a Svelte frontend (the staleness
rail — open a conversation, read it, say into it), and `bridge` (a v0 agent
host serving conversations with the Skill tool). The specs remain the
contract; other implementations live in their own repositories and conform
to them.

## Motivation

I run a large fleet of concurrent Claude sessions, managed by hand over tmux:
window-hopping to monitor, capture-pane to read state, send-keys to deliver
messages. Nobody manages 200 servers by ssh'ing into each one. Tower is the
central plane; `tmux attach` is ssh, and it stays.

## The specs

The wire contract. One concern per document, indexed by
[`docs/spec/README.md`](docs/spec/README.md):

- [`docs/spec/core.md`](docs/spec/core.md): how the system thinks. Authority,
  the planes, what earns an event, and the principles the rest is built on.
- [`docs/spec/nats.md`](docs/spec/nats.md): how the system uses the bus.
  Namespacing, message structure, evolution, storage.
- [`docs/spec/conversation.md`](docs/spec/conversation.md): the conversation
  itself. What was said, and what changed it.
- [`docs/spec/agent.md`](docs/spec/agent.md): who is serving conversations,
  and where.
- [`docs/spec/approval.md`](docs/spec/approval.md): asking permission, and
  answering.
- [`docs/spec/content.md`](docs/spec/content.md): how a tool's output is
  presented. The vocabulary, and the surface an agent renders it into.
- [`docs/spec/conformance.md`](docs/spec/conformance.md): how an implementation
  proves it carries the specs.
- [`docs/spec/scenarios.md`](docs/spec/scenarios.md): the fixture scenarios it
  proves that against.

## The design docs

`docs/planning/` is the frozen design corpus. It is not maintained, and it is
not discardable either: it holds the reasoning you would otherwise guess at.

- [`docs/planning/project-state.md`](docs/planning/project-state.md): where
  things stood, and a map of the rest of the corpus.
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
the concern specs. The v1 MVP in [`mvp/`](mvp/) implements them live: the
conv concern at v2 (leaf subjects, one-place discriminators), agent liveness
folded into the rail, and the bridge serving real conversations end to end.
Versions are per concern and coexist on the broker — a pre-v2 tower runs
beside this one untouched. See [`docs/roadmap.md`](docs/roadmap.md).
