# The spec

The wire contract, one document per thing it governs. This file is the index:
what each document rules on, and the order to read them in.

## Read in this order

1. `core.md` — the foundations. The system principles and the reasoning that
   produced them, authority, the planes, what earns an event, telemetry's
   severability test, environment, and the substrate claim about storage. None
   of it depends on the transport being NATS.
2. `nats.md` — how the system uses the bus. The shared structure every
   concern's traffic follows: namespacing, message structure, evolution,
   naming, conformance, retention. It defines no concern's subjects.
3. The concerns, each owning a namespace in the subject tree and read in any
   order:
   - `conversation.md` (`conv`) — the tree of messages, the committal change
     stream, telemetry, `say` and `cancel` with their preconditions.
   - `agent.md` (`agent`) — worlds, instances, and the servicing facts
     liveness folds from.
   - `approval.md` (`approval`) — the authorization exchange: raise, answer,
     settle.
4. `content.md` — the standard by which a tool's output is presented. The
   understanding first, then the surface standard built on it. Recorded ahead
   of its design pass.
5. `conformance.md` and `scenarios.md` — how an implementation proves it
   carries the specs, and the fixture scenarios it proves that against. The
   fixtures themselves are in `fixtures/`.

## How they relate

`core.md` and `nats.md` are the shared foundation: every concern document is
structured by them and points back at them rather than restating them. The
concern is the unit of conformance, so a concern document is self-contained
about its own subjects and message types, and never reaches into another's.

Versions are per concern and coexist: `conv` is v2, `agent` and `approval` are
v1. The trees are disjoint, so old and new run side by side.
