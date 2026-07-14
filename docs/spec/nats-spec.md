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
| approval | `approval` | `approval-spec.md` |
| agent | `agent` | `agent-spec.md` |

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

## What earns an event

The wire carries facts the state owner witnessed or decided, published once,
at the grain they occurred. Anything derivable from facts already on the wire
is never restated — a second statement of one truth is two truths that can
disagree.

**Consumers are never predicted.** No event is justified or rejected by who
might read it: consumers are unknowable, and any argument from them is
invention. The test needs no readers — is this a fact the owner holds
firsthand, or a derivation of published facts? Witnessed or decided → publish
it once, on the subject matching its nature. Emergent from absence or
combination (idle, a fold) → the consumer's own computation, forever.

Add-only makes the asymmetry safe: a missed fact is cheap to add later; a
restated derivation can never be removed.

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

## System principles

Not NATS rules — the design posture the spec serves. Recorded here because each
one directly shaped the structure above, and unrecorded reasoning gets
relitigated by accident. They crystallised while dismantling the tap-era design
— run, heartbeats and approvals evicted from the conversation tree — and each
carries the scenario that forced it.

- **Work is addressed to the work, never the worker.** A request that changes
  an entity's state is addressed to the entity (`say` speaks to the
  conversation); which process services it is placement — a decision inside
  the system, invisible to senders on purpose. You ask for "job 1 serviced",
  never "job 1 serviced by process B in cluster C" — the moment a sender
  addresses a worker, it inherits that worker's lifecycle. Worker-addressed
  operations exist too (bootstrap, config, identity delivery), and they are
  exactly the operations *about* the worker: the control plane managing its
  resources. The addressee is always the entity whose state the operation
  changes.

  *Where it came from:* the question of what `say` addresses. Instinct said
  the bridge agent; the counter-case was Anthropic's own cluster — every
  request is placed for you, and you never say where it runs. The
  two-workers-one-conversation case dissolved the same way: choosing between
  workers is scheduling, a decision inside the system. Today's
  send-keys-to-a-pane is exactly the imperative addressing this migrates away
  from.

- **The stream is the truth; everything else is intermediate state.** A
  committal stream defines what happened. A worker that finished the work but
  died before committing did — by the system's own definition — nothing: its
  effort was intermediate state, as disposable as its heartbeats. This is what
  makes re-servicing safe without coordination: a successor checks the
  operation's premise against the stream — uncommitted means the premise still
  holds, service it; committed means the premise is stale, refuse. Workers
  never have to agree with each other, only with the record.

  *Where it came from:* two corrections. "Sending m7 to the API" is a log line
  written before the fact — mistaking it for authority conflated telemetry
  with commit; telemetry runs ahead of the truth by nature, or nothing could
  be attempted before it was committed. And the respawn scenario: worker A
  finishes, dies uncommitted, worker B is spun up — with the stream as the
  only truth, B services the premise safely and A's effort was simply
  intermediate state.

- **Failure is committable state, not a gap.** A turn that died is not missing
  from the record — "aborted" is a state, committed like any other. The record
  never claims more than it knows, and never dresses an interruption as a
  clean ending.

  *Where it came from:* the local analogy. On a workstation, a killed request
  leaves the conversation knowing "API request aborted" — that is the new
  state, not a hole. The distributed record deserves the same honesty.

- **Side effects escape the stream; reconciliation is the worker's job.** The
  stream tells the truth about the system's own bookkeeping — it does not
  manage the world. A tool may have touched the filesystem before its process
  died uncommitted. The worker that wakes up owning the state reads the record
  (last committed state, plus any committed failure) and reconciles the world
  itself: re-run, check first, ask. The record's obligation is to make that
  decision possible — it influences behaviour, it does not define it.

  *Where it came from:* the pods scenario — a replacement container waking up
  mid-mission must reconcile and reconstruct the world; the stream was never
  going to do that for it. And two proofs that behaviour belongs to the agent:
  a Ctrl-C plus a permissions change dissolving an approval while the
  conversation stayed byte-identical, and the trim script — whose revisions
  land on the change stream as commits like any other change, while the policy
  behind them (what to trim, when, by what thresholds) stays the agent's own.
  The record carries effects, never reasons.

## Planes

Three planes, borrowed from networking (where the separation is rigorous;
Kubernetes formally defines only its control plane and colloquially calls the
rest the data plane):

- **Operational plane** — the work itself: the concerns' traffic —
  conversations, approvals, `say` and answers. Networking's data plane.
- **Control plane** — what decides how the operational plane runs: scheduling,
  spawning, lifecycle, health — the behind-the-scenes machinery.
  `../planning/orchestration-layer.md` already names this in the Kubernetes sense as
  Tower's job; it is named, not yet designed.
- **Observability plane** — telemetry. Observation of the other two.

The planes carry different trust and dependency profiles — which is why
networking separates them — and a piece of traffic is classified by the layer
that *operates through it*, not by who reads it.

Visualised: the two traffic planes are horizontal rows, the concerns are
vertical columns, and every message lands in exactly one cell:

```
                conv          approval        agent (future)
             ┌─────────────┬──────────────┬────────────────┐
operational  │ changes     │ lifecycle    │ (spawn/config  │
             │ requests    │ requests     │  requests …)   │
             │ deltas      │              │                │
             ├─────────────┼──────────────┼────────────────┤
observability│ telemetry   │ telemetry    │ lifecycle,     │
             │ (turns,     │ (pulse)      │ attached,      │
             │  tools,     │              │ ready …        │
             │  usage)     │              │                │
             └─────────────┴──────────────┴────────────────┘

control plane: a participant, not a row —
  reads the observability row across every column,
  acts on the operational row (spawns, configures, delivers),
  and its own traffic lives in the agent column like anyone else's.
```

The control plane is not a third row — it is a **participant**. It reads the
observability row across every column, acts on the operational row (spawns,
configures, delivers), and the traffic it generates is not a plane of its own:
it lands in the grid like everyone else's, classified by the same two rows.
Its reach is cross-cutting; its traffic is ordinary. Which is also why it can
be a program, a spec-interpreter, or a Claude without the grid noticing — a
participant can be swapped; a plane cannot.

Two orchestration participants, kept distinct (the two senses in
`../planning/orchestration-layer.md`):

- **Routing (workflow)** is operational messaging on the workload columns —
  conversation 1 sending a message to conversation 2 is a `say`, with
  `from: orchestrator`.
- **The control plane** acts on the infrastructure column — conversation 1
  wanting a *new* conversation is not a message, it is a spin-up: an
  agent-layer act.

The agent concern sits a layer below the workload concerns: it is what work
runs *on*. That layering scopes the control plane naturally — read
observability everywhere, write infrastructure only, touch conversations only
indirectly, by managing what serves them.

## Environment

The wire is environment-agnostic, deliberately. A conversation's environment
— the machine, the working directory, the process housing it — is part of
*what serves it*, and the conversation spec excludes exactly that: kill the
CLI, move the conversation to another directory, relaunch — not one wire fact
changes.

Environment becomes real when orchestration does: something must set up an
environment and create the process that houses a conversation. That lands
with the control plane and the agent concern's design pass. Whether
environment is a conversation property, a worker property, or its own concern
is decided there — and cannot be decided by accident: committing environment
to a conversation fits none of the change stream's kinds, so the attempt
itself raises the argument.

Until then, one discipline with teeth: environment must not leak in through a
side door. The tap-era `label` carried `location` — cwd and tmux coordinates
riding conversation announcements — and the temptation recurs whenever a fold
wants it (a session switcher scoped to cwd, auto-resume by directory). The
rule: cwd-association is attachment telemetry — keyed by the process,
severable — or a client's local store; never conversation state.

Deployment conventions may ride telemetry fields — cwd, pid, tmux coordinates
on attachment events, feeding a "click to go to the CLI" — and the spec
neither defines nor forbids them; add-only already makes them lawful (unknown
fields are ignored). This is recorded precisely as the reason environment
stays *out* of the spec: nothing has to be decided now, and nothing useful is
blocked in the meantime — a convention is a private prototype on the
observability plane, costing no one anything, replaceable the day the real
design lands.

## Telemetry

`telemetry` is a general subject suffix, available to any concern, defined by
one test: **the publishing layer operates without it.** Remove a concern's
telemetry and that layer still functions — dashboards go dark, nothing it does
breaks. Telemetry is read, or it would be worthless; layers above may even
build their own operation on it — a control plane scheduling off process
lifecycle events operates *on* observation, and that is its dependency to
declare, at its layer. Reading never reclassifies the traffic: severability is
per-layer, not per-deployment. Traffic a layer functions *through* (a
committal stream, an ask that must be answered) is not telemetry, whatever it
is named; filing load-bearing traffic under telemetry — or observation under
an operational subject — is the miscategorisation this definition exists to
stop. Observers of operational traffic *read it*; they never receive a copy —
one thing, one owner, observed rather than duplicated.

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

## Authority

**Connection is authority.** Anyone connected to the broker may send anything;
the protocol does not authenticate or authorise senders. `from` is provenance,
never enforcement — it says who spoke, not who may. If a deployment needs
enforcement, it lives at the application layer — broker accounts, ACLs, the
deployment's own boundary — never in individual agents: an agent deciding who
may address it would be every agent re-implementing policy locally, and
wrongly. Decided knowingly for v0; the broker is the trust boundary — graded
per plane if the deployment chooses (see Telemetry), strict on the operational
plane always.

## Storage

Subjects separate meaning, never storage. Persistence — JetStream or any other
recorder — is a subscriber's choice, made per deployment: which subjects a
stream captures and for how long are deployment configuration, not contract. No
spec may depend on what is recorded.

One boundary is contract, not configuration: **streams capture event subjects
only — never a `.requests` subject.** JetStream acknowledges whatever it
captures with a PubAck to the publish's reply inbox, and a request *is* a
publish with a reply inbox — a stream over a requests subject becomes a second
responder, racing the servicer's reply (found on first live contact, not in
theory). Requests are not events: their durable trace is their effect on the
record, and replies ride point-to-point inboxes no stream can capture anyway.
A deployment that genuinely wants an audit of asks creates a separate `NoAck`
stream for that purpose, deliberately — never the committal capture.
