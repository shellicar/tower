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
| `turn_ended` | `queryId`, `turnId`, `stopReason` | a message stops; fires every round — mid-loop rounds end `tool_use`, `end_turn` closes the query; `cancelled` records an interruption |
| `tool_use` | `queryId`, `turnId`, `id`, `name`, `input` | `id` is the opaque tool-use id (`toolu_…`); `input` included — the action is unreviewable without the payload |
| `usage` | `queryId`, `turnId`, `service`, `model`, `inputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `outputTokens`, `costUsd` | per turn, from the model's usage reporting; a cost row names exactly what it priced, no cross-referencing |

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
| `message` | `id`, `queryId`, `role`, `from`, `content` (+ `turnId` on assistant messages) | **utterance** — the dialogue grew. `id` is the message's stable id; `role` is `user` or `assistant`; `from` is the sender identity (`{ kind: human \| agent \| orchestrator }` + id) so two `role: user` messages from different senders read apart; `content` is content blocks |
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
existed only as deltas and never enters the store; `turn_ended: cancelled` on
telemetry is its only trace.

| Event | Subject | Fields | Notes |
|---|---|---|---|
| `delta` | `deltas` | `text` | a chunk of the assistant message currently streaming; superseded by the committed `message`, which is the record. Deliberately bare — no correlation ids: deltas are purely ephemeral, and the metadata would outweigh the data by orders of magnitude |

A delta is how a message looks *while it is happening*; the committed message
is what happened. Locally-entered input commits too: a message typed at the
terminal appears on the change stream the same as one that arrived over
`requests` — half a chat is not a chat.

## Requests — `requests`

| Request | Fields | Reply | Notes |
|---|---|---|---|
| `say` | `from`, `content`, `precondition` | `accepted` + `id` \| `rejected` + `reason` | start a new query against a known state; `from` is the sender identity — locally-typed input carries `{ kind: human }` the same way, so no speaker is ever anonymous; the reply acknowledges acceptance only — the answer appears on the change stream like any other turn |
| `cancel` | `id` | `accepted` \| `rejected` + `reason` | revoke an accepted piece of state by its id — a queued message, a running query, whatever the id names. Its target *is* its premise: never "cancel whatever happens to be running". Rejection reasons are honest: `not_found`, `already_complete`, `unsupported` |

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
queries have finished means something nobody said. Two premise kinds:

- `{ tip: messageId }` — my premise is a position: that node is the tip I saw.
  Valid while it is still the tip.
- `{ after: queryId }` — my premise is an outcome: deliver when that query
  completes. Valid while the query is in flight *or* is the last completed —
  either way the outcome is the same, which is what makes it deterministic.
  Anything newer means the world moved past the premise.

A premise that no longer holds is rejected with reason `stale`, and the sender
re-decides with current knowledge — the wire's version of "actually, wait—".
Operations premised on incompatible worlds are never merged or sequenced: the
first commit moves the tree; the rest are refused with an explanation. The only
anchor-free case is the first message of a new conversation — there is no state
to have known. How the premise is encoded beyond this is deliberately
unsettled; the principle is not.

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

## Open questions

- **The parent's wire type.** A follow-up after an interrupted query could
  anchor on a message (an exact node — but revisable, and possibly the interior
  of an incomplete turn), a turn (an outcome — but a cancelled turn's outcome
  is nothing), or a query (the episode — surviving its internal changes). They
  differ exactly when things change, which is why the type is real data; wire
  encoding unruled.

Authority is settled in `nats-spec.md`: connection is authority; `from` is
provenance, never enforcement.
