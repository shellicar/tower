# Conversation spec — v2

The conversation concern. Structure per `nats-spec.md`; namespace `conv`. Every
message here is *about* one conversation — traffic about anything else does not
belong in this tree.

v2 is the current tree. v1 — one flat subject per class, no `query` closure —
is superseded but still spoken; the differences and the migration posture are
at the end (The v1 tree).

## The entity

The **conversation** is the durable entity the agent model prescribes: the
state the agent holds, keys its audit by, and returns to on resume.
`conversationId` is the identity on the wire — pre-generatable by the creator,
surviving resume. What serves a conversation, and how that changes over time,
is not this spec's concern.

Its structure:

- **message** — one user-role or assistant message; the atomic unit. A
  message's id is stable and names the *occurrence in the dialogue*, not the
  bytes: content is revisable (see the change stream). "User-role" covers both
  what a sender said and tool results — which is why every API round is a pair.
- **turn** — one API round: a user-role message in, an assistant message out.
  `turnId` groups the pair. A turn ends with a reason; mid-query rounds end
  `tool_use`, `end_turn` closes the query.
- **query** — an ordered run of turns, closed by `end_turn` — plus its
  **parent**: the premise its `say` was accepted against. The parent is the
  precondition made structural: the tree is the record of accepted premises,
  and branching exists only where queries attach. Within a query everything is
  linear, which is why per-message parent pointers would carry no information.

**The conversation is a tree. Messages are its nodes; queries are its
branches.** Within a query each message's parent is trivially the message
before it — queries are linear segments, which is why per-message parent
pointers carry no information. The one parent that carries information is the
**query's**: where its segment attaches, which can be *any* message in the
tree — the premise its `say` was accepted against (today a message id, the tip
the sender saw; whether a parent may instead name a turn or a query is an open
question below). A rewind-then-say is a new query attached mid-tree — changing "file X" to
"file Y" is exactly that: rewind to the parent, then say the new message.
There is no "edit" operation; the tree moving is a rewind and a say. The
tree is not stored as extra structure and never travels as one — it is
derivable by any consumer from the change stream: messages plus tip movements,
the accumulated record of accepted premises.

The store is a log: every message and revision ever minted, append-only. Ids
are never invalidated; *unreachable is not deleted* (a log-structured table,
not a mutable document). The **live conversation** is the reachable set from
the current **tip**. The tip's own movements are themselves recorded changes —
the reflog — which is what makes rewind undoable: fast-forward returns to a
node unreachable from the live tree, findable only because the tip's history
was kept.

## Subjects

| Subject | Traffic | Carries |
|---|---|---|
| `conv.v2.{conversationId}.telemetry.>` | events | observation: turns, tools, usage — never authority |
| `conv.v2.{conversationId}.changes.>` | events | the committal change stream: messages, revisions, tip movements, query closures |
| `conv.v2.{conversationId}.deltas` | events | the in-progress message, chunk by chunk |
| `conv.v2.{conversationId}.requests.>` | requests | inbound: address the conversation |

**The subject spells the type** (nats-spec, Namespacing): a message's type is
the subject tokens after the class — underscores become token boundaries — so
the body does not repeat it. The one exception is `deltas`: a flat subject
carrying two shapes (`delta`, `block`) that share every policy, not a routing
axis, so the type stays in the body there as a `type` field. The full map:

| Type | Subject |
|---|---|
| `turn_started` | `conv.v2.{id}.telemetry.turn.started` |
| `turn_ended` | `conv.v2.{id}.telemetry.turn.ended` |
| `turn_cancelled` | `conv.v2.{id}.telemetry.turn.cancelled` |
| `turn_aborted` | `conv.v2.{id}.telemetry.turn.aborted` |
| `tool_use` | `conv.v2.{id}.telemetry.tool.use` |
| `usage` | `conv.v2.{id}.telemetry.usage` |
| `message` | `conv.v2.{id}.changes.message` |
| `revision` | `conv.v2.{id}.changes.revision` |
| `tip_moved` | `conv.v2.{id}.changes.tip.moved` |
| `query` | `conv.v2.{id}.changes.query` |
| `delta`, `block` | `conv.v2.{id}.deltas` — flat, deliberately |
| `say` | `conv.v2.{id}.requests.say` |
| `cancel` | `conv.v2.{id}.requests.cancel` |

`deltas` stays a single subject, decided not forgotten: nobody filters `delta`
from `block`, the stream is meaningful only whole and in order, and the
payloads are deliberately bare — a token per chunk kind fails nats-spec's
token-depth test.

## Telemetry and commit

Two streams, two natures — the WAL is not the table:

- **`telemetry` is observation.** In flight, possibly ahead of the
  truth. Nothing on it constitutes state; "sending m7 to the API" is an
  attempt, not a fact about the conversation.
- **The change stream is committal.** An entry means one thing: the state
  owner has persisted this; the conversation now contains it. Published after
  the fact, never speculatively. Appearance here *is* the definition of "in
  the conversation" — the record constitutes the state, and only this record.

The two may legitimately disagree in the moment — a cancelled turn leaves a
full telemetry trail and zero commits. That gap is necessary: a system that
could only attempt what it had already committed could never act.

## Telemetry — `telemetry`

Envelope per the master spec: `type`, `ts`. The table lists the fields each
event adds.

Events stand alone — the NATS grain: subject filtering and retention mean no
consumer can be required to fold from history, so every event carries the ids
that place it. `queryId` names the query (the id `say` returned, or one the
implementation mints for locally-typed input); `turnId` names the turn within
it. Derived state — the query fold, idle — is something a consumer *may*
compute, never something it must.

| Event | Fields | Notes |
|---|---|---|
| `turn_started` | `queryId`, `turnId`, `service`, `model`, `thinking`, `effort`, `maxTokens` | a message begins; fires every round of the loop. Carries the request's inputs as asked — `usage` later carries what was reported back; if they differ (model fallback), the record shows it. `service` names what was called — e.g. the Anthropic Messages API — not which model answered |
| `turn_ended` | `queryId`, `turnId`, `stopReason` | the model stopped its message; fires every round — mid-loop rounds end `tool_use`, `end_turn` closes the query. `stopReason` is the service's own value, passed through verbatim — never synthesised: a turn that was cancelled or failed did not *end*, and gets its own event below |
| `turn_cancelled` | `queryId`, `turnId` | the turn was terminated intentionally — a `cancel` was accepted; someone decided |
| `turn_aborted` | `queryId`, `turnId` | the attempt failed — service error, broken stream; potentially transient. Distinct from `turn_cancelled` because the two imply different follow-ups |
| `tool_use` | `queryId`, `turnId`, `id`, `name`, `input` | `id` is the opaque tool-use id (`toolu_…`); `input` included — the action is unreviewable without the payload |
| `usage` | `queryId`, `turnId`, `service`, `model`, `inputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `outputTokens` (+ optional: `cacheCreation5mTokens`, `cacheCreation1hTokens`, `thinkingTokens`, `serverToolUse`, `costUsd`) | **per usage frame, not per turn** — a turn may report usage more than once (the service reports at message start and again in the closing delta, and the two legitimately differ); each event carries what its frame reported, never a synthesis of frames. Optional fields appear when the frame reported them — report what you know, fabricate nothing. `costUsd` is derived by the publisher, not reported by the service; it appears when computed, and consumers summing cost must not assume one row per turn |

**Tool approvals are not conversation traffic.** An approval is an
authorization exchange between the serving process and whatever holds
authority over it — a property of the process's policy regime, not of the
dialogue (change the permissions, restart, and the same tool call raises no
approval; the conversation is byte-identical). It belongs to the process
concern, designed in its own pass. Its consequences reach the conversation the
only way anything does — as content: an approved tool is implicit (the tool
ran, so it was not denied); a denied tool appears as whatever the agent model
commits so the model can see it. The conversation is stateless: nothing is
signalled to the model by event, ever — it is put into the conversation. Which
is why "does it go into the conversation" classifies nothing: it measures
where consequences land, not what owns the thing.

## The change stream — `changes`

Four kinds of change — a closed set of kinds, an open set of operations
within them. A change that cannot be expressed as one of these is the signal
something genuinely new needs the argument (the fourth, `query`, arrived by
exactly that argument):

| Change | Fields | Notes |
|---|---|---|
| `message` | `id`, `queryId`, `turnId`, `role`, `from`?, `content` | **utterance** — the dialogue grew. `id` is the message's stable id; `role` is `user` or `assistant`; `from` is the sender identity (`{ kind: human \| agent \| orchestrator }` + id) so two `role: user` messages from different senders read apart — **absent for a `tool_result`**: it is the mechanical delivery of a tool's output, not an utterance, and nobody sent it, so nothing is fabricated to fill the slot (correction, 19 Jul 2026 — it previously carried `from: {kind: agent}`, wrongly); `content` is content blocks |
| `revision` | `messageId`, `content` | **revision** — the content under a stable id changed: a trim, a resize, or the words themselves rewritten. Carries the resulting content, never the why — the record carries effects, never reasons |
| `tip_moved` | `to` (a message id) | **tip movement** — the tip pointer moved: rewind, fast-forward. The reflog, as events |
| `query` | `queryId`, `reason` | **query closure** — the query will grow no further; the record now contains everything it will ever contain. `reason` is the system's own vocabulary, an open set under add-only: `completed` (closed by `end_turn`), `cancelled` (a `cancel` was accepted), `aborted` (the attempt failed and the servicer gave the query up). Committal like every change: published after the closing fact is in the record, never speculatively |

The folds:

- The state of a message is its **latest revision** (last-write-wins per id);
  every prior revision remains in the record because each was an occurrence.
- The state of the conversation is the latest revision of every message
  **reachable from the tip**. A snapshot (`history`) emits exactly that — two
  folds composed. Live watchers folding as they go and late joiners asking for
  a snapshot converge on the same state, by construction.

### Query closure — why it is a change

Whether a query is finished is a fact only the state owner holds: it decides
not to run another round, or accepts the cancel, or gives the attempt up.
Consumers could previously only *derive* closure from telemetry — branching
on a verbatim, open-set `stopReason`, on the observation plane, with no
signal at all on the cancelled and aborted paths. The `query` change is that
fact published once, where the answer already lives: a sender that said
something and wants the reply subscribes `changes.>`, collects its query's
messages, and is done when the closure arrives — one subscription, every
ending covered.

**Revision and tip movement are two orthogonal mechanisms, not two
categories the spec assigns.** `revision` changes the content under a stable
id; `tip_moved` moves the tip. A change may do one, the other, or both — and
nothing on the wire distinguishes "trimming a tool result" from "going back
and rewriting what was said." Both are the same operation: new content under
the same id. The difference is the reviser's reason, and reason is not on the
wire — the spec cannot enforce one reading over another, and does not try.

What this means for a reader: fold the revision. The conversation *is* what
the record says after folding — there is no "what was really said" outside
the store to be true or false against (the record constitutes the state). A
reader working from a stale copy answers from a word that is no longer there,
confidently and wrongly; the only defence is to read the current record, not
reason about it. This is exactly why `revision` is a first-class committal
change and not a footnote: a reader that misses it renders the old word
under a conversation that now holds a new one.

A **cancelled turn**'s assistant message never commits: it existed only as
deltas and never enters the store; `turn_cancelled` on telemetry is its
trace. The user-role half — the `say` that opened the query — is the
implementation's declaration: commit it or not, the record is the answer (see
Implementation details). **Not committing it is the recommended declaration**:
a cancel revokes the say, not just the turn it started — committing the user
half leaves a message its sender revoked in the conversation and moves the
tip under them, so the released premise is no longer the tip they knew.
Scenario 2's fixture captures the recommended shape. The *query* it ended,
though, closed — and closure is committal: a `query` change with reason
`cancelled` records it.

| Event | Subject | Fields | Notes |
|---|---|---|---|
| `delta` | `deltas` | `text` | a chunk of whatever the stream is currently emitting; superseded by the committed `message`, which is the record. Deliberately bare — no correlation ids: deltas are purely ephemeral, and the metadata would outweigh the data by orders of magnitude |
| `block` | `deltas` | `blockType` | the stream changed character: the deltas that follow are `thinking`, `text`, or `tool_use` — an open set, mirroring the committed message's content block types. As bare as the deltas it introduces |

**Why a marker, not typed deltas.** The assistant emits *one* token stream,
in order; the blocks are transitions marked within it — markup over a single
stream, not parallel channels. A delta is therefore always the same thing —
the next chunk of that stream — and the only additional fact is what the
stream is currently emitting, which changes at block boundaries, not per
chunk. Order carries the structure: traffic for one conversation arrives in
publication order per subject (see What consumers may assume), so a `block`
marker always precedes the deltas it describes. No index, no per-chunk type:
the evidence on the wire is strictly sequential blocks, and anything more is
machinery for an interleave that does not occur.

Worked stream — a turn that thinks, speaks, then calls a tool (the
`tool_use` deltas stream the input JSON as it forms, fragment by fragment,
exactly as the service emits it):

```jsonl
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"block","blockType":"thinking"}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"delta","text":"The file has to go — checking wha"}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"delta","text":"t references it first."}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"block","blockType":"text"}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"delta","text":"Deleting the old module — nothing"}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"delta","text":" imports it any more."}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"block","blockType":"tool_use"}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"delta","text":"{\"files\": [\"./o"}}
{"subject":"conv.v2.conv-abc.deltas","message":{"type":"delta","text":"ld.ts\"]}"}}
```

Tolerance does the compatibility work in both directions: a consumer that
predates `block` skips it (unknown type) and sees exactly what it saw before
— text deltas; a consumer that joins mid-turn renders deltas as text until
the first marker corrects it — an acceptable imperfection for an ephemeral
display the committed message supersedes. A producer that never emits
`block` (today's) remains compliant: the marker is additive.

A delta is how a message looks *while it is happening*; the committed message
is what happened. Locally-entered input commits too: a message typed at the
terminal appears on the change stream the same as one that arrived over
`requests` — half a chat is not a chat.

## Requests — `requests`

| Request | Fields | Reply | Notes |
|---|---|---|---|
| `say` | `from`, `text`, `precondition` | `accepted` + `id` \| `rejected` + `reason` | start a new query against a known state; `from` is the sender identity — locally-typed input carries `{ kind: human }` the same way, so no speaker is ever anonymous; the reply acknowledges acceptance only — the answer appears on the change stream like any other turn |
| `cancel` | `id` | `accepted` \| `rejected` + `reason` | revoke an accepted piece of state by its id — in v1, a running query; whatever kinds acceptance creates later. Its target *is* its premise: never "cancel whatever happens to be running". Rejection reasons are honest: `not_found`, `already_complete`, `unsupported` |

**The `say` message, concretely.** It carries text — a plain string — plus
optionally `attachments` (below), which arrived under add-only exactly as
promised; fully general rich content still waits on the content vocabulary
(`content-vocabulary.md`) design pass. The committed `message` on the change
stream carries full content blocks — the record holds what the conversation
actually contains. The premise is encoded exactly as the preconditions
section writes it: one key naming the kind.

```json
// conv.v2.conv-abc.requests.say
{
  "ts": "2026-07-07T17:20:04+10:00",
  "from": {
    "kind": "human",
    "userId": "stephen"
  },
  "text": "okay, delete it",
  "precondition": {
    "tip": "m4"
  }
}
// reply → { "accepted": true, "id": "q7" }
//       | { "rejected": true, "reason": "stale" }
```

**`from` is pass-through provenance.** The sender supplies it; a servicer
echoes what the sender sent and never authors it. Everything except `kind` is
optional — a publisher states only what it actually knows, and fabricating the
rest is non-compliant. `{ "kind": "human" }` alone is valid: it is exactly what
a terminal that knows a human typed — but not which human — publishes. The
worked example above shows a sender that did know its `userId`; that field is
illustrative, not required.

**`attachments`** — optional; files riding with the say. Bytes never travel
on a subject (the broker's payload limit alone forbids it): the sender puts
them in the deployment's transit object store first and the say carries
reference blocks, API-shaped with an `object` source:

```json
{
  "ts": "2026-07-07T17:20:04+10:00",
  "from": { "kind": "human" },
  "text": "what does this diagram show?",
  "attachments": [
    { "type": "image",
      "source": { "type": "object", "id": "att-7c9e…", "bucket": "attach", "mediaType": "image/png", "size": 48213 } }
  ],
  "precondition": { "tip": "m4" }
}
```

The servicer resolves at request-build: fetch the object at its own edge,
inline the bytes for the model. The **committed message carries the
reference block verbatim, never the bytes** — the record stays light and
wire-legal. The store is transit, not storage: ids are opaque and
short-lived, and bytes are the servicer's private state once fetched.
`source.bucket` names the store the object actually landed in — the block
carries it, not deployment config, so a servicer never has to guess which
bucket a sender it doesn't control used; a block minted before this field
existed falls back to the servicer's own configured default.

Failure means two different things depending on when it happens. An object
that no longer resolves while **replaying already-committed history** — an
adopted conversation past the transit window — is expected ageing, and
renders in the request as a stated placeholder (media type and size, from
the block itself); the record still holds the block, and the repair is
re-attaching. Unknown `source.type` values get the same placeholder
treatment — source kinds are an open set (`base64` beside `object` would be
add-only). But an attachment that fails to resolve among the **fresh
blocks riding THIS say** is never ageing — it means the object the sender
just referenced genuinely isn't there. That is not a placeholder case: the
say itself rejects, same reply shape as a stale precondition, rather than
let the model see a placeholder in place of what the sender actually
attached.

Two candidates follow from this design and are named, not designed:

- `revise` — the trim operation generalised: any bridge agent revisable over
  the wire, same preconditions and reply discipline; the policy (what to trim,
  thresholds, protected tail) stays with the requester.
- `history` — the snapshot as an optimisation of the fold, for late joiners
  and transfer; its reply shape is per-model-kind (the architecture's
  `HistorySnapshot`).

### Preconditions

Every operation is decided against a known state, and carries that state as a
typed premise — **required**, not optional. An unanchored mutation is
timing-dependent nondeterminism: a delayed "hello world" arriving after five
queries have finished means something nobody said. One premise kind in v1:

- `{ tip: messageId | null }` — my premise is a position: that node is the tip
  I saw. `null` is the position "nothing exists yet" — the first message of a
  new conversation states it explicitly rather than omitting the premise.
  Valid while it is still the tip.

A premise that no longer holds is rejected with reason `stale`, and the sender
re-decides with current knowledge — the wire's version of "actually, wait—".
Operations premised on incompatible worlds are never merged or sequenced: the
first commit moves the tree; the rest are refused with an explanation. There is
no anchor-free case: even the first message of a new conversation carries its
premise — `{ tip: null }`, the claim that nothing exists — and it is enforced
like any other: a `tip: null` say against a non-empty conversation is `stale`.

**The spec never requires acceptance; it limits it.** Rejecting everything is
lawful — internal state is the servicer's, which is the whole point. What a
compliant servicer must not do:

- accept an operation whose premise does not hold (`stale`);
- hold more than one **live** acceptance against the same premise — accepting
  two says premised on the same tip is the two-sender fabrication the premise
  exists to kill, and the rule covers the accepted-but-uncommitted window that
  stale-checking alone cannot. A cancelled or aborted acceptance releases its
  premise.

**Queueing is deliberately not in v1** — and the complexity is not the queue,
it is that this is *chat*. Queued messages have conversational semantics:
consecutive user messages merge or stay distinct (and the render already
flattens them for the API, so which happened must stay visible in the record);
a queued reply's meaning shifts as answers land ahead of it; two queued
messages may deserve one query or two; cancelling one out of a batch has to
mean something. Every one of those is a real decision about what a
conversation *is*, not a scheduling detail. So v1's affordance is
cancel-then-send, exactly the local TUI's semantics: a `say` against the tip
while a query runs is rejected (that premise has a live acceptance); cancel
the query and the premise frees. Queueing, if ever wanted, arrives as a new
premise kind under add-only — a real design pass, not a side effect.

An accepted premise does not evaporate: it becomes the new query's **parent**.
The tree is the accumulation of accepted premises.

Acceptance creates state, and state gets an id: every `accepted` reply carries
the `id` of what was accepted, which is what makes it cancellable. There is no
blanket cancel — in a distributed system that is a different concept (*stop*:
stop everything), and it is not conversation traffic; it belongs to whatever
owns the thing being stopped.

Every request owes a reply; an implementation that does not support an
operation replies `rejected` with reason `unsupported` — compliance is
answering, not implementing. The reply confirms acceptance, never outcome. A
sender that wants the answer subscribes to the change stream — one mechanism
for every reader; the `query` closure says when the answer is complete.

## What consumers may assume

- Traffic for one conversation arrives in publication order per subject, and
  in publication order across one subscription: a single `changes.>`
  subscription sees all change kinds in order (nats-spec, Subscription
  discipline). Fold consumers subscribe `{class}.>`, never a set of sibling
  leaves — a partial change stream is corrupted state, and a sibling-set
  subscriber is silently blind to leaves added later.
- **No ordering across classes**: telemetry and commits interleave without
  guarantee; a consumer must never infer state from their relative arrival.
- The query fold groups by `queryId`; its committal end is the `query`
  closure on `changes`. Deriving an ending from telemetry (`turn_ended` +
  verbatim `stopReason`) remains lawful observation, never authority. Idle is
  derived — quiet since the last event — never declared.

## Implementation details — deliberately not contract

The boundary: the conversation is what the change stream says it is — not what
the implementation happens to do. The conversation is a generic structure that
can be committed to: it *influences* behaviour, it does not define it. An
agent that finds a broken position at its tip — an unanswered tool_use, an
incomplete turn — decides for itself what to do about it (re-execute, roll
back, refuse), and declares the outcome by what it commits. These are each
implementation's own, made visible by its commits rather than specified:

- Whether the user-role half of a cancelled turn is committed. The
  implementation declares by committing or not; the record is the answer, and
  no one has to read its source to know. Not committing is recommended — the
  cancel revokes the say, not just the turn (see The change stream).
- What is actually sent to the model. The request is a *rendering* of the
  reachable state — what the builder ships, and any presentation-time
  transformation, is between the agent and its model.
- Revision policy — what gets trimmed, when, by what thresholds. The change
  stream carries effects, never reasons.

## Message schemas — normative

The tables above narrate; this section defines. Every message on this concern's
subjects must validate against its schema here — required and optional is
exactly what the schema says (`.optional()` and nothing else). Written as zod
(v4); the conformance JSON Schema artifacts are generated from these via
`z.toJSONSchema`, so prose and artifact cannot drift. `z.looseObject`
throughout is the tolerance rule as code: unknown fields pass (add-only).
`reason` strings are an open set — the values named are the ones defined
today; consumers tolerate others.

Each schema is strict about its own fields — a misshaped known message must
fail. Routing is by subject, not a `type` member: the leaf selects the schema
(the keyed records below), and a leaf not listed is skipped, never failed
(conformance.md). `deltas` is the one flat subject, so its two shapes are a
`type`-discriminated union — the discriminator lives in the body there, the
single place the subject does not spell it. Do not add a catch-all schema — a
misshaped known message would slide into it and pass, the
leniency-conceals-divergence bug in schema form.

```ts
import { z } from 'zod';

/** ISO-8601 timestamp with a real UTC offset (e.g. 2026-07-07T21:00:00+10:00). */
const ts = z.iso.datetime({ offset: true });

/** The tolerance rule for enums: the listed values are the ones defined
 *  today; an unknown value still validates (a closed enum here would make
 *  every addition a breaking change — the POC's closed-enum defect). */
const openEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).or(z.string());

/** Sender identity. `userId` appears only when the publisher actually knows
 *  it — never fabricated. A local CLI knows a human typed, not which human:
 *  it publishes `{ kind: 'human' }` bare. `from` is provenance, never
 *  enforcement (nats-spec). */
const sender = z.looseObject({
  kind: openEnum(['human', 'agent', 'orchestrator']),
  userId: z.string().optional(),
});

/** Content blocks are the agent model's own; opaque typed blocks pending the
 *  content vocabulary's design pass. */
const contentBlocks = z.array(z.looseObject({ type: z.string() }));

const turnRef = { queryId: z.string(), turnId: z.string() };

// Leafed classes are keyed by subject leaf (the tokens after the class): the
// subject selects the schema, and the body carries no `type`.

// conv.v2.{conversationId}.telemetry.>
export const conversationTelemetry = {
  'turn.started': z.looseObject({ ts, ...turnRef, service: z.string(), model: z.string(), thinking: z.boolean(), effort: z.string().optional(), maxTokens: z.number().int() }),
  'turn.ended': z.looseObject({ ts, ...turnRef, stopReason: z.string() }),
  'turn.cancelled': z.looseObject({ ts, ...turnRef }),
  'turn.aborted': z.looseObject({ ts, ...turnRef }),
  'tool.use': z.looseObject({ ts, ...turnRef, id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  'usage': z.looseObject({
    ts, ...turnRef, service: z.string(), model: z.string(),
    inputTokens: z.number().int(), cacheCreationTokens: z.number().int(), cacheReadTokens: z.number().int(), outputTokens: z.number().int(),
    // Per-frame extras — present when the frame reported them, never synthesised:
    cacheCreation5mTokens: z.number().int().optional(),
    cacheCreation1hTokens: z.number().int().optional(),
    thinkingTokens: z.number().int().optional(),
    serverToolUse: z.record(z.string(), z.unknown()).optional(),
    // Derived by the publisher (the service reports tokens, not prices); present when computed:
    costUsd: z.number().optional(),
  }),
};

// conv.v2.{conversationId}.changes.>
export const conversationChange = {
  'message': z.looseObject({ ts, id: z.string(), ...turnRef, role: openEnum(['user', 'assistant']), from: sender.optional(), content: contentBlocks }),
  'revision': z.looseObject({ ts, messageId: z.string(), content: contentBlocks }),
  'tip.moved': z.looseObject({ ts, to: z.string() }),
  'query': z.looseObject({ ts, queryId: z.string(), reason: openEnum(['completed', 'cancelled', 'aborted']) }),
};

// conv.v2.{conversationId}.deltas — the one flat subject: `delta` and `block`
// share it, so the type lives in the body here, the single place the subject
// does not spell it. `ts` is waived — deltas are ephemeral and the metadata
// would outweigh the data.
export const conversationDelta = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('delta'), text: z.string() }),
  z.looseObject({ type: z.literal('block'), blockType: openEnum(['thinking', 'text', 'tool_use']) }),
]);

// conv.v2.{conversationId}.requests.> — a leaf not listed is still answered:
// `rejected` with reason `unsupported`. Compliance is answering, not implementing.
export const conversationRequest = {
  'say': z.looseObject({
    ts, from: sender, text: z.string(),
    // Reference blocks only — bytes never ride a subject. source.type is an
    // open set; unresolvable sources render as stated placeholders.
    attachments: z.array(z.looseObject({
      type: z.string(),
      source: z.looseObject({ type: z.string(), id: z.string(), mediaType: z.string().optional(), size: z.number().int().optional() }),
    })).optional(),
    precondition: z.looseObject({ tip: z.string().nullable() }),
  }),
  'cancel': z.looseObject({ ts, from: sender.optional(), id: z.string() }),
};

// Replies (transport truth, never outcome). Known reasons today:
// stale, not_found, already_complete, unsupported.
export const requestReply = z.union([
  z.looseObject({ accepted: z.literal(true), id: z.string().optional() }),
  z.looseObject({ rejected: z.literal(true), reason: z.string() }),
]);
```

One deliberate asymmetry, so it is not read as an omission: `cancel.from` is
optional because provenance travels when known; the `id` is the cancel's
premise and is always required. `say.precondition` has no such asymmetry — it
is always required; the first message of a new conversation states
`{ tip: null }` rather than omitting it.

## The v1 tree — superseded, still spoken

v1 differs in shape, not vocabulary: one flat subject per class
(`conv.v1.{id}.changes`, `.telemetry`, `.deltas`, `.requests`), routing by
the payload's `type` alone, and no `query` closure change. Every other
message shape is identical to v2.

v1 speakers remain lawful for as long as they exist — a breaking change is a
new tree and migration is unhurried (nats-spec, Evolution). Skew is absorbed
by the single-instance component: a reader serving both trees subscribes to
both, normalises at ingest (subject tokens where the tree is deep, payload
`type` where it is flat — the same discriminator either way), and answers
each conversation's requests on the tree its traffic arrives on. The v1
fixtures remain the v1 ingest path's test surface until the last v1 speaker
retires — they retire with v1, not with v2's arrival.

## Open questions

- **The committal grain of tool results: message or content.** A turn ending
  in ten parallel tool_uses settles piecewise — five results exist while five
  still run — and the `message` change can only commit the settled whole (a
  half-answered results message is as invalid as a bare tool_use). A finer
  change kind — content blocks committed into a message id incrementally —
  would emit each result when known. Either way this is a **durability**
  question, not correctness, which is why the finer grain would be optional:
  the servicer owns local conversation state, and recovery is a
  reconciliation against the published record with two shapes. Recovered
  *ahead* of what was published: publish what you know — the record catches
  up. Recovered *behind* what was published: either reconcile local state up
  to the record, or fix the record (a tip movement, a revision) to where you
  actually are. Both are lawful today; the grain only changes how large the
  gap can grow. Resolve when a parallel-tool implementation forces it.
- **The parent's wire type.** A follow-up after an interrupted query could
  anchor on a message (an exact node — but revisable, and possibly the interior
  of an incomplete turn), a turn (an outcome — but a cancelled turn's outcome
  is nothing), or a query (the episode — surviving its internal changes). They
  differ exactly when things change, which is why the type is real data; wire
  encoding unruled.

Authority is settled in `nats-spec.md`: connection is authority; `from` is
provenance, never enforcement.
