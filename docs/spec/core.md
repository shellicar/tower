# Core

## System principles

Not NATS rules — the design posture the spec serves. Recorded here because
each one directly shaped the structure `nats.md` defines, and unrecorded
reasoning gets relitigated by accident. Most crystallised while dismantling
the tap-era design — run, heartbeats and approvals evicted from the
conversation tree; others since. Each carries the scenario that forced it,
wherever it happened.

- **A participant does not act on state it has not yet observed.** A fold
  that has not seen enough of the record to know — a just-booted consumer, a
  subscription that only just went live, a degraded feed — yields "unknown",
  and unknown never satisfies a premise. Absence of information is not a
  finding: never-heard-yet is not stranded, unseen is not absent, an empty
  map is not an empty world. Without this rule every premise and fold in
  these specs is meaningless, since any verdict could be an artifact of
  having just arrived.

  Observation is reading the log. A fold bootstraps by replaying capture from
  the start (or from wherever it last left off) and then follows the live
  feed from the point replay reaches — there is no other way to warm up,
  because there is no peer to warm up from: no discovery, no state transfer,
  no cooperation protocol between participants. Knowing the current state and
  having read the captured record are the same fact, not two.

  **Warm, defined:** a position in the log, not a duration. A fold is warm
  once it has replayed capture up to the moment its live subscription began —
  the instant it stops reading history and starts reading now. Before that
  instant it is cold, however long it has technically been running; a feed
  that stalls or falls behind after going live drops it back to unknown for
  whatever it lost contact with.

  *Where it came from:* an implementer read agent.md's safety note at
  the stranded threshold (the premise for `service`) as licensing a verdict
  from a cold map, and had a live holder taken over by an instance that had
  not yet observed the standing attachment. That note's own scope
  (agent.md, the premise for `service`) states the fix in detail; this
  principle is the general rule it draws on.

- **Valid or not — there is no partial acceptance.** An event either satisfies
  its schema or it is not an event. A value outside the valid range makes the
  whole message invalid, not the field: nothing is clamped to a limit,
  nothing is salvaged, no part of it folds. Consumers reject at the boundary,
  immediately — fail fast, and nothing downstream ever sees a half-valid
  message. This is not harshness for its own sake; it is what keeps the rules
  simple enough to be followed. The moment a consumer may weigh which fields
  to keep, or what a publisher probably meant, every reader weighs
  differently and the schema stops meaning anything. A spec states what is
  legal. It does not care what you intended.

  The one relaxation is migration, and it is not a relaxation of correctness.
  A consumer may be built to read a superseded shape — an older major
  version's events, on its own tree — so a deployment can move from one
  version to the next without stopping. Within a version there is no
  superseded shape to read: evolution is add-only there, and a change that
  supersedes anything is a new tree (nats.md, Evolution). Expressed as a
  union of complete supported schemas: each member is wholly valid in
  itself, and a message must satisfy one of them entirely. That is support
  for a known, named, temporary past, decided deliberately and removed when
  the migration completes — removing a version is deleting a union member, a
  visible act. It is never latitude for a message that is invalid under the
  shape it claims to be: within a version, valid or not stands.

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

- **Derivations are functions of folded facts' fields, never of delivery
  accidents.** Arrival order carries no meaning — not across classes, not
  across subjects a fold happens to iterate in some order. A derivation
  that reads one is reading noise and calling it signal.

  If a reduction needs an arbitrary tie-break to stay deterministic, that
  is not a gap to fill with a rule. It's a sign the modelling is wrong. Ask
  whether the competing facts can legitimately coexist at all, before
  reaching for a rank between them.

  *Where it came from:* the attachment case (agent.md, Attachment;
  conversation.md, Attachment). A conversation's servicing state used
  to be read off however many `attached` facts a fold happened to hold at
  once, across worlds with no shared clock. Which instance "won" depended
  on HashMap iteration order, and two implementations disagreed.

  Every candidate fix debated was a tie-break rule — latest timestamp,
  lexicographic instance id. Each answered a question the model should
  never have posed. The actual fix deleted the tie: attachment is
  singular, a new claim unconditionally supersedes the standing one, and
  one subject per conversation makes the wire's own per-subject
  publication order the total order. There is no set left to rank within.

  The lesson: when a fold seems to need an arbitrary-but-deterministic
  rule, fix the state space it's folding over — not the rule.

## Authority

**Connection is authority.** Anyone connected to the broker may send anything;
the protocol does not authenticate or authorise senders. `from` is provenance,
never enforcement — it says who spoke, not who may. If a deployment needs
enforcement, it lives at the application layer — broker accounts, ACLs, the
deployment's own boundary — never in individual agents: an agent deciding who
may address it would be every agent re-implementing policy locally, and
wrongly. Decided knowingly for v0; the broker is the trust boundary — graded
per plane if the deployment chooses (nats.md, Telemetry), strict on the
operational plane always.

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
wants it (a session switcher scoped to cwd, auto-resume by directory).

The rule: cwd-association is an attachment fact, keyed by the process and
severable (conversation.md, Attachment), or a client's local store.
Never conversation state.

Deployment conventions may ride fields on the attachment claim — cwd, pid,
tmux coordinates, feeding a "click to go to the CLI". The spec neither
defines nor forbids them; add-only already makes them lawful (unknown
fields are ignored).

This is exactly why environment stays *out* of the spec: nothing has to be
decided now, and nothing useful is blocked in the meantime. A convention is
a private prototype riding a claim nobody else depends on — costing no one
anything, replaceable the day the real design lands.

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
                conv          approval        agent
             ┌─────────────┬──────────────┬────────────────┐
operational  │ changes     │ lifecycle    │ service, drain │
             │ requests    │ requests     │ requests       │
             │ deltas      │              │                │
             │ attachment  │              │                │
             ├─────────────┼──────────────┼────────────────┤
observability│ telemetry   │ telemetry    │ ready,         │
             │ (turns,     │ (pulse)      │ pulse …        │
             │  tools,     │              │                │
             │  usage)     │              │                │
             └─────────────┴──────────────┴────────────────┘

control plane: a participant, not a row —
  reads the observability row across every column,
  acts on the operational row (spawns, configures, delivers),
  and its own traffic lives in the agent column like anyone else's.
```

`conv`'s `attachment` sits in the operational row, not observability. It is
a decided claim with consequences (agent.md, Attachment) — not
something a layer merely functions without. Removing it changes who is
being served, which fails the Telemetry section's own severability test.

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

## Storage

Subjects separate meaning, never storage. Which subjects are captured is not
a deployment's choice, and neither is whether there is a log at all.
