# Conversation spec — v1

The conversation concern. Structure per `nats-spec.md`; namespace `conv`. Every
message here is *about* one conversation — traffic about anything else does not
belong in this tree.

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
question below). A rewind-then-say is a new query attached mid-tree; an edit
("file X" → "file Y") is a new query attached where the sender rewound to. The
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
| `conv.v1.{conversationId}.telemetry` | events | observation: turns, tools, usage — never authority |
| `conv.v1.{conversationId}.changes` | events | the committal change stream: messages, revisions, tip movements |
| `conv.v1.{conversationId}.deltas` | events | the in-progress message, chunk by chunk |
| `conv.v1.{conversationId}.requests` | requests | inbound: address the conversation |

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

Three kinds of change — a closed set of kinds, an open set of operations
within them. A change that cannot be expressed as one of these is the signal
something genuinely new needs the argument:

| Change | Fields | Notes |
|---|---|---|
| `message` | `id`, `queryId`, `turnId`, `role`, `from`, `content` | **utterance** — the dialogue grew. `id` is the message's stable id; `role` is `user` or `assistant`; `from` is the sender identity (`{ kind: human \| agent \| orchestrator }` + id) so two `role: user` messages from different senders read apart; `content` is content blocks |
| `revision` | `messageId`, `content` | **revision** — content changed under a stable id: thinking dropped, a tool result trimmed, an image resized. Carries the resulting content, never the why — policy belongs to whoever revised. The dialogue did not change; the payload did |
| `tip_moved` | `to` (a message id) | **tip movement** — rewind, fast-forward, the switch after an edit. The reflog, as events |

The folds:

- The state of a message is its **latest revision** (last-write-wins per id);
  every prior revision remains in the record because each was an occurrence.
- The state of the conversation is the latest revision of every message
  **reachable from the tip**. A snapshot (`history`) emits exactly that — two
  folds composed. Live watchers folding as they go and late joiners asking for
  a snapshot converge on the same state, by construction.

A **user edit** ("read file X" → "read file Y") is not a revision — the
dialogue changed. It is a new message and a tip movement: a new query whose
parent sits where the sender rewound to. Revisions are for changes where no
one's *words* changed; edits move the tree. The test: would a sender say the
conversation changed? An edit — yes. Trimming a tool result — no. That line is
where premises break or hold.

A **cancelled turn** commits nothing by itself: the partial assistant message
existed only as deltas and never enters the store; `turn_cancelled` on
telemetry is its only trace.

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
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"block","blockType":"thinking"}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"The file has to go — checking wha"}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"t references it first."}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"block","blockType":"text"}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"Deleting the old module — nothing"}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":" imports it any more."}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"block","blockType":"tool_use"}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"{\"files\": [\"./o"}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"ld.ts\"]}"}}
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

**The `say` message, concretely.** v1 carries text only — a plain string.
Anything richer (images, attachments) is the terminal's job for now; rich
content arrives under add-only when the content vocabulary
(`content-vocabulary.md`) gets its design pass. The committed `message` on the
change stream still carries full content blocks — the record holds what the
conversation actually contains; only the inbound ask is text-only. The premise
is encoded exactly as the preconditions section writes it: one key naming the
kind.

```json
// conv.v1.conv-abc.requests
{
  "type": "say",
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
for every reader.

## What consumers may assume

- Traffic for one conversation arrives in publication order per subject.
- **No ordering across subjects**: telemetry and commits interleave without
  guarantee; a consumer must never infer state from their relative arrival.
- The query is derived, not an event: group by `queryId`; a `turn_ended` with
  `end_turn` closes it. Idle is derived — quiet since the last event — never
  declared.

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
  no one has to read its source to know.
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

The unions are deliberately strict about the types they enumerate — a
misshaped known message must fail. Openness on the discriminator is the
**harness's routing rule**, not a schema member: a `type` not listed is
skipped, never failed (conformance.md). Do not add a catch-all variant to a
union — a misshaped known message would slide into it and pass, which is the
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

// conv.v1.{conversationId}.telemetry
export const conversationTelemetry = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('turn_started'), ts, ...turnRef, service: z.string(), model: z.string(), thinking: z.boolean(), effort: z.string().optional(), maxTokens: z.number().int() }),
  z.looseObject({ type: z.literal('turn_ended'), ts, ...turnRef, stopReason: z.string() }),
  z.looseObject({ type: z.literal('turn_cancelled'), ts, ...turnRef }),
  z.looseObject({ type: z.literal('turn_aborted'), ts, ...turnRef }),
  z.looseObject({ type: z.literal('tool_use'), ts, ...turnRef, id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
  z.looseObject({
    type: z.literal('usage'), ts, ...turnRef, service: z.string(), model: z.string(),
    inputTokens: z.number().int(), cacheCreationTokens: z.number().int(), cacheReadTokens: z.number().int(), outputTokens: z.number().int(),
    // Per-frame extras — present when the frame reported them, never synthesised:
    cacheCreation5mTokens: z.number().int().optional(),
    cacheCreation1hTokens: z.number().int().optional(),
    thinkingTokens: z.number().int().optional(),
    serverToolUse: z.record(z.string(), z.unknown()).optional(),
    // Derived by the publisher (the service reports tokens, not prices); present when computed:
    costUsd: z.number().optional(),
  }),
]);

// conv.v1.{conversationId}.changes
export const conversationChange = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('message'), ts, id: z.string(), ...turnRef, role: openEnum(['user', 'assistant']), from: sender, content: contentBlocks }),
  z.looseObject({ type: z.literal('revision'), ts, messageId: z.string(), content: contentBlocks }),
  z.looseObject({ type: z.literal('tip_moved'), ts, to: z.string() }),
]);

// conv.v1.{conversationId}.deltas — deliberately bare: the envelope's `ts` is
// waived on purpose; deltas are ephemeral and the metadata would outweigh the data.
// `block` marks the stream changing character; `blockType` is an open set
// mirroring the committed content block types.
export const conversationDelta = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('delta'), text: z.string() }),
  z.looseObject({ type: z.literal('block'), blockType: openEnum(['thinking', 'text', 'tool_use']) }),
]);

// conv.v1.{conversationId}.requests — a request whose `type` is not defined
// here is still answered: `rejected` with reason `unsupported`. Compliance is
// answering, not implementing.
export const conversationRequest = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('say'), ts, from: sender, text: z.string(), precondition: z.looseObject({ tip: z.string().nullable() }) }),
  z.looseObject({ type: z.literal('cancel'), ts, from: sender.optional(), id: z.string() }),
]);

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

## Open questions

- **The parent's wire type.** A follow-up after an interrupted query could
  anchor on a message (an exact node — but revisable, and possibly the interior
  of an incomplete turn), a turn (an outcome — but a cancelled turn's outcome
  is nothing), or a query (the episode — surviving its internal changes). They
  differ exactly when things change, which is why the type is real data; wire
  encoding unruled.

Authority is settled in `nats-spec.md`: connection is authority; `from` is
provenance, never enforcement.
