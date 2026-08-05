# NATS spec — how the system uses the bus

The shared structure every concern's traffic follows — namespacing, message
shape, evolution rules. Each concern's subjects and events are defined in
its own spec document beside this one. If this document ever needs to know
a concern's details, the split has failed.

## Concerns

A concern is one kind of thing the system talks about. Each concern owns:

- a top-level namespace in the subject tree, and
- its own spec document defining its subjects and message types.

A concern's traffic is *about* its entity — a conversation's events are about
the conversation. Traffic that is not about that entity does not belong in its
tree, however convenient the ride would be.

| Concern | Namespace | Spec |
|---|---|---|
| conversation | `conv` | `conversation.md` |
| approval | `approval` | `approval.md` |
| agent | `agent` | `agent.md` |

Other concerns (host provisioning and environment are known ones) get their
namespace and spec when their design pass happens — not before, and never by
squatting in an existing tree.

## Namespacing

```
{concern}.{version}.{id}.{class}.{event}
```

- **concern** — the top-level namespace, from the registry above. Names the
  data, never a mechanism or a consumer.
- **version** — the major version (`v1`). A breaking change is a new tree; old
  consumers keep working, migration is unhurried.
- **id** — the entity instance the traffic is about.
- **class** — the nature of the traffic (committal, observation, ephemeral,
  ask). Retention, trust, and capture policy divide here.
- **event** — the message's type, as a subject token.

**The subject carries the taxonomy.** The subject carries everything the
server might need to route, filter, retain, or authorise on; the payload
carries only what consumers read after delivery. This is structural, not
stylistic: NATS routes and filters on subjects only, never payloads. A type
buried in the payload cannot be filtered server-side, captured selectively by
a stream, graded by retention, or named in an ACL — it can only be received
and discarded. The subject is the sole discriminator; the
type is not repeated in the body. A stored message keeps its subject
(JetStream retains it with the message), so it is self-describing without a
redundant field that could drift.

**Token depth.** A token earns its place when it is a real axis — something a
subscription, a stream's capture filter, a retention rule, or a credential
could plausibly divide on. A token no policy could ever divide on is ceremony.

Wildcard shapes this ordering buys:

- `{concern}.v1.{id}.>` — everything about one entity.
- `{concern}.v1.*.{class}.>` — one class of traffic, across all entities.
- `{concern}.v1.*.{class}.{event}` — one event type, across all entities.

**Subscription discipline.** Ordering holds within one subscription, not
across subscriptions. A stream whose meaning lives in its ordered totality —
a committal change stream — is consumed whole: fold consumers subscribe
`{class}.>`, never a set of sibling leaves. This is also what keeps new
leaves add-only: a wildcard subscriber sees an unknown event type and
tolerates it; a sibling-set subscriber is silently blind to it, and on a
committal stream blind means wrong state with no error.

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
- **The type is stated once, in its natural home — the fault is duplication,
  never a `type` field as such.** Where the type is a routing axis it is a
  subject leaf, and the body does not repeat it: a second copy could only
  drift, and the subject travels with the message everywhere it is routed,
  stored, or replayed. Where a subject deliberately carries several shapes
  that share every routing and retention policy (a flat subject like
  conversation `deltas`), the type is not an axis, earns no token, and its
  home is the body — an explicit `type` field, the single place a
  subject-less discriminator lives.
- Every message carries `ts` (ISO-8601 with UTC offset), except subjects that
  declare themselves bare.
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

A migration that requires coordinated rollout within a version is a breaking
change, whatever it is called — deepening a subject silences exact
subscribers the same as renaming it would. The tree is the mechanism; never
lockstep.

Version skew is absorbed by the single-instance component. Many-versioned
components each speak exactly one tree — their own. The component that faces
both worlds reads both trees and answers each entity on the tree its traffic
arrives on: the version token in the subject is the discovery — no handshake,
no capability advertisement, no stored registry to go stale.

## Naming

A field or subject token earns its place by what it *denotes*, not by whether
it happens to be used as an address.

- **A durable, causal referent** — a place, a working directory, content — is
  named, and may be keyed in the subject. What is causal is an input to how
  the entity unfolds: a conversation served in one directory versus another
  can act differently, the way a message's content changes what follows.
- **The identifier of such a referent** is a stable, meaningless handle. Its
  one job is to denote the same thing consistently; the mutable facts about
  the thing ride as fields, never baked into the id. A world id names a place
  the way a house is named — rename the street or forward the mail and the
  house is unchanged, so provenance and host are fields, and a relabel or a
  migration breaks no reference.
- **An ephemeral, incidental handle** — a pid, a port, a reply inbox — is how
  you reach something, not something about it. It is never named in the
  contract nor baked into an id: it dies and reassigns, and identity is
  already carried elsewhere. A deployment that wants it (click-to-process)
  carries it as an open field, which tolerance already permits.

The test needs no guess about consumers: does this denote a durable causal
thing, the stable handle for one, or an ephemeral way to reach one? Only the
first two belong in the contract.

## Conformance

The concern is the unit of conformance. An implementation adheres to the
specs of the concerns it implements, entirely — and may implement none of a
concern: a producer that never publishes to a concern's tree owes it nothing,
and readers' folds degrade honestly (a conversation with no agent concern
behind it simply has no liveness to show). No component is required to be
forwards compatible — nobody can adhere to a future — and no many-versioned
component is required to read old trees: backwards compatibility is a
property of the deployment, purchased once, where skew is absorbed
(Evolution). Within an implemented concern the finer grains already apply:
any request may be answered `rejected: unsupported` — compliance is
answering, not implementing — and tolerance covers unknown types, fields,
and values.

Conformance is also the whole enforcement model. There is no negotiation on
the wire and no cooperation protocol: the system works because participants
conform, not because anything makes them.

There is no global punishment for non-compliance. The spec says what is
required, and each rule states what breaking that rule costs. Speeding is a
fine, not amputation. Today two rules carry a cost:

- **An over-limit heartbeat is ignored.** Nothing was waiting on it, and the
  silence it leaves is already the consequence.
- **A wrongful claim costs the instance its authority.** Others act on claims,
  so a false one has to be disowned rather than dropped.

More get stated as they come up.

Forfeiting authority is loss of authority, not invisibility: the identity's
events stay in the record, visible and monitorable — you don't stop watching a
submarine because it was boarded — but they no longer move the fold. There is
no way back for that identity: like a crashed process, it is fixed by
restarting, and a restart is a new identity. That cost is stated here once,
and a concern's spec points at it rather than restating it.

**Compliance is not global state.** Nothing publishes a verdict and nothing
asks another party for one — a reader derives it from the log it has read,
like everything else it knows. Two readers with different windows may derive
differently; neither is coordinating with the other, so there is nothing to
contradict.

This is a deliberate trade. Leases, fencing, and multi-party release would
let a violator be reasoned back in, at the price of machinery every correct
run carries. Instead the happy path is trivially simple, and a violation is
expensive on purpose: the violator's word stops being authoritative, and the
deployment restarts it. Nothing on the wire enforces any of this — the record
shows the violation, and each reader derives it for itself.

## Telemetry

Telemetry and the planes are defined in core; this is what they cost a
deployment to run.

The reason the planes are separate channels is trust, not tidiness. Telemetry
is publish-only from the agent's side and nothing acts on it: the worst case
of accepting a bogus publish is a wrong pixel on a dashboard. The operational
plane is application state: reading it is reading the system's truth, writing
it is acting. A deployment can therefore grade them — accept telemetry
promiscuously (even on invalid credentials), while the operational plane
demands real ones — and that grading is only possible because the subjects
keep the planes separable.

**The v0 deployment deliberately declines the grading.** These are two
separate things, kept distinct on purpose: the *model* — planes with different
trust profiles, gradable per deployment — is the design and stands. The
*practice* here is strict credentials on everything, no anonymous telemetry
path. Reasoning: the case an unauthenticated write path would serve (an agent
that cannot authenticate but should still be seen) is already covered by the
machine's own metrics, while the cost is an anonymous write path terminating
on the same broker that holds application state — a standing exposure waiting
on one misconfiguration, for a niche gain. A deployment where that trade reads
differently uses the model as designed; this one does not, knowingly.

## Storage

Storage's substrate claim is in core; this is what a deployment configures,
and the one boundary it may not cross.

Persistence (JetStream or any other recorder) is a subscriber's concern, and
what a deployment configures is retention and naming: how far back a stream
reaches, and what it is called.

One boundary is contract, not configuration: **streams capture event subjects
only — never a `.requests` subject.** JetStream acknowledges whatever it
captures with a PubAck to the publish's reply inbox, and a request *is* a
publish with a reply inbox — a stream over a requests subject becomes a second
responder, racing the servicer's reply (found on first live contact, not in
theory). Requests are not events: their durable trace is their effect on the
record, and replies ride point-to-point inboxes no stream can capture anyway.
A deployment that genuinely wants an audit of asks creates a separate `NoAck`
stream for that purpose, deliberately — never the committal capture.
