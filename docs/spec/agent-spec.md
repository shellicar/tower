# Agent spec — v1

The agent concern: who is serving conversations, and where. Structure per
`nats-spec.md`; namespace `agent`. Every message here is *about* one world —
the environment conversations are served from — never about a conversation's
content: kill the process, restart it, and not one conversation wire fact
changes. This is the conversation spec's Environment rule seen from the other
side — the attachment-telemetry home that section reserved.

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
| `agent.v1.{world}.telemetry.>` | events | servicing facts: ready, pulse, attachments |
| `agent.v1.{world}.requests.>` | requests | operations on the world's servicing |

The subject spells the type, as in the conversation spec: `telemetry.pulse`,
`requests.service`.

| Type | Subject |
|---|---|
| `ready` | `agent.v1.{world}.telemetry.ready` |
| `pulse` | `agent.v1.{world}.telemetry.pulse` |
| `attached` | `agent.v1.{world}.telemetry.attached` |
| `detached` | `agent.v1.{world}.telemetry.detached` |
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
| `attached` | `instanceId`, `conversationId`, `cwd`, `tip`?, `intervalS`? | this instance is serving this conversation. What makes a conversation exist for observers before its first message. `tip`, when carried, is the conversation's current tip at the moment of attachment — same shape as a say's own premise (`z.string().nullable()`, `null` for a conversation with nothing in it yet) — so an observer knows where the conversation stands without replaying its own change stream first; this is what lets a party other than the servicer address a `say` at a conversation it never spawned, migrated or otherwise, without asking it to publish its history first. Optional, like `intervalS`: backward compatible with producers that don't yet carry it — its absence is not a claim the conversation is empty, only that this attach didn't state it. May carry `intervalS` (optional, backward compatible with producers that don't yet) so a fresh attachment can have a liveness basis immediately; when absent, the fold below has a default so the gap doesn't read as permanently alive |
| `detached` | `instanceId`, `conversationId` | released, deliberately — Ctrl-C, drain, done. A decided fact; a crash publishes nothing |

**Liveness is a fold, never declared.** An instance is presumed gone after
about three of its own declared intervals of silence — judged against its own
promise, nobody else's; the spec mandates no cadence. **No declared interval
yet is not the same as alive**: an attachment (or a pulse) that has never
carried `intervalS` still needs a verdict, so a consumer applies a flat
default silence threshold (60s is this spec's suggested default — deployments
may choose their own) until a real promise arrives. Found in the field 19 Jul
2026: without this, an instance that attaches and dies before ever pulsing
reads as alive forever, because "no promise" and "definitely alive" collapsed
into the same fold outcome. A conversation's state derives:

- **alive** — attached by an instance whose pulse is fresh;
- **released** — cleanly detached;
- **stranded** — attached, and the instance's pulse has gone silent.

The decided/emergent line is deliberate: `detached` is a fact someone
published; stranded is inferred from a broken promise. Consumers render them
differently because they are different.

Environment facts ride these events as fields — published when known, never
fabricated, ignored when unrecognised. Two kinds, kept apart by what they
denote (nats-spec, Naming):

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

## Requests

| Request | Fields | Reply | Notes |
|---|---|---|---|
| `service` | `conversationId`, environment (`cwd`, `model`, … — an open set) | `accepted` \| `rejected` + `reason` | ensure this conversation is served in this world. One verb for spawn, resume, and takeover — the servicer reads the conversation's record and reacts: no history → start fresh; history and no live attachment → fold and re-attach; already attached → `rejected: already_attached`. Known reasons today: `already_attached`, `at_capacity`, `unsupported` |
| `drain` | — | `accepted` \| `rejected` + `reason` | stop taking work and detach cleanly: a `detached` per conversation, then silence. Distinguishes a decided shutdown from a crash |
| `chdir` | `conversationId`, `cwd` | `accepted` \| `rejected` + `reason` | move the working directory of a live attachment — Tower changing where a conversation is served without a Ctrl-C. Accept confirms the premise (this world serves the conversation), not the outcome: the move is observed, not promised — the agent re-publishes `attached` with the new `cwd` when it lands, folded last-write-wins. The agent reconciles the directory and may decline to move; a move that never lands shows as an unchanged `cwd`, an observed outcome like any other. Known reasons today: `not_found` (this world is not serving that conversation), `unsupported` |

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
  `pulse`, `attached`, `detached`; never carried as declared state. Names
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

// agent.v1.{world}.telemetry.>
export const agentTelemetry = {
  'ready': z.looseObject({ ts, instanceId: z.string(), host: z.string().optional() }),
  'pulse': z.looseObject({ ts, instanceId: z.string(), intervalS: z.number().int().positive() }),
  'attached': z.looseObject({ ts, instanceId: z.string(), conversationId: z.string(), cwd: z.string().optional(), tip: z.string().nullable().optional(), intervalS: z.number().int().positive().optional() }),
  'detached': z.looseObject({ ts, instanceId: z.string(), conversationId: z.string() }),
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
