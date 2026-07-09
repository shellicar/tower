# Approval spec — v1

The approval concern. Structure per `nats-spec.md`; namespace `approval`. An
approval is an **authorization exchange**: a bridge agent, about to act, asks
whatever holds authority over it — *may I do this?* — and waits.

## The entity

The **approval request** is the entity: a piece of accepted-unresolved state
with its own id, a lifecycle (raised → settled), and state an answer changes.
It is raised by the agent's own permission model and belongs to it.

Two definitional boundaries, both about what a consumer may assume:

- **Identity is its own.** The approval id is minted by the agent's approval
  model. It *may* coincide with a tool-use id — an agent whose model maps one
  tool call to one decision can lawfully mint them equal — but it is defined
  independently, and a consumer treats any coincidence as coincidence. The
  granularity of asking is the model's: one tool call may raise several asks
  (a pipeline whose delete step asks while its read steps pass), or none.
- **Lifetime is its own.** An approval may in practice die with its process —
  or the agent may persist it and re-raise under the same id after a restart.
  Both are lawful; the id is defined independently of any process, and the
  agent declares its model by what it publishes. A dead holder answers
  nothing; `not_found` and silence are honest outcomes.

Approvals are **not conversation traffic** (see `conversation-spec.md`): the
same tool call raises an ask under one permissions regime and none under
another, while the conversation stays byte-identical. Consequences reach the
conversation the only way anything does — as content: approved is implicit in
the tool having run; denied appears as whatever the agent model commits.

## Subjects

| Subject | Traffic | Carries |
|---|---|---|
| `approval.v1.{approvalId}.lifecycle` | events | `raised`, `settled` — the exchange itself; operational, not telemetry |
| `approval.v1.{approvalId}.requests` | requests | the answer |
| `approval.v1.{approvalId}.telemetry` | events | `heartbeat` — the pending ask's own pulse (~15s while pending) |

Discovery is the namespace wildcard: `approval.v1.*.lifecycle` — every ask,
fleet-wide, one subscription. That serves a live watcher (a notifier); the
late joiner who wants "what is outstanding *right now*" reconstructs it — see
**The outstanding set** below.

The pulse passes the severability test, which is why it is telemetry: remove
it and answering, settlement, and the record all still work — only the passive
watcher's staleness inference goes dark. A watcher folds one subscription:
*raised + pulse = pending; pulse silence = stale, display as void; settled =
done.* The ask asserts its own liveness, whoever holds it — an agent that
persists asks across a restart resumes pulsing the same id, and watchers never
know the holder changed.

**Liveness is never inferred from broker interest.** A NATS request to a
dead holder's `requests` subject may fail fast as *no responders* — but that
reflects subject interest, not the holder's presence, and any legitimate
observer subscribed across `.requests` destroys the signal. Observation must
never change semantics. The answerer's transport truths are a reply or a
timeout; the watcher's staleness signal is the pulse; nothing finer exists.

Two amortisations were considered and declined for v1, knowingly:

- **One heartbeat per process** (the old run model): every ask would carry its
  holder's id and every watcher would join two concerns to read one — the
  cross-subject dependence the NATS grain forbids — and the inference lies in
  exactly the case the definitions above make legal: a persisted ask surviving
  a restart reads as void when its old holder goes silent. The saving is
  negligible at any realistic scale — pendings are handfuls, minutes long.
- **One heartbeat per group** (`approval.v1.{groupId}.{approvalId}`):
  amortisation inside the concern, no cross-concern join — the honest middle.
  It adds a subject level, which moves every token after it and breaks every
  existing wildcard — so adopting it later is a new tree, which the versioning
  model handles unhurriedly. Not needed at v1 traffic.

## The exchange

The raise is an event; the answer is the request/response; the settlement is
an event. Nothing is held open on the bus — the waiting is the agent's own
state, so an ask can pend for an hour at no cost to anything.

**`raised`** — the ask. Carries a human-reviewable payload (an ask is
unreviewable without it) and correlation to the work it interrupts. The ask
has its own `type` — the discriminator of what kind of ask this is, and so of
the fields it carries: a `tool_use` ask carries `name` and `input`; future
kinds carry their own. Ask types are an open set under add-only — a reviewer
that does not know a type still shows the raise and its correlation:

```json
// approval.v1.apr-9f3.lifecycle
{
  "type": "raised",
  "ts": "2026-07-07T15:02:11+10:00",
  "ask": {
    "type": "tool_use",
    "name": "DeleteFile",
    "input": {
      "content": {
        "type": "files",
        "values": [
          "./old.ts"
        ]
      }
    }
  },
  "correlation": {
    "conversationId": "conv-abc",
    "queryId": "q7",
    "turnId": "t12",
    "toolUseId": "toolu_01ABC"
  }
}
```

Correlation fields appear when they apply; an ask outside any tool call
carries what it has.

**`answer`** — the RPC. The verdict is the request's content; the reply is
transport truth, never verdict:

```json
// approval.v1.apr-9f3.requests
{
  "type": "answer",
  "ts": "2026-07-07T15:03:38+10:00",
  "from": {
    "kind": "human",
    "userId": "stephen"
  },
  "approved": true
}
// reply → { "accepted": true }
//       | { "rejected": true, "reason": "already_settled" | "not_found" }
```

`from` — and `by` on `settled` — is pass-through provenance, same rule as the
conversation spec: the answerer supplies what it actually knows, the holder
echoes it and never authors it. `{ "kind": "human" }` alone is valid; the
`userId` in the examples is illustrative, not required.

First valid answer wins; `already_settled` is first-wins made honest.
`not_found` means the holder does not know the id — it died and its model
dropped pendings, or the id never existed; either way the answer has nowhere
to land, and the reply says so.

**`settled`** — the outcome, carrying who acted, so every other reviewer's
view clears and shows whose decision it was:

```json
{
  "type": "settled",
  "ts": "2026-07-07T15:03:40+10:00",
  "approved": true,
  "by": {
    "kind": "human",
    "userId": "stephen"
  }
}
```

## Intentionally simple — the surface is the intended direction

The ask's payload is deliberately primitive so this spec is implementable
today: a `tool_use` ask ships the raw tool input. That reads well exactly when
the reviewer happens to know the tool — a file list under DeleteFile reads as
"these will die" only through tool knowledge, and tools are each bridge
agent's own, unknowable to a renderer written independently. Raw input is the
degraded view, accepted knowingly.

The currently intended direction is `content-vocabulary.md`'s split: **input
→ tool → surface → renderer**. The tool produces a *surface* — a
self-sufficient artifact (content, content type, operation) — and the
renderer implements the standard per type, never knowing the tool: a file
list typed as files renders as files (links, even); an edit's surface is its
diff. The ask then carries the surface like any other occasion that shows one
— approval being the occasion where faithful rendering matters most, not a
different kind of rendering. Richer ask payloads arrive as new ask types
under add-only — no change to this spec's structure.

## Message schemas — normative

The exchange above narrates; this section defines. Required and optional is
exactly what the schema says. Same conventions as `conversation-spec.md`'s
schema section: zod (v4), conformance JSON Schemas generated via
`z.toJSONSchema`, `z.looseObject` as the add-only tolerance rule, `reason`
strings an open set. As there, the unions are strict about known types;
skipping unknown `type`s is the harness's routing rule, never a catch-all
schema member — a catch-all would let misshaped known messages pass. (The
`ask` union's `unknownAsk` is different on purpose: ask types are add-only
*data inside* a known message, so an unknown ask must validate.)

```ts
import { z } from 'zod';

const ts = z.iso.datetime({ offset: true });

/** Enum tolerance, as in the conversation spec: listed values are the ones
 *  defined today; an unknown value still validates. */
const openEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).or(z.string());

/** Sender identity — same shape and same rule as the conversation spec:
 *  `userId` only when actually known, never fabricated. */
const sender = z.looseObject({
  kind: openEnum(['human', 'agent', 'orchestrator']),
  userId: z.string().optional(),
});

/** Ask types are an open set under add-only. `tool_use` is defined today; a
 *  reviewer that does not know a type still shows the raise and its
 *  correlation. */
const toolUseAsk = z.looseObject({ type: z.literal('tool_use'), name: z.string(), input: z.record(z.string(), z.unknown()) });
const unknownAsk = z.looseObject({ type: z.string() });
const ask = z.union([toolUseAsk, unknownAsk]);

/** Correlation fields appear when they apply; an ask outside any tool call
 *  carries what it has. */
const correlation = z.looseObject({
  conversationId: z.string().optional(),
  queryId: z.string().optional(),
  turnId: z.string().optional(),
  toolUseId: z.string().optional(),
});

// approval.v1.{approvalId}.lifecycle
export const approvalLifecycle = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('raised'), ts, ask, correlation: correlation.optional() }),
  z.looseObject({ type: z.literal('settled'), ts, approved: z.boolean(), by: sender }),
]);

// approval.v1.{approvalId}.telemetry
export const approvalTelemetry = z.looseObject({ type: z.literal('heartbeat'), ts });

// approval.v1.{approvalId}.requests
export const approvalRequest = z.looseObject({ type: z.literal('answer'), ts, from: sender, approved: z.boolean() });

// Reply — transport truth, never verdict. Known reasons today:
// already_settled, not_found.
export const answerReply = z.union([
  z.looseObject({ accepted: z.literal(true) }),
  z.looseObject({ rejected: z.literal(true), reason: z.string() }),
]);
```

## The approval model is the agent's — deliberately not contract

The spec carries asks, answers, and settlements. Everything else belongs to
the agent's own approval model, declared by what it publishes rather than
specified:

- what raises an ask, and at what granularity;
- whether pending asks survive a restart;
- what an approval or denial means for the tool's execution.

Who may answer is authority, settled in `nats-spec.md`: connection is
authority; `from` is provenance, never enforcement.

## The outstanding set

A late joiner reconstructs what is pending with machinery already defined —
no further design needed:

- **The fold**: replay `lifecycle` — raised without settled is the candidate
  set. Replay alone cannot tell pending from pending-whose-holder-died, so:
- **The pulse confirms**: listen one heartbeat interval — candidates that
  pulse are live; the rest display as void. Even without replay, every live
  ask self-announces within one interval of joining.

Whether replay is *available* is deployment configuration, per the master
spec's storage rule: a deployment that captures `lifecycle` gets late-joiner
discovery as a JetStream read; one that captures nothing has live-watching
only, and made that choice. The spec defines the fold; it never depends on the
capture.

The sliver that stays open: historical liveness — "was that candidate live
*at 14:02*" needs pulses from that moment, and pulses are telemetry a
deployment typically leaves uncaptured. Forensics-grade; nobody's use case
today.
