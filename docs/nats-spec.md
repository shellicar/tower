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

## Telemetry

`telemetry` is a general subject suffix, available to any concern, defined by
one test: **remove it and everything still functions.** Telemetry is
observation — dashboards go dark, nothing operational breaks. Traffic the
system functions *through* (a committal stream, an ask that must be answered)
is not telemetry, whatever it is named; filing load-bearing traffic under
telemetry — or observation under an operational subject — is the
miscategorisation this definition exists to stop. Observers of operational
traffic *read it*; they never receive a copy — one thing, one owner, observed
rather than duplicated.

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
