# NATS spec — how the system uses the bus

The master document: the shared structure every concern's traffic follows —
namespacing, message shape, evolution rules. It deliberately defines **no**
concern's subjects or events; each concern has its own spec document beside this
one. If this document ever needs to know a concern's details, the split has
failed.

## Concerns

A concern is one kind of thing the system talks about. Each concern owns:

- a top-level namespace in the subject tree, and
- its own spec document defining its subjects and message types.

A concern's traffic is *about* its entity — a conversation's events are about
the conversation. Traffic that is not about that entity does not belong in its
tree, however convenient the ride would be.

| Concern | Namespace | Spec |
|---|---|---|
| conversation | `conv` | `conversation-spec.md` |

Other concerns (process liveness is a known one) get their namespace and spec
when their design pass happens — not before, and never by squatting in an
existing tree.

## Namespacing

```
{concern}.{version}.{id}.{kind}
```

- **concern** — the top-level namespace, from the registry above. Names the
  data, never a mechanism or a consumer.
- **version** — the major version (`v1`). A breaking change is a new tree; old
  consumers keep working, migration is unhurried.
- **id** — the entity instance the traffic is about.
- **kind** — the kind of traffic, last, so wildcards fall where subscribers
  want them.

The two wildcard shapes this ordering buys:

- `{concern}.v1.{id}.>` — everything about one entity.
- `{concern}.v1.*.{kind}` — one kind of traffic, across all entities.

**Why concern-rooted — a decision, not a discovery.** The alternative was
considered: rooting the tree by plane or mechanism (`tap.v1.conversation.{id}`
— the original scheme), monitoring and operational as separate roots with the
concerns nested inside. Neither shape is wrong; this one was chosen, for these
reasons:

- A mechanism names one consumer's relationship to the data ("tap"), and rots
  the moment a second kind of consumer exists. The data outlives every
  mechanism pointed at it.
- Concerns multiply cleanly as siblings: a new concern is a new root, never a
  tenant of someone else's tree — the process concern arrives beside `conv`,
  not inside it.
- The plane distinction (monitoring versus operational) is real but is
  *policy* — who may read or write which kinds, what a stream captures. Policy
  is expressed over kinds and ACLs; baking it into the root would freeze one
  policy into every subject name.

Recorded so it is not relitigated by accident: if this shape is ever revisited,
it is a real fork, taken knowingly.

## Message structure

- JSON, UTF-8, one object per NATS message.
- Every message carries `type` (the discriminator) and `ts` (ISO-8601 with UTC
  offset).
- Everything else belongs to the concern's spec.

## Two kinds of traffic

Per the architecture docs:

- **Events** — things that happened. Broadcast; cannot be rejected; any number
  of subscribers.
- **Requests** — operations with a response pair; something waits. The reply
  rides the NATS reply subject, addressed to the sender.

A concern's spec declares which of its subjects carry which.

## Evolution

Within a major version, add-only:

- producers may only add — new types, new optional fields, new enum values;
- consumers must tolerate — unknown types skipped without error, unknown fields
  ignored, unknown enum values non-fatal.

Both halves are required; either alone fails. Removing a field or changing a
meaning is a breaking change: a new tree.

## Storage

Subjects separate meaning, never storage. Persistence — JetStream or any other
recorder — is a subscriber's choice, made per deployment: which subjects a
stream captures and for how long are deployment configuration, not contract. No
spec may depend on what is recorded.
