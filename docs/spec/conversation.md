# Conversation spec — v2

The conversation concern. Structure per `nats.md`; namespace `conv`. Every
message here is *about* one conversation — traffic about anything else does not
belong in this tree.

v2 is the current tree. v1 (one flat subject per class, no `query` changes,
neither start nor closure) is superseded but still spoken; the differences and the migration posture are
at the end (The v1 tree).

## The entity

The **conversation** is the durable entity the agent model prescribes: the
state the agent holds, keys its audit by, and returns to on resume.
`conversationId` is the identity on the wire — pre-generatable by the creator,
surviving resume. What serves a conversation, and how that changes over time,
is not this spec's concern.

Its structure:

- **message** — one message, in a role the `message` schema names (an open
  set; see Message schemas); the atomic unit. A message's id is stable and
  names the *occurrence in the dialogue*, not the bytes: content is revisable
  (see the change stream). The user role holds both what a sender said and
  what the harness adds there, such as tool results and reminders.
- **turn** — one API round: what was sent to the API and what came back.
  Every message belongs to one turn, the round it first appears in: sent new
  in it, or returned by it. What is sent new is the user-role messages and
  any system message; what comes back is the assistant's reply. `turnId`
  groups them. A turn ends with a reason — `tool_use` for a round
  that calls a tool, `end_turn` for one that stops — and that reason is
  observation: the model's own word for why it stopped, never the query's
  ending.
- **query** — an ordered run of turns, announced by the `query.started`
  change and closed by the `query.closed` change on `changes` (see Query
  start and closure) — plus its **parent**: the id of the message the query
  attaches after, the premise its `say` was accepted against. The parent is
  the precondition made structural: the tree is the record of accepted
  premises, and branching exists only where queries attach. Within a query
  everything is linear, which is why per-message parent pointers would carry
  no information.

**The conversation is a tree. Messages are its nodes; queries are its
branches.** Within a query each message's parent is trivially the message
before it — queries are linear segments, which is why per-message parent
pointers carry no information. The one parent that carries information is the
**query's**: where its segment attaches, which can be *any* message in the
tree — the premise its `say` was accepted against, the tip the sender saw. It
names a message, and it travels on `query.started`, stated when the query
starts. A rewind-then-say is a new query attached mid-tree — changing "file X" to
"file Y" is exactly that: rewind to the parent, then say the new message.
There is no "edit" operation; the tree moving is a rewind and a say. The
tree is not stored as extra structure and never travels as one — it is
derivable by any consumer from the change stream: messages, query starts and
tip movements, the accumulated record of accepted premises.

**The parent belongs to the query, not to each message.** A parent on every
message is only needed for a branch *inside* a query, and nothing observed
needs one. Adding per-message parents later would be an extension: every
record written with query parents stays valid, and the per-message parents it
lacks follow from order. Taking them away later would not be.

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
| `conv.v2.{conversationId}.changes.>` | events | the committal change stream: messages, revisions, tip movements, query starts and closures |
| `conv.v2.{conversationId}.attachment.>` | events | who is serving this conversation, now — see Attachment |
| `conv.v2.{conversationId}.deltas` | events | the in-progress message, chunk by chunk |
| `conv.v2.{conversationId}.requests.>` | requests | inbound: address the conversation |

**`attachment` is its own leaf family, not a fifth `changes` kind.** It is
named as functionality: the claim *does* something (it says who serves this
conversation), the same way `changes` and `requests` are named for what
they do.

It's deliberately not folded under `changes`. Agent ephemera — a process
attaching, detaching, migrating — is not history, and must never touch the
history/staleness stream `changes` drives.

It's deliberately not called `telemetry` either. This is a claim with
consequences (agent.md, Attachment), not observation a consumer may
discard.

**The subject spells the type**: a message's type is the subject tokens
after the class — underscores become token boundaries — so the body does not
repeat it. The one exception is `deltas`: a flat subject carrying two shapes
(`delta`, `block`) that share every policy, not a routing axis, so the type
stays in the body there as a `type` field. The full map:

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
| `query_started` | `conv.v2.{id}.changes.query.started` |
| `query_closed` | `conv.v2.{id}.changes.query.closed` |
| `query` | `conv.v2.{id}.changes.query`: the closure's old name, read and never published again (Query start and closure) |
| `attached` | `conv.v2.{id}.attachment.attached` |
| `moved` | `conv.v2.{id}.attachment.moved` |
| `detached` | `conv.v2.{id}.attachment.detached` |
| `delta`, `block` | `conv.v2.{id}.deltas` — flat, deliberately |
| `say` | `conv.v2.{id}.requests.say` |
| `cancel` | `conv.v2.{id}.requests.cancel` |
| `chdir` | `conv.v2.{id}.requests.chdir` |

`deltas` stays a single subject, decided not forgotten: nobody filters `delta`
from `block`, the stream is meaningful only whole and in order, and the
payloads are deliberately bare — a token per chunk kind fails nats.md's
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

The two may legitimately disagree in the moment — a cancelled turn can leave
a full telemetry trail and zero commits. That gap is necessary: a system that
could only attempt what it had already committed could never act.

## Telemetry — `telemetry`

Envelope per nats.md: `type`, `ts`. The table lists the fields each event
adds.

Events stand alone — the NATS grain: subject filtering and retention mean no
consumer can be required to fold from history, so every event carries the ids
that place it. `queryId` names the query (the id `say` returned, or one the
implementation mints for locally-typed input); `turnId` names the turn within
it. Derived state — the query fold, idle — is something a consumer *may*
compute, never something it must.

| Event | Fields | Notes |
|---|---|---|
| `turn_started` | `queryId`, `turnId`, `service`, `model`, `thinking`, `effort`, `maxTokens` | a message begins; fires every round of the loop. Carries the request's inputs as asked — `usage` later carries what was reported back; if they differ (model fallback), the record shows it. `service` names what was called — e.g. the Anthropic Messages API — not which model answered |
| `turn_ended` | `queryId`, `turnId`, `stopReason` | the model stopped its message; fires every round — mid-loop rounds end `tool_use`, a closing round ends `end_turn`. That is the model's own word for why it stopped, never the query's ending: closure is the `query.closed` change on `changes` (this spec, Query start and closure), and reading an ending off this event is lawful observation, never authority. `stopReason` is the service's own value, passed through verbatim — never synthesised: a turn that was cancelled or failed did not *end*, and gets its own event below |
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
exactly that argument). The query kind has two operations, its start and its
closure, each on its own leaf under `changes.query`:

| Change | Fields | Notes |
|---|---|---|
| `message` | `id`, `queryId`, `turnId`, `role`, `from`?, `content`, `kind`?, `fields`?, `audience`?, `userContent`?, `scope`?, `at`? | **utterance** — the dialogue grew. `id` is the message's stable id; `role` is an open set whose known values the `message` schema lists (see Message schemas); `from` says who wrote the message: a human, an agent or an orchestrator (something outside the conversation that acts on it), as `{ kind: human \| agent \| orchestrator }` + id, so two `role: user` messages written by different authors read apart. A message nobody wrote, one the harness generated, has no `from`: a tool result, a system message, a reminder (context the harness adds in the user role, not something the user said). Nothing is fabricated to fill the slot (correction, 19 Jul 2026: a tool result previously carried `from: {kind: agent}`, wrongly); `content` is content blocks. `kind` and the fields after it describe an extra message (Extra messages, below); plain chat carries none of them |
| `revision` | `messageId`, `content` | **revision** — the content under a stable id changed: a trim, a resize, or the words themselves rewritten. Carries the resulting content, never the why — the record carries effects, never reasons |
| `tip_moved` | `to` (a message id) | **tip movement** — the tip pointer moved: rewind, fast-forward. The reflog, as events |
| `query_started` | `queryId`, `parent`? | **query start**: a query has begun, and its messages attach after `parent`. `parent` is the id of the message the query attaches after. For a query a `say` opened, it is the message that say's premise names (its `precondition.tip`). `parent` is optional: a start without one means the query follows the tip. Published before any of the query's messages, so a consumer can place each message as it streams. Optional: a publisher that never announces a start stays compliant, and a query with no `query_started` follows the tip, as every query did before this change existed (Query start and closure) |
| `query_closed` | `queryId`, `reason` | **query closure** — the query will grow no further; the record now contains everything it will ever contain. `reason` is the system's own vocabulary, an open set under add-only: `completed` (the servicer ran its last round and chose not to run another), `cancelled` (a `cancel` was accepted), `aborted` (the attempt failed and the servicer gave the query up). Committal like every change: published after the closing fact is in the record, never speculatively |
| `query` | `queryId`, `reason` | the closure's old name, the same fields and meaning as `query_closed`. Consumers read it; publishers never publish it again (Query start and closure) |

**Envelope provenance: `instanceId` rides beside `from`, never inside it.**
Every change event carries the publishing instance's id as envelope
metadata — the same standing as `ts`, not a content field.

`from` is who said it, forwarded verbatim from the sender. `instanceId` is
which agent instance published the change, always the servicer's own,
never forwarded. The two answer different questions and must not collapse
into one.

Required of every compliant publisher. The schema marks it `.optional()`
only for producers that predate this rule — add-only tolerance, not
licence: a new publisher carries it.

A zombie instance publishing after it was superseded (agent.md,
Attachment) still carries a legitimate `from` — a human really did say
it — but a wrong `instanceId`. For a producer that carries the field, this
is what makes the two-agents case reconstructible from the record instead
of merely suspected. A producer that omits it leaves that reconstruction
undone, same as any other fact never stated.

The folds:

- The state of a message is its **latest revision** (last-write-wins per id);
  every prior revision remains in the record because each was an occurrence.
- The state of the conversation is the latest revision of every message
  **reachable from the tip**. A snapshot (`history`) emits exactly that — two
  folds composed. Live watchers folding as they go and late joiners asking for
  a snapshot converge on the same state, by construction.

### Extra messages: `kind` and `fields`

An extra message is any message beyond plain chat (a prompt, a reply, a tool
exchange): something the harness adds that the model is sent, the person is
shown, or both. A reminder, a subagent's hand-back, the notice that a task
finished, an interrupt marker, a compaction, the line that ends a turn, an
API error. It is a `message` like any other, with the same id, query, turn
and order, and it carries these optional fields beside `content`:

- `kind`: what the message is, an open string. The kinds below are the ones
  defined today.
- `fields`: the values the message was made from, an object. A publisher
  sends `fields` with every `kind`, `{}` when the kind has none. The kind
  selects the `fields` schema the way a subject leaf selects a message schema
  (`messageKindFields`, Message schemas): the `fields` of a kind listed there
  validate against its schema, and a kind not listed is skipped, never failed.
- `audience`: `{ model, user }`, two booleans: whether the model is sent the
  message, and whether the person is shown it. Absent means both.
- `userContent`: content blocks to show the person in place of `content`,
  when the two differ. `content` stays what the model is sent, or, for a
  message the model is not sent, what the person is shown.
- `scope`: `{ replaces: "before", except: [message ids] }`. From this message
  on, the model is no longer sent the messages before it, except the ones
  `except` names. `except` may name messages that were never published.
- `at`: the time the harness recorded for what the message was made from.
  `ts` stays the time of publishing.
  <!-- TODO(claude): undecided: whether `at` stays its own field or the
  harness's time replaces `ts`. Its own field for now. -->

A consumer that does not know a message's `kind` reads it by the fields
every extra carries: it shows the message to the person unless
`audience.user` is `false`, and shows `userContent` when there is one, else
`content`. A consumer that knows the kind renders it from `fields` in its own
way. A value of the wrong shape in any of these fields is read as absent
(conformance.md: strictness lives in tests).

<!-- TODO(claude): undecided: `audience` restates what each declared kind
already implies (the table below gives every kind one audience), which the
rule that a message's type is stated once counts against. It is sent with
every kind for now, so a consumer that does not know the kind can still
apply the reading rule above. -->

The kinds defined today. Every field in `fields` is optional unless marked
required; a publisher leaves out a value it could not read.

| `kind` | `role` | `audience` | `from` | `fields` | `content`, `userContent` |
|---|---|---|---|---|---|
| `turn-finished` | `system` | person only | absent | `durationMs` (required): how long the turn ran; `endedAt`: when it ended | `content`: the line as text |
| `interrupted` | `user` | both | absent | `during`: `turn` \| `tool-use` (open), what the interrupt cut short | `content`: the marker text the model is sent; `userContent`: a short line for the person |
| `tool-call-note` | `user` | both | absent | `reason`: `incomplete` \| `interrupted` \| `result-missing` \| `denied` \| `skipped` (open), why a tool call has no ordinary result | as `interrupted` |
| `api-error` | `assistant` | person only | absent | `error`: the service's error class; `status`: the HTTP status | `content`: the error text |
| `no-response` | `assistant` | model only | absent | none | `content`: the text the model is sent as its own earlier turn |
| `task-finished` | `user` | both | `orchestrator` | `taskId`, `toolUseId` (the tool call that started the task), `status`: `completed` \| `failed` (open), `summary`, `name`, `durationMs`, `toolUses`, `tokens` | `content`: the notice the model is sent; `userContent`: a one-line summary |
| `subagent-report` | `user` | both | `agent` | `agentType`: the kind of agent that sent it | `content`: the report the model is sent |
| `compaction` | `user` | both | absent | `trigger`: `auto` \| `manual` (open); `durationMs`, `preTokens`, `postTokens`; `preservedIds`: the ids `scope.except` names | `content`: the summary the model is sent from here on; carries `scope` |
| `date` | `user` \| `system` | model only | absent | `date`: the date the model is told, `YYYY-MM-DD` | `content`: the reminder the model is sent |
| `total-tokens-reminder` | `user` \| `system` | model only | absent | `tokensLeft`: the count the model is told | as `date` |

<!-- TODO(claude): undecided: `from` on `task-finished` is `orchestrator`,
while the `message` row above says a message the harness generated has no
`from`. Orchestrator for now. -->
<!-- TODO(claude): undecided: `from` on `subagent-report` is `{ kind: agent }`
bare, with no id naming which agent. Bare for now. -->
<!-- TODO(claude): undecided: `endedAt` on `turn-finished` holds the same time
as the message's `at`, and `preservedIds` on `compaction` the same ids as
its `scope.except`. Both are sent for now. -->

A reminder (context the harness sends the model) may carry a `kind` this
table does not list: the harness's own name for that reminder, with
`audience` model only and `fields` `{}`. A consumer reads it by the rule
above.
<!-- TODO(claude): undecided: whether reminder kinds are an open set named by
the harness, as now, or one declared kind (`reminder`) with the harness's
name in `fields`. Open set for now; this table cannot list them. -->

### Query start and closure

**Why the closure is a change.** Whether a query is finished is a fact only
the state owner holds: it decides not to run another round, or accepts the
cancel, or gives the attempt up. Consumers could previously only *derive*
closure from telemetry — branching on a verbatim, open-set `stopReason`, on
the observation plane, with no signal at all on the cancelled and aborted
paths. The `query.closed` change is that fact published once, where the
answer already lives: a sender that said something and wants the reply
subscribes `changes.>`, collects its query's messages, and is done when the
closure arrives — one subscription, every ending covered.

**Why the start is a change.** Without it, the parent is implicit: no
committed change says where a query attaches, only the `say`'s
`precondition.tip` does, and a request is not the record. A consumer could
not tell a query that continues the conversation from one that branches off
an earlier point. The closure alone comes too late to carry the parent: by
the time it arrives, the query's messages have already streamed with nothing
to place them. So the parent is announced when the query starts, on its own
change, before any of the query's messages. `tip_moved` keeps its own job, a
move of the tip on its own, such as a rewind.

A query with no `query.started` follows the tip: its first message attaches
after whatever the tip is when that message commits, which is how every
query attached before `query.started` existed. That keeps publishers that
never announce a start compliant, and every record they left readable.
`parent` is an optional field of `query.started`: a start without one means
the query follows the tip, the same as a query with no start.

What a consumer does with a `parent` naming a message it does not hold, and
whether a start whose `parent` is not the current tip moves the tip, are not
yet specified (Open questions).

**The closure's old name.** The closure was published as `changes.query`
before the start existed. That leaf stays in v2 as the closure's old name:
consumers read it forever, because stored history and publishers not yet
updated carry it, and fold it exactly as `query.closed`. It is never
published again. A consumer that predates the rename skips `query.closed` as
an unknown leaf (tolerance), so it sees no closure from a publisher that has
moved to the new name. A subscriber to exactly `changes.query`, rather than
`changes.>`, likewise sees none.

```json
// conv.v2.conv-abc.changes.query.started
{ "ts": "2026-07-07T21:00:00+10:00", "instanceId": "inst-1a2f", "queryId": "q2", "parent": "m4" }
// conv.v2.conv-abc.changes.query.closed
{ "ts": "2026-07-07T21:00:30+10:00", "instanceId": "inst-1a2f", "queryId": "q2", "reason": "completed" }
// conv.v2.conv-abc.changes.query.started, no parent: the query follows the tip
{ "ts": "2026-07-07T21:01:00+10:00", "instanceId": "inst-1a2f", "queryId": "q3" }
```

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

A **cancelled turn**'s assistant message is the implementation's
declaration: it may commit what it had written when the cancel landed, or
leave it as deltas that never enter the store — the record is the answer (see
Implementation details). Either way, `turn_cancelled` on telemetry is the
cancel's trace. The user-role half — the `say` that opened the query — is the
implementation's declaration too: commit it or not, the record is the answer.
**Not committing the user-role half is the recommended declaration**: a
cancel revokes the say, not just the turn it started — committing the user
half leaves a message its sender revoked in the conversation and moves the
tip under them, so the released premise is no longer the tip they knew.
Scenario 2's fixture captures the recommended shape for the user-role half,
with no assistant commit; scenario 2c's captures an implementation that
commits the partial assistant message. The *query* it ended, though, closed
— and closure is committal: a `query.closed` change with reason `cancelled`
records it.

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

## Attachment — `attachment`

Who is serving this conversation, now. This is the wire shape of the claim
agent.md's Attachment section conducts itself by — read that section
first for the model (singular, unconditionally superseding, no fencing).
This section only covers the shape on this tree.

| Event | Fields | Notes |
|---|---|---|
| `attached` | `instanceId`, `world`?, `cwd`?, `tip`?, `intervalS`? | this instance is serving this conversation, now. Supersedes whatever attachment stood before it, unconditionally, exactly once per claim (agent.md, Attachment). This is what makes a conversation exist for observers before its first message. `tip`, when carried, is the conversation's tip at the moment of attachment — same shape as a say's own premise (`z.string().nullable()`, `null` for an empty conversation) — so an observer knows where the conversation stands without replaying the change stream first. `world` is required of every compliant publisher (below); `cwd` and `intervalS` are optional for backward compatibility, and their absence is not a claim the value is empty — only that this attach didn't state it. `intervalS`, when carried, is at most 600 (ten minutes), the same liveness promise a pulse makes and bounded for the same reason (agent.md, Telemetry): the bound is validity, not a cap, so a larger value makes the event invalid whole |
| `moved` | `instanceId`, `world`?, `cwd` | a fact about the standing attachment, not a new claim: the working directory changed under it (the wire outcome of a `chdir` request, this spec, Requests). Valid only from the instance identity — `(world, instanceId)`, or bare `instanceId` if either side omits `world` — the fold currently holds as standing. Folds last-write-wins onto the held attachment's `cwd` |
| `detached` | `instanceId`, `world`? | released — Ctrl-C, drain, done, or a displaced instance's observable act of standing down. Changes the fold only when its identity matches the *standing* attachment's, same rule as `moved`. A crash publishes nothing |

**`world` is required of every compliant publisher.** Same tolerance as
envelope `instanceId` (this spec, The change stream): the schema marks it
`.optional()` only for producers that predate this rule — add-only
tolerance, not licence. Reason: instance identity is the pair
`(world, instanceId)` (agent.md, The entity), so both the liveness
join and the standing-instance gate compare the pair. An `attached` without
`world` names only half an identity.

**Two mechanisms, two guarantees — keep them apart.** One subject per
conversation gives every `attached` claim a total order: whichever
`attached` published last on this subject is standing. That holds from any
world, any instance, with no cross-world timestamp comparison needed
(agent.md, What consumers may assume). This is why attachment could not
stay on the world's tree — two worlds' clocks are not one order.

That ordering only settles who is standing. It doesn't make `moved` and
`detached` safe to fold — that's the standing-instance gate's job (the
Event table above). Each carries its own identity, the `(world,
instanceId)` pair; a fold applies it only when that pair matches the one
currently held. If either side omits `world`, the gate falls back to bare
`instanceId`: degraded, not broken.

A `moved` or `detached` from any other instance is a stale fact about a
superseded claim. It's harmless because the gate discards it — not because
the subject ordered it correctly.

**`world` and `instanceId` are provenance fields, never address.** Neither
names this subject — the conversation does. A consumer that wants to know
which world or instance holds the standing attachment reads it off the
latest `attached` fact, the same way it reads `cwd`. It never derives
standing from where the message came from.

```json
// conv.v2.conv-abc.attachment.attached
{ "ts": "2026-07-25T14:02:00+10:00", "instanceId": "inst-1a2f", "world": "mac", "cwd": "~/repos/tower", "tip": "m12", "intervalS": 30 }
// conv.v2.conv-abc.attachment.moved
{ "ts": "2026-07-25T14:06:00+10:00", "instanceId": "inst-1a2f", "world": "mac", "cwd": "~/repos/tower/mvp" }
// conv.v2.conv-abc.attachment.detached
{ "ts": "2026-07-25T14:10:00+10:00", "instanceId": "inst-1a2f", "world": "mac" }
```

## Requests — `requests`

| Request | Fields | Reply | Notes |
|---|---|---|---|
| `say` | `from`, `text`, `precondition` | `accepted` + `id` \| `rejected` + `reason` | start a new query against a known state; `from` is the sender identity — locally-typed input carries `{ kind: human }` the same way, so no speaker is ever anonymous; the reply acknowledges acceptance only — the answer appears on the change stream like any other turn. A holder that has published `unavailable` rejects it with reason `unavailable` (agent.md, Telemetry) |
| `cancel` | `id` | `accepted` \| `rejected` + `reason` | revoke an accepted piece of state by its id — in v1, a running query; whatever kinds acceptance creates later. Its target *is* its premise: never "cancel whatever happens to be running". Rejection reasons are honest: `not_found`, `already_complete`, `unsupported` |
| `chdir` | `cwd` | `accepted` \| `rejected` + `reason` | this conversation is served at this directory from now on. The request states that effect and never a mechanism: a servicer may move a process, or hold `cwd` as a value per conversation, and both conform. Accept confirms the premise (this servicer holds this conversation), never the outcome — the move is observed on `attachment.moved` when it lands, and one that never lands shows as an unchanged `cwd`, an observed outcome like any other. The servicer reconciles the directory and may decline to move. A harness with no directory notion answers `unsupported`. A servicer that is in the middle of a query and can't move now answers `busy`; the sender can send it again when the query ends. Known reasons today: `unsupported`, `busy` |

**Why `chdir` addresses the conversation.** It changes one conversation's
state, so it goes to the conversation (core.md, "Work is addressed to the
work, never the worker"). On the world's tree the queue group hands it to an
arbitrary instance, and every reply a non-holder could give is false — it
cannot accept what it does not serve, and its `not_found` says only that
*it* isn't serving it. On this tree only the holder subscribes, so the
request reaches the one party that can act, and there is no `not_found` to
give: no responder means nobody is serving this conversation, the same
signal as everywhere else. Operations on a world's serving capacity
(`service`, `drain`) stay on the world; operations on a conversation come
here.

**The `say` message, concretely.** It carries text — a plain string — plus
optionally `attachments` (below), which arrived under add-only exactly as
promised; fully general rich content still waits on the content vocabulary
(`content.md`) design pass. The committed `message` on the change
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
them in the deployment's transit store first and the say carries
reference blocks, API-shaped with an `object` source. A file becomes part of
the conversation only when the servicer commits the say as a message: the
file is stored in the durable store, and the committed message carries a
reference block of the same shape naming the durable store and that object
(Transit and durable object stores):

```json
// conv.v2.c7547187-3d91-40da-8c69-99fa278d9da3.requests.say
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
// conv.v2.c7547187-3d91-40da-8c69-99fa278d9da3.changes.message: the say, committed
{
  "ts": "2026-07-07T17:20:05+10:00",
  "instanceId": "inst-1a2f",
  "id": "m5", "queryId": "q7", "turnId": "t3",
  "role": "user",
  "from": { "kind": "human" },
  "content": [
    { "type": "image",
      "source": { "type": "object", "id": "c7547187-3d91-40da-8c69-99fa278d9da3/9232cd6f-1267-4094-b722-fe8e2a9aec87", "bucket": "durable", "mediaType": "image/png", "size": 48213 } },
    { "type": "text", "text": "what does this diagram show?" }
  ]
}
```

The bucket names `attach` and `durable` are examples. The deployment names
both stores.

The servicer resolves a block at request-build: it fetches the object at its
own edge and inlines the bytes for the model. The committed message carries a
reference block, never the bytes. `source.bucket` names the store the object
is in and `source.id` names the object. A block with no `bucket` does not
resolve.

When a block does not resolve:

- **A block riding the say.** The say is rejected with reason
  `attachment_unavailable`, the same reply shape as a stale precondition.
  Nothing commits, and no placeholder stands in for the file.
- **A committed block whose durable object is missing.** The agent deals
  with it for its own model. Tower shows a missing file the same way
  whichever agent is serving the conversation.

A block whose `source.type` the servicer does not know renders in the
request as a stated placeholder: its media type and size, from the block
itself. Source kinds are an open set (`base64` beside `object` would be
add-only).

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

An accepted premise does not evaporate: it becomes the new query's **parent**,
stated on the record by the query's `query.started` (The change stream).
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
for every reader; the `query.closed` closure says when the answer is
complete.

## Transit and durable object stores

Bytes never ride a subject. A deployment has two object stores.

**Transit** carries a request's files from the sender to the servicer, and
its objects expire. The sender stores a say's files in transit before it
sends the say. The deployment names the transit store and sets how long it
keeps objects.

**Durable** holds the bytes of what the servicer commits. A say's file
becomes part of the conversation only when the servicer commits it.

- The durable store is one object store bucket per deployment, with no
  maximum age. The deployment names it.
- Every file the servicer commits, whether an image, a document or binary
  content in a tool result, is stored in the durable store, and the
  committed message references it with a reference block.
- Object names are `{conversationId}/{opaqueId}`.
- Each object's `metadata` holds `messageId`, the id of the message that
  references it, and `mediaType`, its media type. The store's own digest of
  the object covers integrity.

**Order.** The servicer stores a file in the durable store before it
publishes the message that references it. A message never references a file
that is not stored. What happens to a say whose file can't be stored is up
to the implementation (Implementation details).

**References.** A reference block's `source.bucket` names the store and
`source.id` names the object; a durable object's id is its whole name,
`{conversationId}/{opaqueId}`. The reference is complete on its own, like a
URI.

## What consumers may assume

- Traffic for one conversation arrives in publication order per subject, and
  in publication order across one subscription: a single `changes.>`
  subscription sees all change kinds in order (nats.md, Subscription
  discipline). Fold consumers subscribe `{class}.>`, never a set of sibling
  leaves — a partial change stream is corrupted state, and a sibling-set
  subscriber is silently blind to leaves added later.
- **No ordering across classes**: telemetry and commits interleave without
  guarantee; a consumer must never infer state from their relative arrival.
- The query fold groups by `queryId`; its committal end is the
  `query.closed` closure on `changes`, or `query` from a publisher that
  predates the rename. When the publisher announced the start with a
  `parent`, `query.started` places the query in the tree by it; when it
  announced no start, or a start without a `parent`, the query follows the
  tip. Deriving an ending from telemetry
  (`turn_ended` + verbatim `stopReason`) remains lawful observation, never
  authority. Idle is derived — quiet since the last event — never declared.

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
- Whether a cancelled turn's assistant message commits what it had written
  when the cancel landed. The implementation declares by committing or not;
  the record is the answer (see The change stream).
- What is actually sent to the model. The request is a *rendering* of the
  reachable state — what the builder ships, and any presentation-time
  transformation, is between the agent and its model.
- Revision policy — what gets trimmed, when, by what thresholds. The change
  stream carries effects, never reasons.
- What happens to a say whose file can't be stored in the durable store.
  Whatever the implementation does, it never publishes a message pointing at
  a file that isn't stored (Transit and durable object stores).

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
 *  enforcement (core.md). */
const sender = z.looseObject({
  kind: openEnum(['human', 'agent', 'orchestrator']),
  userId: z.string().optional(),
});

/** Content blocks are the agent model's own; opaque typed blocks pending the
 *  content vocabulary's design pass. */
const contentBlocks = z.array(z.looseObject({ type: z.string() }));

const turnRef = { queryId: z.string(), turnId: z.string() };

/** An extra message's fields beside its content (Extra messages). All
 *  optional; plain chat carries none of them. */
const messageExtras = {
  kind: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  audience: z.looseObject({ model: z.boolean(), user: z.boolean() }).optional(),
  userContent: contentBlocks.optional(),
  scope: z.looseObject({ replaces: openEnum(['before']), except: z.array(z.string()) }).optional(),
  at: ts.optional(),
};

// Leafed classes are keyed by subject leaf (the tokens after the class): the
// subject selects the schema, and the body carries no `type`.

// conv.v2.{conversationId}.telemetry.>
export const conversationTelemetry = {
  'turn.started': z.looseObject({ ts, ...turnRef, service: z.string(), model: z.string(), thinking: z.boolean(), effort: z.string().optional(), maxTokens: z.number().int().optional() }),
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

/** The query's closure. One shape under two leaves: `query.closed`, and
 *  `query`, its old name, which consumers read and publishers never publish
 *  again. */
const queryClosure = z.looseObject({ ts, instanceId: z.string().optional(), queryId: z.string(), reason: openEnum(['completed', 'cancelled', 'aborted']) });

// conv.v2.{conversationId}.changes.> — instanceId is envelope metadata
// (beside from, never inside it): which agent instance published the change.
export const conversationChange = {
  'message': z.looseObject({ ts, instanceId: z.string().optional(), id: z.string(), ...turnRef, role: openEnum(['user', 'assistant', 'system']), from: sender.optional(), content: contentBlocks, ...messageExtras }),
  'revision': z.looseObject({ ts, instanceId: z.string().optional(), messageId: z.string(), content: contentBlocks }),
  'tip.moved': z.looseObject({ ts, instanceId: z.string().optional(), to: z.string() }),
  // The parent is the message the query attaches after. An absent parent
  // means the query follows the tip, as does a query with no start at all.
  'query.started': z.looseObject({ ts, instanceId: z.string().optional(), queryId: z.string(), parent: z.string().optional() }),
  'query.closed': queryClosure,
  'query': queryClosure,
};

// The `fields` of an extra message, keyed by its `kind`: the kind selects the
// schema as a subject leaf selects one above, and a kind not listed is
// skipped, never failed (Extra messages).
const tokenCount = z.number().int().nonnegative();
export const messageKindFields = {
  'turn-finished': z.looseObject({ durationMs: z.number().nonnegative(), endedAt: ts.optional() }),
  'interrupted': z.looseObject({ during: openEnum(['turn', 'tool-use']).optional() }),
  'tool-call-note': z.looseObject({ reason: openEnum(['incomplete', 'interrupted', 'result-missing', 'denied', 'skipped']).optional() }),
  'api-error': z.looseObject({ error: z.string().optional(), status: z.number().int().optional() }),
  'no-response': z.looseObject({}),
  'task-finished': z.looseObject({
    taskId: z.string().optional(), toolUseId: z.string().optional(), status: openEnum(['completed', 'failed']).optional(),
    summary: z.string().optional(), name: z.string().optional(),
    durationMs: z.number().nonnegative().optional(), toolUses: z.number().int().nonnegative().optional(), tokens: tokenCount.optional(),
  }),
  'subagent-report': z.looseObject({ agentType: z.string().optional() }),
  'compaction': z.looseObject({
    trigger: openEnum(['auto', 'manual']).optional(), durationMs: z.number().nonnegative().optional(),
    preTokens: tokenCount.optional(), postTokens: tokenCount.optional(), preservedIds: z.array(z.string()).optional(),
  }),
  'date': z.looseObject({ date: z.iso.date().optional() }),
  'total-tokens-reminder': z.looseObject({ tokensLeft: tokenCount.optional() }),
};

// conv.v2.{conversationId}.attachment.> — the wire shape of the model
// agent.md conducts (singular, unconditionally superseding). world is
// provenance, never address, exactly like instanceId — but together they
// are the instance identity (agent.md, The entity), so world is
// required of every compliant publisher; optional here only for producers
// that predate this rule.
export const conversationAttachment = {
  'attached': z.looseObject({ ts, instanceId: z.string(), world: z.string().optional(), cwd: z.string().optional(), tip: z.string().nullable().optional(), intervalS: z.number().int().positive().max(600).optional() }),
  'moved': z.looseObject({ ts, instanceId: z.string(), world: z.string().optional(), cwd: z.string() }),
  'detached': z.looseObject({ ts, instanceId: z.string(), world: z.string().optional() }),
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
    // open set. A block that does not resolve rejects the say
    // (attachment_unavailable). bucket names the store the object is in; a
    // block with no bucket does not resolve.
    attachments: z.array(z.looseObject({
      type: z.string(),
      source: z.looseObject({ type: z.string(), id: z.string(), bucket: z.string().optional(), mediaType: z.string().optional(), size: z.number().int().optional() }),
    })).optional(),
    precondition: z.looseObject({ tip: z.string().nullable() }),
  }),
  'cancel': z.looseObject({ ts, from: sender.optional(), id: z.string() }),
  'chdir': z.looseObject({ ts, from: sender.optional(), cwd: z.string() }),
};

// Replies (transport truth, never outcome). Known reasons today:
// stale, not_found, already_complete, unsupported, busy,
// attachment_unavailable, unavailable.
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

## Migration note

This spec's attachment model — the leaf, the exactly-once rule, `moved` —
isn't implemented anywhere yet. Here's the full surface it touches,
pending:

- **Stream capture** (`mvp/stream-init.sh`) — `conv.v2.*.attachment.>` is a
  new leaf. Existing capture config does not hold it, because the leaf
  didn't exist when that config was last converged.
- **towerd's fold** — reads `agent.v1.*.telemetry.attached`/`detached`
  today. Must move to the conversation tree, add the standing-instance gate
  (this section), and fold `moved`.
- **Both frontends** (`frontend-svelte`, `frontend-leptos`) — read towerd's
  `agents`/`agent` frames (`tower-ws-spec.md`). Their folds need the same
  gate and the `moved` handling, per this repo's parity rule: a
  wire-visible change lands in both, same piece of work.
- **bridge's publisher** — currently publishes `attached`/`detached` on
  `agent.v1.{world}.telemetry.>`. Must move to the conversation subject,
  adopt the exactly-once-per-claim discipline, and publish `moved` on
  `chdir` instead of re-publishing `attached`.
- **`chdir`'s subject** — nothing answers `chdir` on any wire tree today.
  bridge answers it over its stdio control protocol, and helm sends it that
  way, so the work is to implement it on `conv.v2.{id}.requests.chdir` —
  subscribed by the servicer per conversation it holds, `conversationId`
  gone from the payload because the subject carries it — and then retire the
  control line.
- **claude-sdk-cli's `AgentPresence`** — a third producer, publishing
  `attached` with `cwd` on the old subject today. Needs the same move.
- **The Examples above** (agent.md, Attachment) — become the
  conformance fixtures for the exactly-once rule and its fold, alongside
  the existing `docs/spec/fixtures/agent/` set. Fix lands twice: code and
  fixture, same commit.

None of this is implied by the spec landing. Each is separate, later work.

## The v1 tree — superseded, still spoken

v1 differs in shape, not vocabulary: one flat subject per class
(`conv.v1.{id}.changes`, `.telemetry`, `.deltas`, `.requests`), routing by
the payload's `type` alone, and no `query` changes, neither start nor
closure. Every other message shape is identical to v2.

v1 speakers remain lawful for as long as they exist — a breaking change is a
new tree and migration is unhurried (nats.md, Evolution). Skew is absorbed
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
- **A parent the consumer does not hold.** A `query.started` can name, as its
  `parent`, a message the consumer has not seen: one committed before the
  consumer began reading, or one never published on this conversation's
  change stream. What the consumer does with that query and its messages is
  not yet specified.
- **A start away from the tip.** A `query.started` whose `parent` is not the
  current tip, with no `tip_moved` before it, is not yet specified: whether
  the start itself moves the tip to its parent, or a `tip_moved` has to come
  first. Where a rewind comes first (scenario 9), the parent is the tip and
  the question does not arise.

Authority is settled in `core.md`: connection is authority; `from` is
provenance, never enforcement.
