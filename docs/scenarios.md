# Conformance scenarios

The fixture set for `conformance.md`. Each scenario is one capturable session,
small, exercising a distinct slice of the contract. The fixture *files* are
authored during implementation — a fixture written against no implementation
is specification without contact — and this document defines what each must
contain and what asserting it proves. The fixtures double as the specs' worked
examples: files as the source of truth, referenced rather than duplicated.

## 1. The plain exchange

One query, two turns: a tool round (`tool_use`, ends `tool_use`), then the
closing round (ends `end_turn`).

- Exercises: `turn_started` with request inputs, `turn_ended` with verbatim
  `stopReason`, `tool_use` with full payload, `usage` per round, message
  commits on `changes`, `from` on every message.
- Asserts: the baseline schemas; the query fold grouping by `queryId` and
  closing on `end_turn`.

## 2. Cancel mid-turn

Query 1 completes; query 2 is interrupted in its second turn by an accepted
`cancel`.

- Exercises: `cancel {id}` accepted; `turn_cancelled` on telemetry; the
  partial assistant message existing only as deltas — nothing committed.
- Asserts: the telemetry/commit gap is honest — a full telemetry trail with
  zero commits for the interrupted turn; whether the user-role half committed
  is the implementation's declaration, visible either way.

## 3. Edit and rewind

"read file X" edited to "read file Y": a new query attached mid-tree, then a
fast-forward back.

- Exercises: `tip_moved`; a query parented at an interior node; the abandoned
  branch remaining in the log.
- Asserts: reachability from the tip excludes the abandoned branch;
  unreachable is not deleted; fast-forward is possible because the tip's
  history was kept.

## 4. Revision

A trim pass: thinking dropped and a tool result shortened in prior messages,
under stable ids.

- Exercises: `revision` entries carrying resulting content, never reasons.
- Asserts: last-write-wins per message id composed with reachability produces
  the post-trim state; no dialogue position moved — premises anchored on
  message ids still hold.

## 5. Stale premise

Two senders `say` against the same tip; the first is accepted and moves the
tree, the second arrives premised on the old tip.

- Exercises: the servicer's reply discipline — `accepted + id` versus
  `rejected: stale`.
- Asserts: no merging or sequencing of incompatible premises; the change
  stream shows one new query; `from` distinguishes the senders.

## 6. Approval, both endings

Two captures. (a) An ask raised, pulsing, answered, settled. (b) An ask
raised, pulsing, then silence — the holder died.

- Exercises: `raised` with ask type and correlation; the pulse on the ask's
  own telemetry; the answer RPC (`accepted`, and `already_settled` for a
  second answer); `settled` carrying `by`.
- Asserts: the outstanding-set fold — raised + pulse = pending, settled =
  done, pulse silence = void; a late joiner reconstructs the set from replay
  plus one heartbeat interval.
