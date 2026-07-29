# Agent spec — v1

The agent concern: who is serving conversations, and where. Structure per
`nats-spec.md`; namespace `agent`. Every message here is *about* one world —
the environment conversations are served from — never about a conversation's
content. Kill the process, restart it: not one conversation wire fact
changes.

Attachment is which instance serves which conversation. That is a
conversation fact, not a world fact, so its wire shape lives on the
conversation's own tree (`conversation-spec.md`, Attachment). This spec
states the model an instance conducts itself by.

## The entity

The subject's id names a **world**: a placement domain — a machine, a
container — the environment conversations are served *from*. Worlds are
durable names for places; the processes standing in them are disposable.

- **world** — the addressable entity. `mac`, `pc`, a generated container
  world id. Deployer-chosen, never centrally registered; a creator generates
  a fresh world id per container exactly as it pre-generates a
  conversationId.
- **agent instance** — a process's presence in a world, identified by the
  pair `(world, instanceId)` — in payloads, never in subjects: address a
  process and you inherit its lifecycle (nats-spec, "Work is addressed to
  the work, never the worker").
  `instanceId` is minted fresh per process and unique within its world; the
  pair is then unique everywhere, since worlds are. The format is free — a
  pid qualifies, a uuid is typical — the spec mandates uniqueness within
  the world, nothing else. Never reused or inherited across a restart: a
  restarted process is a new instance in the same world — it resubscribes,
  and the world's address never changed. A process standing in several
  worlds is simply several instances that share a process, each with its
  own pulses and its own liveness.

One process may serve a world alone; several may share one; one process
serving many conversations is still one instance. The wire does not care:
correctness under concurrent servicing is carried by the conversation
record's premise discipline, not by exclusivity here — exclusivity is
economics (racing servicers waste work), a deployment's choice.

## Subjects

| Subject | Traffic | Carries |
|---|---|---|
| `agent.v1.{world}.telemetry.>` | events | servicing facts: ready, pulse |
| `agent.v1.{world}.requests.>` | requests | operations on the world's servicing |

Attachment claims are not here. A conversation's attachment is about the
conversation, not the world, so it lives on its own tree
(`conversation-spec.md`, Attachment). This section covers only what is
genuinely about the world: is a process up, and is it still promising to be.

The subject spells the type, as in the conversation spec: `telemetry.pulse`,
`requests.service`.

| Type | Subject |
|---|---|
| `ready` | `agent.v1.{world}.telemetry.ready` |
| `pulse` | `agent.v1.{world}.telemetry.pulse` |
| `service` | `agent.v1.{world}.requests.service` |
| `drain` | `agent.v1.{world}.requests.drain` |
| `chdir` | `agent.v1.{world}.requests.chdir` |

## Telemetry

Observation, per the master spec's severability test: remove it and every
conversation still functions — says land, commits flow. What goes dark is the
map: who serves what, and whether they are alive.

| Event | Fields | Notes |
|---|---|---|
| `ready` | `instanceId`, `host` | a process now serves this world; published once on boot, after its subscriptions are up |
| `pulse` | `instanceId`, `intervalS` | the liveness promise: "you will hear from me again within `intervalS` seconds." One pulse per instance, never per conversation — a process's liveness is one fact, and restating it per conversation is the restatement the master spec forbids |

**Liveness is a fold, never declared.** An instance is presumed gone after
about three of its own declared intervals of silence — judged against its own
promise, nobody else's; the spec mandates no cadence. **No declared interval
yet is not the same as alive**: an attachment (or a pulse) that has never
carried `intervalS` still needs a verdict, so a consumer applies a flat
default silence threshold (60s is this spec's suggested default — deployments
may choose their own) until a real promise arrives. Found in the field 19 Jul
2026: without this, an instance that attaches and dies before ever pulsing
reads as alive forever, because "no promise" and "definitely alive" collapsed
into the same fold outcome.

Environment facts ride `attached` as fields — published when known, never
fabricated, ignored when unrecognised (full shape: `conversation-spec.md`,
Attachment). Two kinds, kept apart by what they denote (nats-spec, Naming):

- **About the thing** — `cwd`, and the world's provenance (which host created
  it). Durable and causal: cwd is an input to how the conversation unfolds,
  the way a message's content is. `cwd` is named in the schema because
  `chdir` operates on it.
- **How to reach the thing** — `pid`, a port, tmux coordinates. An ephemeral,
  incidental handle: it dies with the process and is meaningless without its
  host. Never named in the schema — it rides as an open field for a
  deployment that wants click-to-CLI, exactly as the master spec's
  Environment section allows, and `instanceId` already carries identity.

The world id itself is a stable, meaningless handle: it denotes a place
consistently and carries nothing about it. Provenance and host are fields, so
a relabel or a migration breaks no reference — the house is the identity, the
postal label is not.

## Attachment

**Attachment is singular.** `attached` claims: this conversation is served here, by me, now. There is always one claim, never a set.

A new `attached` unconditionally supersedes whatever attachment stood before it, across any world, any instance. The instant the new one lands, the old one stops counting for anything: liveness, cwd, existence.

`attached` carries no precondition. Publishing it never asks permission; supersession does the rest.

Failover and migration are the same operation. Failover: the old instance went silent, a new one adopts. Migration: the old instance is fine, something decided to move the conversation. Either way, the wire carries one operation.

Fencing and leases are deliberately not here. A spec can state what a compliant instance does. It cannot make a malfunctioning one behave by designing around it — trying only buys complexity.

There is never a legitimate case for two instances serving one conversation at once; that is a deployment's race, not a wire state. So a lease would add a negotiation the model has no use for.

A re-attacher that should not have re-attached is visible in the record instead — a second `attached` with no `detached` from the first, or a `detached` arriving after it was already superseded. Nothing prevents it by machinery; the record just shows it.

**The rule, stated once.** An instance must not claim a conversation while its own claim on it is open. In the record, that violation looks like: `attached`, `attached` from the same instance, no `detached` between. Nothing else qualifies it; nothing else excuses it.

An instance that breaks the rule forfeits its authority, at the cost
nats-spec's Conformance section states.

Compliance is not global state. Nothing publishes a verdict and nothing asks
another party for one — a reader derives it from the log it has read, like
everything else it knows. Two readers with different windows may derive
differently; neither is coordinating with the other, so there is nothing to
contradict.

It drives exactly one decision. A claim arrives for a conversation this
instance holds: it looks at its own record. If that claimer has a claim it
never released, the claim doesn't fold and this instance keeps serving. If
not, it stands down. Nothing else in the system consults conduct.

After a `detached` closes the standing claim, a new `attached` is an ordinary new claim. It may come from any instance — including the one that just released it. A closed claim leaves nothing behind to reopen, so the wire doesn't care who claims next.

So one open claim means one `attached`: an instance publishes it once, at the moment it attaches — nothing more until it detaches.

A changed `cwd` is not a new claim. It's a fact about the claim already open, so it gets its own event: `moved` (`conversation-spec.md`, Attachment).

A compliant instance watches the attachment leaf for every conversation it serves (`conversation-spec.md`, Attachment). When it sees itself displaced — another instanceId's `attached` for a conversation it holds — it stops serving and publishes `detached`.

That `detached` folds as nothing: the supersession already ended its claim. A `detached` only changes the fold when its identity — the `(world, instanceId)` pair, or bare `instanceId` if either side omits `world` — still matches the standing attachment's. An instance detaching after it's already superseded is stating a fact about its own past claim, not retracting the current one.

It publishes `detached` anyway, as the observable act of compliance — without it, a crash and a violation would be impossible to tell apart. An instance also publishes `detached` per conversation on clean exit (Ctrl-C, drain), same as today.

**Crash vs violation is derivable, never declared.** No `detached`, and dead pulses from the instance that held the claim: read as a crash. It went silent and never got the chance to release.

No `detached`, and *live* pulses from an instance that's already been superseded: read as a violation. It saw the displacement — or should have — and kept going anyway.

Neither is a state the wire declares. Both are what a consumer reads off facts it already folds: `attached`, `detached`, `pulse`.

A conversation's servicing state derives from these facts exactly as before, now read off the conversation's own tree rather than the world's:

- **alive** — attached by an instance whose pulse is fresh;
- **released** — cleanly detached (by the instanceId that held the claim);
- **stranded** — attached, and the holding instance's pulse has gone silent.

The decided/emergent line is deliberate: `detached` is a fact someone
published; stranded is inferred from a broken promise. Consumers render them
differently because they are different.

### Examples

These are concrete and orderable on purpose. They become the attachment
scenario fixtures when implementation lands (`conversation-spec.md`,
Migration note) — fix lands twice, code and fixture in the same commit, per
this repo's testing rule.

- **(a) Ordinary life.** `attached(inst-1)` → served → `detached(inst-1)`.
  One claim, opened and closed by the same instance.
- **(b) Crash and failover.** `attached(inst-1)`. inst-1's pulses stop and
  no `detached` ever comes. The fold reads inst-1 as stranded, from silence
  alone. `attached(inst-2)` supersedes it — unconditionally, whether or not
  a `detached(inst-1)` shows up later.
- **(c) Migration/takeover.** `attached(inst-1)`. While inst-1 still lives,
  `attached(inst-2)` supersedes it anyway — no precondition checks inst-1's
  liveness. inst-1 observes its own displacement and publishes
  `detached(inst-1)`, the observable act of standing down. This changes
  nothing in the fold: the claim already moved when `attached(inst-2)`
  landed.
- **(d) Abandon and re-adopt.** `attached(inst-1)` → `detached(inst-1)` →
  `attached(inst-1)` (or equally `attached(inst-2)`). Legal either way. A
  closed claim leaves nothing behind to reopen, so the next `attached` is
  an ordinary new claim, regardless of whose instanceId it carries.
  "Abandon" isn't a designed operation here — this example just shows the
  rule already covers it.
- **(e) The violation.** `attached(inst-1)`; `attached(inst-1)` again, no
  `detached` between. The same instance claims twice while its first claim
  is still open — the zombie shape the rule exists to catch. Which reading
  applies is never declared, only read off pulses after the fact: inst-1's
  pulses still live → violation (it kept claiming after something should
  have stopped it); inst-1's pulses dead → crash (the second `attached`
  never got the chance to detach either).

  Non-compliance is permanent from the second `attached` on: that event
  itself does not fold, and neither does anything inst-1 publishes after
  it, including a `detached`. The fold's standing claim stays exactly what
  the first `attached(inst-1)` left it — held, unreleased, until some other
  instance's `attached` supersedes it. inst-1 cannot detach its way back;
  only a restart, under a new instanceId, can serve this conversation
  compliantly again.

## Requests

| Request | Fields | Reply | Notes |
|---|---|---|---|
| `service` | `conversationId`, environment (`cwd`, `model`, … — an open set) | `accepted` \| `rejected` + `reason` | ensure this conversation is served in this world. One verb for spawn, resume, and takeover — the servicer reads the conversation's record and reacts; its premise is below. Any named environment value the world cannot establish rejects the request (`invalid_cwd`, for `cwd`); an omitted value falls to the world's own defaults — absence delegates, presence binds, never a silent fallback. Known reasons today: `already_attached`, `at_capacity`, `invalid` (a recognised request whose body doesn't carry what it needs, e.g. a missing or empty `conversationId`), `invalid_cwd`, `failed` (the world could not undertake the operation; the cause rides `detail`), `unsupported` |
| `drain` | — | `accepted` \| `rejected` + `reason` | stop taking work and detach cleanly: a `detached` per conversation, then silence. Distinguishes a decided shutdown from a crash |
| `chdir` | `conversationId`, `cwd` | `accepted` \| `rejected` + `reason` | move the working directory of a live attachment — Tower changing where a conversation is served without a Ctrl-C. Accept confirms the premise (this world serves the conversation), not the outcome. The move is observed, not promised: the agent publishes `attachment.moved` (`conversation-spec.md`, Attachment) when the move lands. The agent reconciles the directory and may decline to move. A move that never lands just shows as an unchanged `cwd` — an observed outcome like any other. Known reasons today: `not_found` (this world is not serving that conversation), `unsupported` |

**The premise for `service`.** Four cases, each read off a warm fold — one
that has replayed capture up to its live subscription (nats-spec, System
principles) — and a fifth that closes the list:

- Standing attachment in another world → accept and take over, unconditionally. The incumbent's liveness is irrelevant: asking a different world to serve *is* migration.
- Standing attachment in this world, holder alive on a warm read of this world's own liveness fold → `rejected: already_attached`. The goal already holds, and every instance in the world gives this same answer, so a redundant or retried request never causes a takeover.
- Standing attachment in this world, holder stranded on a warm read of that same fold → accept and take over. A dead holder never blocks pickup; the attachment is never a lease.
- No standing attachment in a warm fold → no history: spawn fresh. History: adopt.
- The fold is not warm — just booted, or a feed that has fallen behind → none of the four applies. An unobserved record is not an absent attachment, so it never reads as the case above and never spawns. A compliant instance never reaches here, because a cold one has not joined the queue group (below); one that answers anyway rejects and says why, in `reason`, which is free text and needs no new token.

`service` means "I want this serviced" — it never moves a conversation between two live instances in the same world. That would need the holder to abandon it first (an operation not designed here), or it would be a different operation on its own leaf. A live-to-live handover inside one world is out of `service`'s scope by design, not an oversight.

Two things follow from this, worth saying plainly rather than leaving a reader to derive them. Only a live instance can ever answer a `service` request — queue-group delivery finds whichever instance in the world is up right now — so the liveness question is never about the instance answering, only ever about a different instance that might be holding a stale attachment. And the liveness read at the stranded threshold is safe whichever way it lands: read as alive, the request just comes back `already_attached` and the sender retries later; read as stranded, the request takes over, and unconditional supersession is what makes that landing safe too.

This safety argument is scoped to two *warm* reads straddling the threshold — both readers have observed enough of the record to have a liveness verdict at all, and either verdict is fine. It does not extend to a cold or degraded fold: a just-booted instance, or one whose feed hasn't caught up, has not yet observed the standing attachment and owes no verdict on it (nats-spec.md, System principles). Answering `service` from such a fold — taking over a live holder because the map looked empty — is exactly the unobserved-state action that principle rules out.

The corollary: an instance does not join the world's queue group until its own folds are warm. A cold instance is not yet offering to serve, so it must not be the one a `service` request finds. A sender whose request meets no queue-group member gets NATS's own no-responder — and that honestly means the world isn't available to serve this yet, not a rejection with a reason: no new reason token is owed for it, the same way a crashed process owes no reply. The sender retries; the world answers once an instance has warmed into the group.

**cwd is intrinsic to the harness.** An agent is a harness and a model; the
model is text-in-text-out and has no filesystem, while the harness runs
somewhere and touches a directory. So a bridge agent — a harness serving
conversations over the wire — has a cwd by nature, and `chdir` is a
first-class operation, not a niche one. The rare harness with no directory
notion answers `unsupported`, the built-in escape (a harness-less "cloud
agent" is just a model, and is wrapped in your own harness before it speaks
this protocol at all). `chdir` is scoped to cwd deliberately: it is the
move-the-directory operation, reconciling and refusable, not a generic
"reconfigure" — a different environment change (a model swap) is a different
operation on its own leaf, never bundled here.

Requests address the world, never an instance; where several instances share
a world they share a queue group, so exactly one answers. Every request owes
a reply, and `unsupported` is honest compliance (conversation spec, reply
discipline). Replies confirm acceptance, never outcome: an accept is not a
promise the operation succeeds, only that its premise held and it was
undertaken. Outcomes are observable where everything else is: `attached`
here, and the conversation's own record — which is why a feasibility problem
(a directory too unreconciled to move) is not a rejection reason: it is an
outcome, shown by the fact that never changes, never a reply.

A note with teeth, from nats-spec's Authority: connection is authority, and
`service` makes a connected sender able to start work in a world. The
operational plane's strict-credentials posture is what stands between broker
access and arbitrary work placement; deployments grade accordingly. World
*creation* raises the stakes further and is deliberately not here (below).

## Named, not designed

- `status` — a point-in-time liveness read (ask now, get a pulse-shaped
  answer) for consumers that cannot replay a captured stream. Deferred until
  such a consumer exists: it needs broadcast-request semantics this concern
  does not define, and a replaying consumer bootstraps from capture instead.
- **world creation** — making a place is the layer beneath serving one: a
  host concern, with an authority question (create is code execution) that
  deserves its own pass. It gets its namespace and spec when forced — never
  by squatting here (nats-spec, Concerns).

## What consumers may assume

- Publication order per subject, and per subscription across one wildcard;
  nothing across classes.
- Liveness, existence, and strandedness are folds. Computed from `ready`,
  `pulse` (this tree) and `attached`, `detached` (conversation-spec.md,
  Attachment) — never carried as declared state. Names are free to
  generate, never free to remember: what a folding consumer retains of dead
  worlds and instances is its own retention policy, same as a stream's
  capture is its deployment's.
- Unknown event types, fields, and reason values: the tolerance rules
  (nats-spec, Evolution).

## Message schemas — normative

Same conventions as the conversation spec: zod v4, `z.looseObject`
throughout, open enums for open sets, required and optional exactly as the
schema says.

```ts
import { z } from 'zod';

/** ISO-8601 timestamp with a real UTC offset. */
const ts = z.iso.datetime({ offset: true });

const openEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).or(z.string());

/** Sender identity, as the conversation spec defines it: provenance,
 *  never enforcement; fields appear only when actually known. */
const sender = z.looseObject({
  kind: openEnum(['human', 'agent', 'orchestrator']),
  userId: z.string().optional(),
});

// Leafed classes are keyed by subject leaf: the subject selects the schema, the
// body carries no `type`. `host` is provenance about the world (a field, never
// the id); ephemeral reach-handles (pid, port, tmux coords) are not named —
// they ride as open fields under looseObject (nats-spec, Naming).

// agent.v1.{world}.telemetry.> — attachment claims are not here; their
// schema lives on the conversation's own tree (conversation-spec.md, Attachment).
export const agentTelemetry = {
  'ready': z.looseObject({ ts, instanceId: z.string(), host: z.string().optional() }),
  'pulse': z.looseObject({ ts, instanceId: z.string(), intervalS: z.number().int().positive() }),
};

// agent.v1.{world}.requests.> — a leaf not listed is still answered:
// `rejected` with reason `unsupported`.
export const agentRequest = {
  'service': z.looseObject({ ts, from: sender.optional(), conversationId: z.string(), cwd: z.string().optional(), model: z.string().optional() }),
  'drain': z.looseObject({ ts, from: sender.optional() }),
  'chdir': z.looseObject({ ts, from: sender.optional(), conversationId: z.string(), cwd: z.string() }),
};

// Replies (transport truth, never outcome). Known reasons today:
// already_attached, at_capacity, invalid, invalid_cwd, not_found, failed,
// unsupported. `detail` is optional free-text diagnostics for a human —
// `reason` is the machine-facing token a caller branches on, `detail` names
// the step and underlying error; never the other way around.
export const agentRequestReply = z.union([
  z.looseObject({ accepted: z.literal(true) }),
  z.looseObject({ rejected: z.literal(true), reason: z.string(), detail: z.string().optional() }),
]);
```

Authority is settled in `nats-spec.md`: connection is authority; `from` is
provenance, never enforcement.
