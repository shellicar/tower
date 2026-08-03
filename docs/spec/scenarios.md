# Conformance scenarios

The fixture set for `conformance.md`. Each scenario is one capturable session,
small, exercising a distinct slice of the contract. The fixtures live as jsonl
files in `fixtures/`. **This repo is their source of truth**; implementations
carry verbatim copies, byte-diffable against these files (conformance.md,
Artifacts). One line per wire message, the subject riding each line; request
lines carry their reply inline, since a reply has no subject of its own. `ts`
values and minted ids (`m…`, `q…`, `t…`, `apr-…`, `toolu_…`, `inst-…`) are
placeholders: conformance normalises them before comparison, so a fixture is a
template by construction, never a byte-exact recording. The templates double as
the specs' worked examples. First implementation contact validates them: where
an implementation and a template disagree, someone reasons about which is
wrong, and the fix lands twice.

| Scenario | Fixture |
|---|---|
| 1: the plain exchange | `fixtures/scenario-1.jsonl` |
| 2: cancel mid-turn | `fixtures/scenario-2.jsonl` |
| 2b: cancel after completion | `fixtures/scenario-2b.jsonl` |
| 3: edit and rewind | `fixtures/scenario-3.jsonl` |
| 4: revision | `fixtures/scenario-4.jsonl` |
| 5: stale premise | `fixtures/scenario-5.jsonl` |
| 6: approval, both endings | `fixtures/scenario-6a.jsonl`, `fixtures/scenario-6b.jsonl` |
| 7: the block stream | `fixtures/scenario-7.jsonl` |
| 8: the attachment, both endings | `fixtures/scenario-8a.jsonl`, `fixtures/scenario-8b.jsonl` |

Each template lists the **required** entries: a producer's capture must contain
them as a subsequence per subject, extras allowed (add-only honoured).

## The v2 set

`fixtures/v2/` carries the conversation scenarios in the v2 tree
(conversation.md, Subjects): leaf subjects spelling each type, and a
`query` closure change wherever a query closes: completed in scenarios 1,
2b, and 3; cancelled in scenario 2. Scenario 5's second query never closes
(still live when the fixture ends), scenario 7 is one turn's stream
mid-query, and scenario 8b never opens a query at all (rejected before
acceptance), so none of the three carries a closure. Scenario 6 is
approval-concern traffic and has no v2 form.

Every v2 change line carries the envelope `instanceId`, required of every
compliant publisher, optional in the schema only for producers that predate
the rule (conversation.md, The change stream). It normalises like any other
minted id.

The v1 set is not superseded by the v2 set's arrival: it remains the v1
ingest path's test surface, and retires with the last v1 speaker
(conversation.md, The v1 tree).

## The two branches

Every request-driven fixture has two valid outcomes, and both are compliant:

1. **Supported**: the request is accepted and the fixture's events follow.
2. **Unsupported**: the same request answered honestly:

```jsonl
{"subject":"conv.v1.conv-abc.requests","message":{"type":"revise","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"agent"},"messageId":"m2","content":[]},"reply":{"rejected":true,"reason":"unsupported"}}
```

An implementation asserts whichever branch matches its declared capability:
compliance is answering, not implementing. Purely producer-side acts (a local
rewind emitting `tip_moved`) have no reject branch: nobody asked, so an
implementation that never performs them simply never exercises that fixture.

## 1. The plain exchange

One query, two turns: a tool round (`tool_use`, ends `tool_use`), then the
closing round (ends `end_turn`).

- Exercises: `turn_started` with request inputs, `turn_ended` with verbatim
  `stopReason`, `tool_use` with full payload, `usage` per round, message
  commits on `changes`, `from` on every message that is an utterance, absent
  on the `tool_result`, which nobody sent.
- Asserts: the baseline schemas; the query fold grouping by `queryId` and
  closed by the `query` closure change on `changes`, carried by the v2 twin,
  since v1 has no closure change (conversation.md, The v1 tree). An ending
  read off `turn_ended` and its verbatim `stopReason` is lawful observation,
  never the fold's authority.

Fixture: `fixtures/scenario-1.jsonl`.

The first `say` of a new conversation carries `{ "tip": null }`: the premise
that nothing exists yet, stated and enforced like any other; there is no
anchor-free case.

## 2. Cancel mid-turn

Query 1 completes (scenario 1's exchange; not repeated here, since the template
begins with the tree at `m4`); query 2 is interrupted in its second turn by an
accepted `cancel`.

- Exercises: `cancel {id}` accepted; `turn_cancelled` on telemetry; the
  partial assistant message existing only as deltas, nothing committed.
- Asserts: the telemetry/commit gap is honest: a full telemetry trail with
  zero commits for the interrupted turn; whether the user-role half committed
  is the implementation's declaration, visible either way.

Fixture: `fixtures/scenario-2.jsonl`.

The user-role commit for `q2` is deliberately absent from the required
entries: committing it or not is the implementation's declaration, and either
capture is compliant. No assistant commit may appear for `t3`.

### 2b: cancel after completion

The cancel arrives a beat too late: the turn already ended and its message is
committed. Born from a real race in the first bridge implementation: a
turn's publishes reach the wire before its completion reaches the servicer's
control loop, and a cancel landing in that gap was answered `accepted` with a
`turn_cancelled` published for a turn that had already ended.

- Exercises: the servicer's honesty when cancellation is impossible:
  `rejected: already_complete`.
- Asserts: once `turn_ended` has been published for a turn, no
  `turn_cancelled` may follow for it, whatever the internal timing; the
  committed message stands. A `cancel` for a query the servicer never held
  is `not_found`; a finished one is `already_complete`: both honest, never
  `accepted`.

Fixture: `fixtures/scenario-2b.jsonl`.

## 3. Edit and rewind

"read file X" edited to "read file Y": a new query attached mid-tree, then a
fast-forward back. Producer-side only, a local act; there is no reject branch
because nobody asked. The tree starts as scenario 1 left it (`m1`–`m4`).

- Exercises: `tip_moved`; a query parented at an interior node; the abandoned
  branch remaining in the log.
- Asserts: reachability from the tip excludes the abandoned branch;
  unreachable is not deleted; fast-forward is possible because the tip's
  history was kept.

Fixture: `fixtures/scenario-3.jsonl`.

After the first `tip_moved`, `m2`–`m4` are unreachable but present; after the
fast-forward, `m5`–`m6` are the unreachable branch. Both remain in the log.

## 4. Revision

A trim pass: thinking dropped and a tool result shortened in prior messages,
under stable ids. The tree starts as scenario 1 left it.

- Exercises: `revision` entries carrying resulting content, never reasons.
- Asserts: last-write-wins per message id composed with reachability produces
  the post-trim state; no dialogue position moved, so premises anchored on
  message ids still hold.

Fixture: `fixtures/scenario-4.jsonl`.

## 5. Stale premise

Two senders `say` against the same tip; the first is accepted and moves the
tree, the second arrives premised on the old tip. The tree starts at `m4`.

- Exercises: the servicer's reply discipline: `accepted + id` versus
  `rejected: stale`.
- Asserts: no merging or sequencing of incompatible premises; the change
  stream shows one new query; `from` distinguishes the senders.

Fixture: `fixtures/scenario-5.jsonl`.

A second `say` premised on `m4` arriving *while `q2` is still live* is also
rejected, because that premise has a live acceptance; cancel-then-send is the
affordance. Either rejection capture is compliant for the second sender.

## 6. Approval, both endings

Two captures. (a) An ask raised, pulsing, answered, settled. (b) An ask
raised, pulsing, then silence: the holder died.

- Exercises: `raised` with ask type and correlation; the pulse on the ask's
  own telemetry; the answer RPC (`accepted`, and `already_settled` for a
  second answer); `settled` carrying `by`.
- Asserts: the outstanding-set fold: raised + pulse = pending, settled =
  done, pulse silence = void; a late joiner reconstructs the set from replay
  plus one heartbeat interval.

### 6a: answered

Fixture: `fixtures/scenario-6a.jsonl`.

### 6b: the holder died

Fixture: `fixtures/scenario-6b.jsonl`.

Nothing follows the second heartbeat: no further pulse, no `settled`. The
consumer fold reads `apr-2` as void after one silent heartbeat interval; an
`answer` sent to it gets a reply of `not_found`, or silence and a timeout.
All three are honest.

## 7. The block stream

One assistant turn streamed live: thinking, then the reply text, then a tool
call whose input JSON forms fragment by fragment, closed by the committed
message carrying the same three blocks. Producer-side only (deltas are
events; nobody asked), so there is no reject branch; a producer that does not
yet emit `block` markers simply never exercises this fixture and remains
compliant: the marker is additive.

- Exercises: `block` markers changing the stream's character; `delta` as the
  sole text carrier regardless of block; the committed `message` superseding
  the whole stream with content blocks in the same order.
- Asserts: markers precede the deltas they describe (publication order per
  subject is the only ordering needed, with no index and no per-chunk type); a
  consumer folding the stream reconstructs thinking → text → tool_use; a
  consumer that skips `block` (predates it) still renders the text deltas
  exactly as before.

Fixture: `fixtures/scenario-7.jsonl`.

## 8. The attachment, both endings

A `say` carrying a reference block from a prior `POST /attachment` upload
(tower-ws-spec, Attachments). The tree starts as scenario 5 left it (`m4`).
Two captures, same shape as scenario 6's two endings:

1. **Resolved** (8a): the block names a bucket the servicer can actually
   fetch from. The say is accepted and the committed message carries the
   reference block **verbatim**, never the resolved bytes; resolution is a
   model-facing render, not a record fact (conversation.md).
2. **Unresolvable** (8b): the block names no bucket (or one the servicer
   can't reach). The say rejects outright, before anything commits: no
   placeholder, no partial accept. `reason` is the canonical token
   `attachment_unavailable`; the specific cause (missing field, wrong
   bucket, unreachable store) is diagnostic, not wire-visible, same footing
   as every other short reason token here.

- Exercises: an `attachments` array riding a `say`; the reference block
  ordering (attachment blocks lead, the text block follows, the same order the
  API sees); a say-level reject distinct from `stale`/`empty`.
- Asserts: a resolvable attachment's reference block is never rewritten by
  acceptance: the record holds exactly what the sender sent; an
  unresolvable one never reaches acceptance at all, so no dangling pending
  say and no placeholder text stands in for what the sender actually
  attached.

### 8a: resolved

Fixture: `fixtures/scenario-8a.jsonl`.

### 8b: unresolvable

Fixture: `fixtures/scenario-8b.jsonl`.

This is a request-driven fixture (The two branches) with a twist: there is no
"unsupported" branch here, because every servicer that accepts `attachments`
at all must validate them the same way: accept-with-verbatim-block or
reject-outright are the only two compliant outcomes for a resolvable-or-not
block. A servicer that has never implemented attachment support simply never
exercises this fixture (declared capability, per the two-branches rule).

## Agent scenarios

`fixtures/agent/` carries the agent concern (agent.md): servicing facts and
the folds they drive. `mac` is the world, `inst-…` an agent instance,
`conv-abc` the conversation it serves. As with the conversation set, `ts` and
minted ids normalise before comparison; the liveness folds turn on order and
presence, not on literal timestamps: silence is represented the way approval
6b represents it, by nothing following.

| Scenario | Fixture |
|---|---|
| a1: world up, fresh conversation | `fixtures/agent/scenario-a1.jsonl` |
| a2: clean shutdown | `fixtures/agent/scenario-a2.jsonl` |
| a3: stranded | `fixtures/agent/scenario-a3.jsonl` |
| a5: resume, then already-attached | `fixtures/agent/scenario-a5.jsonl` |
| a6: the record a non-conformant publisher leaves | `fixtures/agent/scenario-a6.jsonl` |
| a7: ordinary life, on the new leaf | `fixtures/agent/scenario-a7.jsonl` |
| a8: crash and failover, on the new leaf | `fixtures/agent/scenario-a8.jsonl` |
| a9: migration/takeover, on the new leaf | `fixtures/agent/scenario-a9.jsonl` |
| a10: abandon and re-adopt, on the new leaf | `fixtures/agent/scenario-a10.jsonl` |
| a11: chdir, on the new leaf | `fixtures/agent/scenario-a11.jsonl` |
| a12: service migrates cross-world | `fixtures/agent/scenario-a12.jsonl` |
| a13: service takes over a stranded holder | `fixtures/agent/scenario-a13.jsonl` |
| a14: service spawns fresh | `fixtures/agent/scenario-a14.jsonl` |
| a15: service adopts a record | `fixtures/agent/scenario-a15.jsonl` |
| a16: the rejection vocabulary | `fixtures/agent/scenario-a16.jsonl` |

The concern spans two trees, though a single scenario need not. `ready` and
`pulse` are the world's own telemetry; `service` and `drain` address the
world's request tree; the claim on a conversation is the conversation's
(`conv.v2.{id}.attachment.>`, conversation.md, Attachment).

a1 to a3 carry world telemetry beside the claim, and a2 adds a `drain`
request. a5's world lines are two `service` requests, which no stream
captures, and the holder's `pulse`, so replaying it yields the claim and
that pulse. a6 to a11 carry conversation lines only. a12 to a15 mix both
trees, the claim beside the liveness the premise reads; a16 is requests
alone, so it replays as nothing.

### a1: world up, fresh conversation

A process boots, promises a cadence, and attaches to a conversation that has
no messages yet.

- Exercises: `ready` and `pulse` on the world's tree; `attached` on the
  conversation's, carrying `cwd`, `tip: null` and the promised `intervalS`,
  no `changes` traffic at all.
- Asserts: existence-by-attachment, so the conversation is a row before its
  first message; and the **alive** fold, attached with pulse fresh.

### a2: clean shutdown

The instance is serving, then drains.

- Exercises: `drain` accepted on the world; `detached` on the conversation it
  was serving.
- Asserts: the **released** fold: cleanly detached, a decided fact, distinct
  from silence.

### a3: stranded

The instance is serving and pulsing, then goes silent.

- Exercises: `attached` on the conversation, two `pulse`s on the world, then
  nothing: no `detached`, no further pulse.
- Asserts: the **stranded** fold: attached, pulse silent past ~3 × its
  declared `intervalS`. Stranded is inferred from a broken promise, never
  published; it reads differently from a2's released for exactly that reason.

### a5: resume, then already-attached

The one `service` verb across two calls against the same conversation, on
the merged premise (agent.md, "The premise for `service`"): the first call
finds no standing attachment and is accepted; the claim lands on the
conversation's own tree, and the holder pulses. The second call finds a
standing attachment in this world whose holder is alive:
`rejected: already_attached`, from any instance in the world.

- Exercises: `service` accepted on the world (history exists, no live
  attachment → fold and re-attach), then `attached` on the conversation with
  the `tip` it resumed at, and a `pulse` making the holder's liveness
  explicit; a second `service` while attached →
  `rejected: already_attached`.
- Asserts: the verb dispatches on the record's state joined with the world's
  liveness fold, not on the request; the reply confirms the premise
  (servable / already served), never an outcome.

### a6: the record a non-conformant publisher leaves

On the new attachment leaf (conversation.md, Attachment). inst-1's own
publish sequence: `attached`, `attached`, `detached`. A second `attached`
with no intervening `detached`: the violation shape, verbatim (agent.md,
Attachment, example e).

A compliant instance knows its own state and owns its own publish order
across reconnects. Its `detached` goes out before any re-attach, so no
delivery interleaving between compliant participants can produce this
record. This fixture is what a broken publisher leaves behind, not a race
the model has to survive.

- Exercises: a non-conformant instance's record folded by the plain
  standing-instance gate: no claim ids, no timestamp gates, no special
  handling.
- Asserts: the fold applies the gate as written: the final `detached`
  matches the standing `instanceId` and clears the claim; and the violation
  is visible in the record itself (attached-attached-detached from one
  instance), derivable by any reader, never declared.

### a7: ordinary life, on the new leaf

agent.md, Attachment, example (a), verbatim: `attached(inst-1)` → served →
`detached(inst-1)`. One claim, opened and closed by the same instance, on
the conversation's own attachment leaf.

- Exercises: `attached` then `detached` from the same `(world, instanceId)`.
- Asserts: the standing-instance gate accepts a `detached` whose pair matches
  the held claim: the released fold, decided rather than inferred.

### a8: crash and failover, on the new leaf

agent.md, Attachment, example (b): `attached(inst-1)`; its pulses stop and
no `detached` ever comes. `attached(inst-2)` supersedes it anyway,
unconditionally, whether or not a `detached(inst-1)` shows up later.

- Exercises: two `attached` claims for the same conversation, different
  `(world, instanceId)` pairs, no `detached` between them.
- Asserts: the second `attached` is standing regardless of the first
  holder's liveness: supersession carries no precondition.

### a9: migration/takeover, on the new leaf

agent.md, Attachment, example (c): `attached(inst-1)`; while inst-1 still
lives, `attached(inst-2)` supersedes it anyway; inst-1 observes its own
displacement and publishes `detached(inst-1)`, changing nothing in the
fold, since the claim already moved.

- Exercises: `attached`, `attached` (a different pair), then `detached` from
  the FIRST (now superseded) pair.
- Asserts: the standing-instance gate discards the stale `detached`: it
  names a claim that is no longer held, so it folds as nothing.

### a10: abandon and re-adopt, on the new leaf

agent.md, Attachment, example (d): `attached(inst-1)` → `detached(inst-1)`
→ `attached(inst-1)` again. Legal: a closed claim leaves nothing behind to
reopen, so the next `attached` is an ordinary new claim, regardless of whose
instanceId it carries.

- Exercises: attach, detach, re-attach, same `(world, instanceId)` pair.
- Asserts: the re-attach is standing exactly as any other fresh claim: no
  memory of the prior claim blocks or qualifies it.

### a11: chdir, on the new leaf

Tower moves a live attachment's working directory. The request addresses the
conversation being moved (conversation.md, Requests), so only the instance
holding it is listening, and the accept comes from the one party that can
act.

- Exercises: `attached` at one `cwd`; `chdir` accepted on
  `conv.v2.{id}.requests.chdir`, carrying no `conversationId` because the
  subject carries it; the `moved` that follows at the new `cwd`.
- Asserts: the move lands as `moved`, a fact about the claim already open,
  never a second `attached`, which is the violation shape; the attachment's
  cwd folds last-write-wins onto the standing claim; and the conversation's
  change stream emits nothing across the move, the proof cwd is never
  conversation state.

### a12: service migrates cross-world

A standing attachment in another world (`pc`), its holder demonstrably
alive, and a `service` addressed to `mac`: accepted and taken over
unconditionally. Asking a different world to serve IS migration, and the
incumbent's liveness is irrelevant. The superseded instance stands down
with its own `detached`, which folds as nothing.

- Exercises: `attached` (pc), a live pulse, `service` to mac accepted,
  `attached` (mac), the stale `detached` (pc).
- Asserts: the cross-world premise arm, and supersession carrying no
  precondition.

### a13: service takes over a stranded holder

A standing attachment in this world whose holder's pulse went silent past
its own declared threshold: `service` accepted, taken over. A dead holder
never blocks pickup: the attachment is never a lease.

- Exercises: `attached` + one `pulse`, then silence (nothing follows, the
  way a3 represents it); a later `service` accepted; the new `attached`.
- Asserts: the stranded premise arm: the liveness fold, not any declared
  state, is what lets the takeover through.

### a14: service spawns fresh

No standing attachment and no history: `service` spawns fresh under the
requested conversation id. The `attached` carries `tip: null`, an empty
conversation, existing for observers before its first message.

- Exercises: `service` accepted with nothing prior; `attached` with a null
  tip.
- Asserts: the no-attachment, no-history premise arm.

### a15: service adopts a record

No standing attachment but a committed record: `service` adopts; the
record outlives the servicer, and the new claim's `tip` names the record's
last message, proof the record was replayed rather than spawned over.

- Exercises: a committed `message`, then `service` accepted, then `attached`
  with `tip` naming it.
- Asserts: the no-attachment, with-history premise arm.

### a16: the rejection vocabulary

The reply discipline's reject arms, verbatim: a recognised request whose
body doesn't carry what it needs (`invalid`: here an empty
`conversationId`), a named environment value the world cannot establish
(`invalid_cwd`: presence binds, never a silent fallback), an operation the
world could not undertake (`failed`, the cause riding `detail`: the
machine-facing token stays coarse), and a leaf this spec does not list
(`unsupported`: compliance is answering, not implementing). The last one
is deliberately not `drain`: a listed leaf has its own contract, which a2
exercises, and answering the same request two ways across two fixtures
would leave a reader unable to tell which is the contract.

- Exercises: four requests, four rejections; no event traffic at all.
- Asserts: `reason` is the token a caller branches on; `detail` is optional
  human-facing diagnostics, present on `invalid_cwd` and `failed`.
