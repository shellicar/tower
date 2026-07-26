# Agent spec — v1

The agent concern: who is serving conversations, and where. Structure per
`nats-spec.md`; namespace `agent`. Every message here is *about* one world —
the environment conversations are served from — never about a conversation's
content: kill the process, restart it, and not one conversation wire fact
changes. Attachment — which instance is serving which conversation — is a
conversation fact, not a world fact, and its wire shape lives on the
conversation's own tree (`conversation-spec.md`, Attachment); this spec
states the model an instance conducts itself by.

## The entity

The subject's id names a **world**: a placement domain — a machine, a
container — the environment conversations are served *from*. Worlds are
durable names for places; the processes standing in them are disposable.

- **world** — the addressable entity. `mac`, `pc`, a generated container
  world id. Deployer-chosen, never centrally registered; a creator generates
  a fresh world id per container exactly as it pre-generates a
  conversationId.
- **agent instance** — one process currently serving a world. Identified by
  `instanceId` in payloads, never in subjects: address a process and you
  inherit its lifecycle (nats-spec, first principle). A restarted bridge is a
  new instance in the same world — it resubscribes, and the world's address
  never changed.

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

Attachment claims are not here — a conversation's attachment is about the
conversation, not the world, and lives on its own tree
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

**Attachment is singular.** `attached` claims "this conversation is served
here, by me, now" — always one claim, never a set. A new `attached`
unconditionally supersedes whatever attachment stood before it, in any world,
from any instance: the superseded attachment stops contributing to every
derivation — liveness, cwd, existence — the instant the new one lands. There
is no stale precondition on `attached` and nothing to negotiate: publishing
it never asks permission, and supersession does the rest. Failover (the old
instance went silent, a new one adopts) and migration (the old instance is
fine, something decided to move the conversation) are the same ordinary
operation seen from different causes — the wire carries one operation
either way.

Fencing and leases are deliberately not here. A spec can state what a
compliant instance does; it cannot make a malfunctioning one behave by
designing around it, and trying to buys only complexity — a lease adds a
negotiation the model has no use for, since there is never a legitimate case
for two instances serving one conversation at once (that is a deployment's
race, not a wire state). A re-attacher that should not have re-attached is
visible in the record — a second `attached` with no `detached` from the
first, or a `detached` arriving after it was already superseded — not
prevented by machinery.

**An instanceId's claim lifecycle is linear: one `attached`, one `detached`,
nothing between.** `attached` is published *exactly once* per claim — there
is no legitimate re-publish, qualified or not. A rule that allows "a second
`attached` is a violation, except when it carries new information" is not a
rule: every zombie re-attach is one parameter tweak away from looking
compliant, and the conformance check (two `attached` for one conversation
from one `instanceId` with no intervening `detached`) stops being
checkable. A changed `cwd` is not a new claim — it is a fact about the
claim already standing, and gets its own event on the same leaf family:
`moved` (`conversation-spec.md`, Attachment), valid only from the standing
instance. new-process-equals-new-`instanceId` (this spec, The entity) means
the only process that could ever legitimately touch an existing claim is the
same still-running process, and now it has an event scoped to exactly what
it is doing (moving cwd) rather than a reason to re-assert the whole claim.

A compliant instance watches the attachment leaf (`conversation-spec.md`,
Attachment) for every conversation it serves. On seeing itself displaced —
another instanceId's `attached` for a conversation it holds — it stops
serving that conversation and publishes `detached`. This folds as nothing:
the supersession already ended its claim, and a `detached` changes the fold
only when its instanceId still matches the *standing* attachment (an
instance detaching after it has already been superseded is stating a fact
about its own past claim, not retracting the current one). It exists anyway,
as the observable act of compliance — the difference between a crash and a
violation is otherwise undecidable. An instance also publishes `detached`
per conversation it serves on clean exit (Ctrl-C, drain), same as today.

**Crash vs violation is derivable, never declared.** No `detached` plus dead
pulses from the instance that held the claim reads as a crash — it went
silent and never got the chance to release. No `detached` plus *live*
pulses from an instance that has been superseded and is still publishing as
though it serves the conversation reads as a violation — it saw the
displacement (or should have) and kept going anyway. Neither is a state the
wire declares; both are what a consumer reads off the same facts (`attached`,
`detached`, `pulse`) it already folds.

A conversation's servicing state derives from these facts exactly as before,
now read off the conversation's own tree rather than the world's:

- **alive** — attached by an instance whose pulse is fresh;
- **released** — cleanly detached (by the instanceId that held the claim);
- **stranded** — attached, and the holding instance's pulse has gone silent.

The decided/emergent line is deliberate: `detached` is a fact someone
published; stranded is inferred from a broken promise. Consumers render them
differently because they are different.

## Requests

| Request | Fields | Reply | Notes |
|---|---|---|---|
| `service` | `conversationId`, environment (`cwd`, `model`, … — an open set) | `accepted` \| `rejected` + `reason` | ensure this conversation is served in this world. One verb for spawn, resume, and takeover — the servicer reads the conversation's record and reacts, and the premise check is instance-local, never a liveness read on anyone else: already attached **to this instance** → `rejected: already_attached` (the request is redundant, nothing to do); attached to any *other* instance, whether that instance is live or stranded → accept and take over unconditionally — asking a second world or instance to serve a conversation already served elsewhere *is* the deliberate migration path, and whether the incumbent is still alive is irrelevant to the premise; no history → start fresh; history and no attachment → fold and re-attach. Known reasons today: `already_attached`, `at_capacity`, `unsupported` |
| `drain` | — | `accepted` \| `rejected` + `reason` | stop taking work and detach cleanly: a `detached` per conversation, then silence. Distinguishes a decided shutdown from a crash |
| `chdir` | `conversationId`, `cwd` | `accepted` \| `rejected` + `reason` | move the working directory of a live attachment — Tower changing where a conversation is served without a Ctrl-C. Accept confirms the premise (this world serves the conversation), not the outcome: the move is observed, not promised — the agent publishes `attachment.moved` (`conversation-spec.md`, Attachment) when the move lands. The agent reconciles the directory and may decline to move; a move that never lands shows as an unchanged `cwd`, an observed outcome like any other. Known reasons today: `not_found` (this world is not serving that conversation), `unsupported` |

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
- Liveness, existence, strandedness are folds — computed from `ready`,
  `pulse` (this tree) and `attached`, `detached` (conversation-spec.md,
  Attachment); never carried as declared state. Names
  are free to generate, never free to remember: what a folding consumer
  retains of dead worlds and instances is its own retention policy, exactly
  as a stream's capture is its deployment's.
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
// already_attached, at_capacity, not_found, unsupported.
export const agentRequestReply = z.union([
  z.looseObject({ accepted: z.literal(true) }),
  z.looseObject({ rejected: z.literal(true), reason: z.string() }),
]);
```

Authority is settled in `nats-spec.md`: connection is authority; `from` is
provenance, never enforcement.
