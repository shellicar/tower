# Conformance scenarios

The fixture set for `conformance.md`. Each scenario is one capturable session,
small, exercising a distinct slice of the contract. The fixtures are inline
below as jsonl templates — one line per wire message, the subject riding each
line; request lines carry their reply inline, since a reply has no subject of
its own. `ts` values and minted ids (`m…`, `q…`, `t…`, `apr-…`, `toolu_…`) are
placeholders: conformance normalises them before comparison, so a fixture is a
template by construction, never a byte-exact recording. The templates double as
the specs' worked examples. First implementation contact validates them — where
an implementation and a template disagree, someone reasons about which is
wrong, and the fix lands twice.

Each template lists the **required** entries: a producer's capture must contain
them as a subsequence per subject, extras allowed (add-only honoured).

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

```jsonl
{"subject":"conv.v1.conv-abc.requests","message":{"type":"say","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human","userId":"stephen"},"text":"read file X and summarise it"},"reply":{"accepted":true,"id":"q1"}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m1","queryId":"q1","turnId":"t1","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file X and summarise it"}]}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_started","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"tool_use","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","id":"toolu_01ABC","name":"ReadFile","input":{"path":"X"}}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_ended","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","stopReason":"tool_use"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"usage","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t1","service":"anthropic.messages","model":"claude-sonnet-4-5","inputTokens":1200,"cacheCreationTokens":0,"cacheReadTokens":0,"outputTokens":80,"costUsd":0.005}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m2","queryId":"q1","turnId":"t1","role":"assistant","from":{"kind":"agent"},"content":[{"type":"tool_use","id":"toolu_01ABC","name":"ReadFile","input":{"path":"X"}}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m3","queryId":"q1","turnId":"t2","role":"user","from":{"kind":"agent"},"content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"…file contents…"}]}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_started","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"File X contains"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_ended","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","stopReason":"end_turn"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"usage","ts":"2026-07-07T21:00:00+10:00","queryId":"q1","turnId":"t2","service":"anthropic.messages","model":"claude-sonnet-4-5","inputTokens":1400,"cacheCreationTokens":0,"cacheReadTokens":1200,"outputTokens":150,"costUsd":0.006}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m4","queryId":"q1","turnId":"t2","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"File X contains a summary of…"}]}}
```

The first `say` of a new conversation is the one anchor-free case — no
`precondition`, there was no state to have known.

## 2. Cancel mid-turn

Query 1 completes (scenario 1's exchange; not repeated here — the template
begins with the tree at `m4`); query 2 is interrupted in its second turn by an
accepted `cancel`.

- Exercises: `cancel {id}` accepted; `turn_cancelled` on telemetry; the
  partial assistant message existing only as deltas — nothing committed.
- Asserts: the telemetry/commit gap is honest — a full telemetry trail with
  zero commits for the interrupted turn; whether the user-role half committed
  is the implementation's declaration, visible either way.

```jsonl
{"subject":"conv.v1.conv-abc.requests","message":{"type":"say","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human","userId":"stephen"},"text":"now delete it","precondition":{"tip":"m4"}},"reply":{"accepted":true,"id":"q2"}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_started","ts":"2026-07-07T21:00:00+10:00","queryId":"q2","turnId":"t3","service":"anthropic.messages","model":"claude-sonnet-4-5","thinking":false,"maxTokens":8192}}
{"subject":"conv.v1.conv-abc.deltas","message":{"type":"delta","text":"Deleting"}}
{"subject":"conv.v1.conv-abc.requests","message":{"type":"cancel","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human","userId":"stephen"},"id":"q2"},"reply":{"accepted":true}}
{"subject":"conv.v1.conv-abc.telemetry","message":{"type":"turn_cancelled","ts":"2026-07-07T21:00:00+10:00","queryId":"q2","turnId":"t3"}}
```

The user-role commit for `q2` is deliberately absent from the required
entries: committing it or not is the implementation's declaration, and either
capture is compliant. No assistant commit may appear for `t3`.

## 3. Edit and rewind

"read file X" edited to "read file Y": a new query attached mid-tree, then a
fast-forward back. Producer-side only — a local act; there is no reject branch
because nobody asked. The tree starts as scenario 1 left it (`m1`–`m4`).

- Exercises: `tip_moved`; a query parented at an interior node; the abandoned
  branch remaining in the log.
- Asserts: reachability from the tip excludes the abandoned branch;
  unreachable is not deleted; fast-forward is possible because the tip's
  history was kept.

```jsonl
{"subject":"conv.v1.conv-abc.changes","message":{"type":"tip_moved","ts":"2026-07-07T21:00:00+10:00","to":"m1"}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m5","queryId":"q2","turnId":"t4","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"read file Y and summarise it"}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m6","queryId":"q2","turnId":"t4","role":"assistant","from":{"kind":"agent"},"content":[{"type":"text","text":"File Y contains…"}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"tip_moved","ts":"2026-07-07T21:00:00+10:00","to":"m4"}}
```

After the first `tip_moved`, `m2`–`m4` are unreachable but present; after the
fast-forward, `m5`–`m6` are the unreachable branch. Both remain in the log.

## 4. Revision

A trim pass: thinking dropped and a tool result shortened in prior messages,
under stable ids. The tree starts as scenario 1 left it.

- Exercises: `revision` entries carrying resulting content, never reasons.
- Asserts: last-write-wins per message id composed with reachability produces
  the post-trim state; no dialogue position moved — premises anchored on
  message ids still hold.

```jsonl
{"subject":"conv.v1.conv-abc.changes","message":{"type":"revision","ts":"2026-07-07T21:00:00+10:00","messageId":"m2","content":[{"type":"tool_use","id":"toolu_01ABC","name":"ReadFile","input":{"path":"X"}}]}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"revision","ts":"2026-07-07T21:00:00+10:00","messageId":"m3","content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"…trimmed…"}]}}
```

## 5. Stale premise

Two senders `say` against the same tip; the first is accepted and moves the
tree, the second arrives premised on the old tip. The tree starts at `m4`.

- Exercises: the servicer's reply discipline — `accepted + id` versus
  `rejected: stale`.
- Asserts: no merging or sequencing of incompatible premises; the change
  stream shows one new query; `from` distinguishes the senders.

```jsonl
{"subject":"conv.v1.conv-abc.requests","message":{"type":"say","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human","userId":"stephen"},"text":"okay, delete it","precondition":{"tip":"m4"}},"reply":{"accepted":true,"id":"q2"}}
{"subject":"conv.v1.conv-abc.changes","message":{"type":"message","ts":"2026-07-07T21:00:00+10:00","id":"m5","queryId":"q2","turnId":"t3","role":"user","from":{"kind":"human","userId":"stephen"},"content":[{"type":"text","text":"okay, delete it"}]}}
{"subject":"conv.v1.conv-abc.requests","message":{"type":"say","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"agent"},"text":"keep it, actually","precondition":{"tip":"m4"}},"reply":{"rejected":true,"reason":"stale"}}
```

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

```jsonl
{"subject":"approval.v1.apr-1.lifecycle","message":{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./old.ts"]}}},"correlation":{"conversationId":"conv-abc","queryId":"q2","turnId":"t3","toolUseId":"toolu_02DEF"}}}
{"subject":"approval.v1.apr-1.telemetry","message":{"type":"heartbeat","ts":"2026-07-07T21:00:00+10:00"}}
{"subject":"approval.v1.apr-1.requests","message":{"type":"answer","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"human","userId":"stephen"},"approved":true},"reply":{"accepted":true}}
{"subject":"approval.v1.apr-1.requests","message":{"type":"answer","ts":"2026-07-07T21:00:00+10:00","from":{"kind":"agent"},"approved":false},"reply":{"rejected":true,"reason":"already_settled"}}
{"subject":"approval.v1.apr-1.lifecycle","message":{"type":"settled","ts":"2026-07-07T21:00:00+10:00","approved":true,"by":{"kind":"human","userId":"stephen"}}}
```

### 6b — the holder died

```jsonl
{"subject":"approval.v1.apr-2.lifecycle","message":{"type":"raised","ts":"2026-07-07T21:00:00+10:00","ask":{"type":"tool_use","name":"DeleteFile","input":{"content":{"type":"files","values":["./other.ts"]}}},"correlation":{"conversationId":"conv-abc","queryId":"q3","turnId":"t5","toolUseId":"toolu_03GHI"}}}
{"subject":"approval.v1.apr-2.telemetry","message":{"type":"heartbeat","ts":"2026-07-07T21:00:00+10:00"}}
```

Nothing follows — no further pulse, no `settled`. The consumer fold reads
`apr-2` as void after one silent heartbeat interval; an `answer` sent to it
gets a reply of `not_found`, or silence and a timeout. All three are honest.
