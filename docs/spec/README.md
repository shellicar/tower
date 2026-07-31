# The spec

The wire contract, one document per thing it governs.

## The documents

- `core.md`: how the system thinks. Authority, the planes, what earns an
  event, and the principles the rest is built on.
- `nats.md`: how the system uses the bus. Namespacing, message structure,
  evolution, storage.
- `conversation.md` (`conv`): the conversation itself. What was said, and what
  changed it.
- `agent.md` (`agent`): who is serving conversations, and where.
- `approval.md` (`approval`): asking permission, and answering.
- `content.md`: how a tool's output is presented. The vocabulary, and the
  surface an agent renders it into.
- `conformance.md`: how an implementation proves it carries the specs.
- `scenarios.md`: the fixture scenarios it proves that against; the fixtures
  are in `fixtures/`.

## Where to start

`core.md`, then `nats.md`. The concerns after that, in any order: each owns a
namespace in the subject tree and stands alone.

## How they relate

`core.md` and `nats.md` are the shared foundation: every concern document is
structured by them and points back at them rather than restating them. The
concern is the unit of conformance, so a concern document is self-contained
about its own subjects and message types, and never reaches into another's.

Versions are per concern and coexist: `conv` is v2, `agent` and `approval` are
v1. The trees are disjoint, so old and new run side by side.
