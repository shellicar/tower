# Conformance scenarios

The fixture set for `conformance.md`. Each scenario is one capturable session,
small, exercising a distinct slice of the contract. The fixtures live as jsonl
files in `fixtures/` — **this repo is their source of truth**; implementations
carry verbatim copies, byte-diffable against these files (conformance.md,
Artifacts). One line per wire message, the subject riding each line; request
lines carry their reply inline, since a reply has no subject of its own. `ts`
values and minted ids (`m…`, `q…`, `t…`, `apr-…`, `toolu_…`, `inst-…`) are
placeholders: conformance normalises them before comparison, so a fixture is a
template by construction, never a byte-exact recording. The templates double as
the specs' worked examples. First implementation contact validates them — where
an implementation and a template disagree, someone reasons about which is
wrong, and the fix lands twice.

| Scenario | Fixture |
|---|---|
| 1 — the plain exchange | `fixtures/scenario-1.jsonl` |
| 2 — cancel mid-turn | `fixtures/scenario-2.jsonl` |
| 2b — cancel after completion | `fixtures/scenario-2b.jsonl` |
| 3 — edit and rewind | `fixtures/scenario-3.jsonl` |
| 4 — revision | `fixtures/scenario-4.jsonl` |
| 5 — stale premise | `fixtures/scenario-5.jsonl` |
| 6 — approval, both endings | `fixtures/scenario-6a.jsonl`, `fixtures/scenario-6b.jsonl` |
| 7 — the block stream | `fixtures/scenario-7.jsonl` |

Each template lists the **required** entries: a producer's capture must contain
them as a subsequence per subject, extras allowed (add-only honoured).

## The v2 set

`fixtures/v2/` carries the conversation scenarios in the v2 tree
(conversation-spec, Subjects): leaf subjects spelling each type, and a
`query` closure change wherever a query closes — completed in scenarios 1,
2b, and 3; cancelled in scenario 2. Scenario 5's second query never closes
(still live when the fixture ends) and scenario 7 is one turn's stream
mid-query, so neither carries a closure. Scenario 6 is approval-concern
traffic and has no v2 form.

The v1 set is not superseded by the v2 set's arrival: it remains the v1
ingest path's test surface, and retires with the last v1 speaker
(conversation-spec, The v1 tree).

## The two branches

Every request-driven fixture has two valid outcomes, and both are compliant:

1. **Supported** — the request is accepted and the fixture's events follow.
2. **Unsupported** — the same request answered honestly:

```jsonl
{"subject":"conv.v1.conv-abc.requests","message":{"type":"revise","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"agent"},"messageId":"m2","content":[]},"reply":{"rejected":true,"reason":"unsupported"}}
```

An implementation asserts whichever branch matches its declared capability —
compliance is answering, not implementing. Purely producer-side acts (a local
rewind emitting `tip_moved`) have no reject branch: nobody asked, so an
implementation that never performs them simply never exercises that fixture.

## 1. The plain exchange

One query, two turns: a tool round (`tool_use`, ends `tool_use`), then the
closing round (ends `end_turn`).

- Exercises: `turn_started` with request inputs, `turn_ended` with verbatim
  `stopReason`, `tool_use` with full payload, `usage` per round, message
  commits on `changes`, `from` on every message.
- Asserts: the baseline schemas; the query fold grouping by `queryId` and
  closing on `end_turn`.

Fixture: `fixtures/scenario-1.jsonl`.

The first `say` of a new conversation carries `{ "tip": null }` — the premise
that nothing exists yet, stated and enforced like any other; there is no
anchor-free case.

## 2. Cancel mid-turn

Query 1 completes (scenario 1's exchange; not repeated here — the template
begins with the tree at `m4`); query 2 is interrupted in its second turn by an
accepted `cancel`.

- Exercises: `cancel {id}` accepted; `turn_cancelled` on telemetry; the
  partial assistant message existing only as deltas — nothing committed.
- Asserts: the telemetry/commit gap is honest — a full telemetry trail with
  zero commits for the interrupted turn; whether the user-role half committed
  is the implementation's declaration, visible either way.

Fixture: `fixtures/scenario-2.jsonl`.

The user-role commit for `q2` is deliberately absent from the required
entries: committing it or not is the implementation's declaration, and either
capture is compliant. No assistant commit may appear for `t3`.

### 2b — cancel after completion

The cancel arrives a beat too late: the turn already ended and its message is
committed. Born from a real race in the first bridge implementation — a
turn's publishes reach the wire before its completion reaches the servicer's
control loop, and a cancel landing in that gap was answered `accepted` with a
`turn_cancelled` published for a turn that had already ended.

- Exercises: the servicer's honesty when cancellation is impossible —
  `rejected: already_complete`.
- Asserts: once `turn_ended` has been published for a turn, no
  `turn_cancelled` may follow for it, whatever the internal timing; the
  committed message stands. A `cancel` for a query the servicer never held
  is `not_found`; a finished one is `already_complete` — both honest, never
  `accepted`.

Fixture: `fixtures/scenario-2b.jsonl`.

## 3. Edit and rewind

"read file X" edited to "read file Y": a new query attached mid-tree, then a
fast-forward back. Producer-side only — a local act; there is no reject branch
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
  the post-trim state; no dialogue position moved — premises anchored on
  message ids still hold.

Fixture: `fixtures/scenario-4.jsonl`.

## 5. Stale premise

Two senders `say` against the same tip; the first is accepted and moves the
tree, the second arrives premised on the old tip. The tree starts at `m4`.

- Exercises: the servicer's reply discipline — `accepted + id` versus
  `rejected: stale`.
- Asserts: no merging or sequencing of incompatible premises; the change
  stream shows one new query; `from` distinguishes the senders.

Fixture: `fixtures/scenario-5.jsonl`.

A second `say` premised on `m4` arriving *while `q2` is still live* is also
rejected — that premise has a live acceptance; cancel-then-send is the
affordance. Either rejection capture is compliant for the second sender.

## 6. Approval, both endings

Two captures. (a) An ask raised, pulsing, answered, settled. (b) An ask
raised, pulsing, then silence — the holder died.

- Exercises: `raised` with ask type and correlation; the pulse on the ask's
  own telemetry; the answer RPC (`accepted`, and `already_settled` for a
  second answer); `settled` carrying `by`.
- Asserts: the outstanding-set fold — raised + pulse = pending, settled =
  done, pulse silence = void; a late joiner reconstructs the set from replay
  plus one heartbeat interval.

### 6a — answered

Fixture: `fixtures/scenario-6a.jsonl`.

### 6b — the holder died

Fixture: `fixtures/scenario-6b.jsonl`.

Nothing follows the second heartbeat — no further pulse, no `settled`. The
consumer fold reads `apr-2` as void after one silent heartbeat interval; an
`answer` sent to it gets a reply of `not_found`, or silence and a timeout.
All three are honest.

## 7. The block stream

One assistant turn streamed live: thinking, then the reply text, then a tool
call whose input JSON forms fragment by fragment — closed by the committed
message carrying the same three blocks. Producer-side only (deltas are
events; nobody asked), so there is no reject branch; a producer that does not
yet emit `block` markers simply never exercises this fixture and remains
compliant — the marker is additive.

- Exercises: `block` markers changing the stream's character; `delta` as the
  sole text carrier regardless of block; the committed `message` superseding
  the whole stream with content blocks in the same order.
- Asserts: markers precede the deltas they describe (publication order per
  subject is the only ordering needed — no index, no per-chunk type); a
  consumer folding the stream reconstructs thinking → text → tool_use; a
  consumer that skips `block` (predates it) still renders the text deltas
  exactly as before.

Fixture: `fixtures/scenario-7.jsonl`.

## Agent scenarios

`fixtures/agent/` carries the agent concern (agent-spec): servicing facts and
the folds they drive. `mac` is the world, `inst-…` an agent instance,
`conv-abc` the conversation it serves. As with the conversation set, `ts` and
minted ids normalise before comparison; the liveness folds turn on order and
presence, not on literal timestamps — silence is represented the way approval
6b represents it, by nothing following.

| Scenario | Fixture |
|---|---|
| a1 — world up, fresh conversation | `fixtures/agent/scenario-a1.jsonl` |
| a2 — clean shutdown | `fixtures/agent/scenario-a2.jsonl` |
| a3 — stranded | `fixtures/agent/scenario-a3.jsonl` |
| a4 — chdir | `fixtures/agent/scenario-a4.jsonl` |
| a5 — resume, then already-attached | `fixtures/agent/scenario-a5.jsonl` |

### a1 — world up, fresh conversation

A process boots, promises a cadence, and attaches to a conversation that has
no messages yet.

- Exercises: `ready`, `pulse`, `attached` carrying `cwd` — no conversation
  traffic at all.
- Asserts: existence-by-attachment — the conversation is a row before its
  first message; the **alive** fold — attached, pulse fresh.

### a2 — clean shutdown

The instance is serving, then drains.

- Exercises: `drain` accepted; `detached` for the conversation.
- Asserts: the **released** fold — cleanly detached, a decided fact, distinct
  from silence.

### a3 — stranded

The instance is serving and pulsing, then goes silent.

- Exercises: `attached`, two `pulse`s, then nothing — no `detached`, no
  further pulse.
- Asserts: the **stranded** fold — attached, pulse silent past ~3 × its
  declared `intervalS`. Stranded is inferred from a broken promise, never
  published; it reads differently from a2's released for exactly that reason.

### a4 — chdir

Tower moves a live attachment's working directory.

- Exercises: `attached` at one `cwd`, `chdir` accepted, `attached`
  re-published at the new `cwd`.
- Asserts: last-write-wins per (instance, conversation) — the attachment's
  current cwd is the latest `attached`; and that the conversation's change
  stream emits nothing across the move — the proof cwd is never conversation
  state.

### a5 — resume, then already-attached

The one `service` verb across two calls against the same conversation.

- Exercises: `service` accepted (history exists, no live attachment → fold
  and re-attach), `attached`; a second `service` while attached →
  `rejected: already_attached`.
- Asserts: the verb dispatches on the record's state, not on the request; the
  reply confirms the premise (servable / already served), never an outcome.
