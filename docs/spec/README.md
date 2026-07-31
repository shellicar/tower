# The spec

The wire contract, one document per thing it governs. This file is the index:
what each document is for, and the order to read them in.

## Read in this order

1. `core.md` — the foundations every other document stands on.
2. `nats.md` — how the system uses the bus.
3. The concerns, each owning a namespace in the subject tree and read in any
   order:
   - `conversation.md` (`conv`) — the conversation concern.
   - `agent.md` (`agent`) — the agent concern: who is serving conversations,
     and where.
   - `approval.md` (`approval`) — the approval concern.
4. `content.md` — the standard by which a tool's output is presented.
5. `conformance.md` and `scenarios.md` — how an implementation proves it
   carries the specs, and the fixtures it proves that against. The fixtures
   themselves are in `fixtures/`.

## How they relate

`core.md` and `nats.md` are the shared foundation: every concern document is
structured by them and points back at them rather than restating them. The
concern is the unit of conformance, so a concern document is self-contained
about its own subjects and message types, and never reaches into another's.

Versions are per concern and coexist: `conv` is v2, `agent` and `approval` are
v1. The trees are disjoint, so old and new run side by side.
