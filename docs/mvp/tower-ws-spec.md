# Tower WS spec — v1

The browser ↔ towerd contract: one WebSocket, JSON messages both ways. This is
the frontend's *only* coupling — a client built against this document alone,
never against towerd's code, is a correct client. Companion to
`tower-v1-design.md` (the daemon this fronts) and the concern specs (the wire
the daemon consumes; nothing in this document reaches the NATS wire directly).

## The model

Two kinds of traffic, mirroring the wire's own split:

- **Unconditional events** — the staleness product. From the moment of
  connection, the client knows the last-event time of *every* conversation in
  the fleet, live, whether or not any conversation is open. This works with
  nothing open; it is the primary product.
- **Requests and gated content** — reading and speaking. Opening a
  conversation subscribes to its *content* (committed messages, streaming
  text); `say` speaks into it. `open` exists for bandwidth, not attention:
  it gates message bodies only, never awareness.

## Connection lifecycle

1. Client connects to `/ws`. No auth in v1 (towerd binds locally).
2. towerd sends `list` — the full row snapshot — once, unasked.
3. From then on `row` events arrive for every conversation, forever.
4. The client `open`s any number of conversations; each answers with
   `conversation` (the catch-up) and starts that conversation's `message` /
   `streaming` flow. `close` stops one.
5. A dropped socket ends everything. Reconnect = fresh connection: new
   `list`, re-`open` what was being read, using `after` so history never
   travels twice.

## Request/response

Standard: every client request carries a client-minted `id` (any unique
string; a UUID is fine). Every response echoes that `id` verbatim. Responses
interleave with events on the socket; the `id` is how the client matches them.
A request towerd does not recognise is still answered — `error` with reason
`unsupported`; compliance is answering, here as on the wire.

## Client → towerd

### `open`

```json
{ "type": "open", "id": "r1", "conv": "c65b902d-…", "after": 1760187514000 }
```

Subscribe to one conversation's content. `after` is the client's high-water
mark — the largest message `ts` it already holds — and `null` means "from the
start". The response is `conversation`, carrying every stored message newer
than `after`; from then on the conversation's `message` and `streaming` events
flow until `close` or disconnect. `open` is additive (any number of
conversations open at once) and idempotent (re-opening an open conversation
just answers again — the client may use exactly this on reconnect).

### `close`

```json
{ "type": "close", "id": "r2", "conv": "c65b902d-…" }
```

Stop one conversation's content flow. Response: `closed`. `row` events for
that conversation continue — closing affects reading, never awareness.
Closing something not open is not an error; the response is the same.

### `set_title`

```json
{ "type": "set_title", "id": "r4", "conv": "c65b902d-…", "title": "tower build" }
```

Name a conversation. The title is **tower's own annotation** — it lives in
towerd, never travels on NATS, and never reaches the conversation's servicer.
Any client may rename; concurrent renames are last-write-wins. An empty
`title` clears the name (clients fall back to showing the id). Response:
`title_set`. Titles do not propagate live: the renaming client already knows
what it did, and every other client sees the new name in its next `list` —
refresh is the propagation.

### `set_tag`

```json
{ "type": "set_tag", "id": "r6", "conv": "c65b902d-…", "key": "mission", "value": "tower-design" }
```

Tag a conversation. Tags are **tower's own annotations** — flat `key: value`
pairs (one value per key per conversation), never wire state, never
interpreted: tower renders keys and values verbatim; the meaning is the
user's. An empty `value` clears the key. Last write wins. Response:
`tag_set`. Like titles, tags do not propagate live — refresh is the
propagation.

The tag's identity is the **key**: each key carries a colour (assigned
randomly from a palette at first use, editable in the store), so clients can
render bare values — `operator`, not `role: operator` — with the colour
saying which key it belongs to.

### `say`

```json
{ "type": "say", "id": "r3", "conv": "c65b902d-…", "text": "hello", "tip": "a439d18e-…" }
{ "type": "say", "id": "r4", "conv": "c65b902d-…", "text": "what does this show?", "tip": "a439d18e-…",
  "attachments": [
    { "type": "image", "source": { "type": "object", "id": "att-7c9e…", "bucket": "attach", "mediaType": "image/png", "size": 48213 } }
  ] }
```

Speak into a conversation. towerd forwards it to the conversation's servicer
as a wire `say`: `text` verbatim, the premise as `precondition: { tip }`
verbatim — the tip is the *client's* view of the latest message id, because
the premise belongs to the sender, and towerd never substitutes its own
fresher knowledge. `tip: null` is the claim "this conversation is empty"
(conversation-spec: there is no anchor-free case). `from` is stamped
`{ "kind": "human" }` bare — towerd knows a human clicked and, in v1, no more.
Response: `say_result`. The *answer* to what was said is not in the response —
it arrives on the conversation's content flow like everything else, which is
the wire's own rule (the reply confirms acceptance, never outcome).

`attachments` carries reference blocks from prior `POST /attachment` uploads
(below), forwarded verbatim — bytes never ride the WS or the wire. The
committed message will carry the same reference blocks; rendering them is the
client's policy, like every ref.

### `cancel`

```json
{ "type": "cancel", "id": "r7", "conv": "c65b902d-…", "query": "7d8022be-…" }
```

Cancel a running query — stop, never rollback: everything already committed
stands (the record constitutes the state); the query's remaining work is
revoked and its premise freed. `query` is the id `say_result` returned — the
cancel's target is its premise, never "whatever happens to be running".
towerd forwards it to the servicer as a wire `cancel`, `from` stamped
`{ "kind": "human" }` bare. Response: `cancel_result`. The outcome — what the
cancel actually stopped — arrives on the change stream as the query's
closure, like every other outcome.

### `answer`

```json
{ "type": "answer", "id": "r5", "approval": "apr-9f3", "approved": true }
```

Answer a pending approval. towerd forwards it to the approval's holder as a
wire `answer` — `approved` verbatim, `from` stamped `{ "kind": "human" }`
bare, exactly as `say`. Response: `answer_result`. First valid answer wins
(the approval spec's rule): losing the race to the terminal comes back as
`rejected` with reason `already_settled` — information, not an error. The
settlement itself arrives as an `approval` event like any other, carrying
whose decision it was.

## towerd → client

### `list` — once, on connect

```json
{ "type": "list",
  "tagKeys": { "mission": "#7c6f64", "role": "#458588" },
  "rows": [
  { "conv": "c65b902d-…", "lastEvent": 1760187514000, "lastKind": "message", "title": "tower build",
    "tags": { "mission": "tower-design", "role": "pm" } }
] }
```

`tags` is present only for tagged conversations; `tagKeys` maps every known
key to its colour, once per connection — the colour language is shared truth,
identical on every client. `title` is present only for conversations that
have been named (`set_title`);
absent means untitled — show the id. The `list` is the only carrier: `row`
events do not carry titles, because a rename is not fleet activity and must
not touch staleness.

The full snapshot: one row per conversation towerd has ever seen, unsorted —
ordering is the client's (by `lastEvent`, descending, is the product). Sent
exactly once per connection, before any `row`. A client that needs it again
reconnects.

### `row` — live, unconditional

```json
{ "type": "row", "conv": "c65b902d-…", "lastEvent": 1760187520000, "lastKind": "turn_started" }
```

One conversation's staleness changed. Upsert into the list by `conv`: a known
`conv` updates its row, an unknown one *is a new conversation* — this is also
how conversations are born into the UI. `lastKind` is the wire event type that
caused the touch (`message`, `turn_started`, `delta`, …) — display fodder,
an open set, never something to branch on. Arrives for every conversation,
always, regardless of what is open. This event *is* the staleness product.

### `conversation` — response to `open`

```json
{ "type": "conversation", "id": "r1", "conv": "c65b902d-…", "messages": [
  {
    "id": "a439d18e-…", "query": "7d8022be-…", "turn": "b44cf632-…",
    "role": "assistant", "from": { "kind": "agent" },
    "content": [ { "type": "text", "text": "🫖 Brewing…" } ],
    "ts": 1760187407672
  }
] }
```

The catch-up: every stored message with `ts` greater than the request's
`after`, in `ts` order. Each message carries all three ids — `id` (message),
`query`, `turn` — as every message does everywhere in this system; plus
`role`, the `from` object verbatim from the wire (**absent for a
`tool_result`** — a mechanical delivery carries no sender, never fabricated),
`content` blocks verbatim
(the client renders known block types, skips unknown ones), and `ts`. The
boundary may overlap what the client already holds when `after` is a shared
timestamp — dedupe by message `id`; rendering a known id again is a no-op.

### `approvals` — once, on connect

```json
{ "type": "approvals", "approvals": [
  {
    "id": "apr-9f3",
    "ask": { "type": "tool_use", "name": "DeleteFile", "input": { "content": { "type": "files", "values": ["./old.ts"] } } },
    "correlation": { "conversationId": "c65b902d-…", "queryId": "7d8022be-…", "turnId": "b44cf632-…", "toolUseId": "toolu_01ABC" },
    "raisedTs": 1760187514000,
    "lastPulse": 1760187529000
  }
] }
```

The outstanding snapshot: every **unsettled** ask towerd knows, sent once per
connection right after `list`. `ask` and `correlation` are verbatim from the
wire (`ask.type` is an open set — an unknown type still shows with its
correlation). **Void is the client's derivation**: the pulse is ~15s while
pending, so an ask whose `lastPulse` lags the clock by ~3 intervals displays
as void — greyed, never dropped; a dead holder's ask is information.

### `approval` — live, unconditional

```json
{ "type": "approval", "id": "apr-9f3", "ask": { … }, "correlation": { … },
  "raisedTs": 1760187514000, "lastPulse": 1760187544000,
  "settled": { "approved": true, "by": { "kind": "human", "userId": "stephen" }, "ts": 1760187550000 } }
```

One approval's state changed — raised, pulsed, or settled. Upsert by `id`,
exactly the `row` discipline: awareness is unconditional, an unknown id is a
new ask being born. `settled` is present only once settled; a settled ask
leaves the pending count and shows whose decision it was.

### `query` — live, gated by `open`

```json
{ "type": "query", "conv": "c65b902d-…", "queryId": "7d8022be-…", "reason": "completed" }
```

The wire's query closure, forwarded: this query will grow no further.
`reason` is the wire's open set (`completed`, `cancelled`, `aborted`) —
shown, never branched on beyond display. Same gating as `message`: only for
open conversations.

**Query state is the client's knowledge, and unknown is a real state.**
towerd stores no query state — this event is forwarded, not folded — so a
client knows a query is live only by evidence from its own connection: its
own `say_result` minted the query, or activity arrived, and no closure has.
After a fresh connect or reconnect the state is **unknown**, and the client
renders it as unknown (a badge, shading) rather than pretending idle. The
render is a courtesy; the premise check is the enforcement — a say sent
while unknowingly live comes back `rejected: stale`, which itself resolves
the state to known-live.

### `cancel_result` — response to `cancel`

```json
{ "type": "cancel_result", "id": "r7", "outcome": "accepted" }
{ "type": "cancel_result", "id": "r7", "outcome": "rejected", "reason": "already_complete" }
{ "type": "cancel_result", "id": "r7", "outcome": "unreachable" }
```

Transport truth, never outcome — `accepted` means the servicer took the
cancel, not that anything stopped: cancelling something that is finishing
anyway legitimately closes `completed`. `reason` is an open set
(`already_complete`, `not_found`, `unsupported`, and anything future).

### `agents` — once, on connect

```json
{ "type": "agents",
  "instances": [
    { "world": "mac", "instanceId": "inst-1a2f", "host": "mac", "lastPulse": 1760187529000, "intervalS": 30 }
  ],
  "attachments": [
    { "world": "mac", "instanceId": "inst-1a2f", "conv": "c65b902d-…", "cwd": "~/repos/tower", "attachedTs": 1760187514000 }
  ] }
```

The servicing snapshot, sent once per connection after `approvals`: every
instance towerd's fold retains and every live attachment. Facts only, never
verdicts — **liveness is the client's derivation** (agent-spec: a fold, never
declared): an attachment whose instance's `lastPulse` lags the client's clock
by ~3 of that instance's own `intervalS` renders as stranded; a live pulse
renders as alive; no attachment is released. `intervalS` may be absent (an
instance that has published `ready` but no pulse yet).

**Existence is a union.** A `conv` present in `attachments` but absent from
the `list` rows is a *potential* conversation — served, ready to receive, no
messages yet. Show it in the rail with no staleness (it has no conversation
activity to claim); it vanishes when its attachment does, and its first
committed message births the ordinary row. Rows never carry agent facts, and
agent facts never touch `lastEvent`.

### `agent` — live, unconditional

```json
{ "type": "agent", "kind": "ready",    "world": "mac", "instanceId": "inst-1a2f", "ts": 1760187514000, "host": "mac" }
{ "type": "agent", "kind": "pulse",    "world": "mac", "instanceId": "inst-1a2f", "ts": 1760187544000, "intervalS": 30 }
{ "type": "agent", "kind": "attached", "world": "mac", "instanceId": "inst-1a2f", "ts": 1760187514000, "conv": "c65b902d-…", "cwd": "~/repos/tower" }
{ "type": "agent", "kind": "detached", "world": "mac", "instanceId": "inst-1a2f", "ts": 1760187600000, "conv": "c65b902d-…" }
```

One wire fact, one packet — a pulse is one instance fact however many
conversations the instance serves; it never fans out per conversation.
Upsert into the client's two maps (`instanceId → pulse`, `conv →
attachment`); `detached` removes the attachment. `kind` is an open set:
unknown kinds are skipped, never fatal. `ts` is the fact's wire timestamp in
millis; for `pulse` it is the new `lastPulse`.

### `answer_result` — response to `answer`

```json
{ "type": "answer_result", "id": "r5", "outcome": "accepted" }
{ "type": "answer_result", "id": "r5", "outcome": "rejected", "reason": "already_settled" }
{ "type": "answer_result", "id": "r5", "outcome": "unreachable" }
```

Transport truth, never verdict — the same three-way honesty as `say_result`.
`reason` is an open set (`already_settled`, `not_found`, and anything future).
`unreachable` means nobody answered: the holder is gone, and the ask will read
as void when its pulse lapses.

### `stream_block` — live, gated by `open`

```json
{ "type": "stream_block", "conv": "c65b902d-…", "blockType": "thinking" }
```

The wire's `block` marker, forwarded: the conversation's in-flight stream
changed character — the `streaming` chunks that follow are `blockType`
(`thinking`, `text`, `tool_use` — an open set, shown verbatim, never branched
on beyond styling). Same gating and ephemerality as `streaming`: only for
open conversations, superseded by the committed message. A client that
predates this frame skips it and sees exactly what it saw before.

### `tag_set` — response to `set_tag`

```json
{ "type": "tag_set", "id": "r6", "conv": "c65b902d-…" }
```

Acknowledgement, nothing more.

### `title_set` — response to `set_title`

```json
{ "type": "title_set", "id": "r4", "conv": "c65b902d-…" }
```

Acknowledgement, nothing more.

### `closed` — response to `close`

```json
{ "type": "closed", "id": "r2", "conv": "c65b902d-…" }
```

Acknowledgement, nothing more.

### `say_result` — response to `say`

```json
{ "type": "say_result", "id": "r3", "outcome": "accepted", "query": "7d8022be-…" }
{ "type": "say_result", "id": "r3", "outcome": "rejected", "reason": "stale" }
{ "type": "say_result", "id": "r3", "outcome": "unreachable" }
```

Three outcomes, verbatim from the wire exchange:

- `accepted` — the servicer took it; `query` is the minted query id. The
  reply is acceptance only; the answer arrives as `message` events.
- `rejected` — the servicer answered no; `reason` is the servicer's own word,
  an open set (`stale` — the tip moved or the premise has a live acceptance;
  cancel-then-send is the affordance — `unsupported`, and anything future).
  Show it; do not branch on it.
- `unreachable` — nobody answered (timeout or no responders — the transport
  distinction carries no meaning and is deliberately not exposed). The
  conversation exists in the views but nothing is currently serving it.

### `message` — gated by `open`

```json
{ "type": "message", "conv": "c65b902d-…", "message": { …same shape as in `conversation`… } }
```

A message was committed to an open conversation — the change stream, live.
Append in `ts` order; dedupe by message `id` (a message may arrive both in a
`conversation` catch-up and here, at the boundary). A `message` also implies
the streaming text that preceded it is superseded — clear any streaming
display for that conversation when its committed message lands.

### `streaming` — gated by `open`

```json
{ "type": "streaming", "conv": "c65b902d-…", "text": "🫖 Brew" }
```

A chunk of the in-flight assistant reply — the wire's deltas, forwarded.
Append to the conversation's streaming display as it arrives. Purely
ephemeral, exactly as on the wire: never stored, no ids, superseded entirely
by the committed `message` that follows. A client that ignores `streaming`
is correct, just less alive.

### `usage` — live, gated by `open`

```json
{ "type": "usage", "conv": "c65b902d-…", "model": "claude-sonnet-4-5",
  "inputTokens": 9700, "outputTokens": 418700,
  "cacheCreationTokens": 2100000, "cacheCreation5mTokens": 100000, "cacheCreation1hTokens": 2000000,
  "cacheReadTokens": 66300000, "turns": 174, "contextTokens": 740500 }
```

The conversation's running cost surface. towerd folds every turn's wire
`telemetry.usage` into per-conversation totals — the token counts are
**cumulative over the conversation** and `turns` counts the turns folded — and
emits the whole snapshot, **absolute never incremental**: the client replaces
what it holds, it never sums. Summing is towerd's job precisely because a
turn's usage streams cumulatively on the wire; a client adding frames would
double-count. Sent once on `open` (the current totals) and again on every turn
while open — same gating as `message`, because this is per-conversation
content, not fleet awareness. A conversation with no usage yet gets no frame;
absent means zero.

`model` and `contextTokens` are the **latest** turn's, not sums: `contextTokens`
is that turn's `inputTokens + cacheCreationTokens + cacheReadTokens` — the
current prompt's occupancy of the context window (the whole prompt, cache
included), which the next turn replaces, so it cannot be a running total.

`cacheCreation5mTokens` and `cacheCreation1hTokens` are the 5m/1h breakdown of
`cacheCreationTokens` (each cumulative), forwarded from the wire's optional
split; they let the client price cache-creation at each TTL's own write rate
instead of assuming one. Both are 0 when the producer never reported the split.

Facts only — the client owns the policy. `$` comes from a per-model price
table, `used/max (%)` from `contextTokens ÷ the model's window`; towerd ships
neither a dollar nor a percentage, the same facts-not-verdicts rule staleness
and liveness already keep. (Usage also touches staleness unconditionally: a
usage wire event advances `lastEvent` with `lastKind: "usage"` on the `row`,
like any activity — that is awareness and is not gated; this frame is the
content.)

### `error` — response to anything unrecognised or malformed

```json
{ "type": "error", "id": "r9", "reason": "unsupported" }
```

Every request is answered; a request towerd cannot parse or does not know is
answered with this. `reason` is an open set.

## References — weight never rides the wire

One mechanism for every heavy value, uniformly. In v1 towerd externalises at
four fixed nodes — `image.source` and `document.source` (base64, wherever the
block nests), `tool_result.content`, and oversized values inside
`tool_use.input` — replacing the value in place by a reference. The shape is
position-agnostic, so a client handles a `$ref` at *any* node it meets;
further nodes are add-only:

```json
{ "$ref": "sha256-9f2c…", "size": 524288, "hint": "tool_result" }
```

- `$ref` is an opaque content-addressed id — **never a URL**. The client
  constructs the fetch from its own knowledge of this API; routes are the
  client's, ids are the data's. A route change costs stored data nothing.
- `size` is the byte length of the referenced content — enough to render
  `↩ result · 513 KB` without fetching.
- `hint` says what the bytes are — a media type (`image/png`,
  `application/pdf`) or a block kind (`tool_result`) — render fodder, an
  open set.

Fetching:

```
GET /ref/{id}          → the bytes (Content-Type from the store)
GET /ref/{id}  + Range → a slice — preview the first 4 KB of a 500 KB result
```

The client rule is one line: wherever a `$ref` object sits — as a
`tool_result`'s `content`, as an image `source`'s `data`, as any leaf — the
client knows what the content *is* (`hint`) and how big (`size`); **how it
materialises it is entirely the client's policy.** Fetch eagerly and bake a
`data:` URL, set an `<img src>` and let the browser lazy-load, show a
"load · 513 KB" button, or never fetch — all correct. The protocol supplies
facts, never rendering mechanism. References are content-addressed, so any
constructed URL is immutable and cacheable forever.

Everything else about the message — its ids, its position, the tip — is
unaffected: externalisation never falsifies position, and a client that never
fetches a single ref still reads the whole dialogue.

## Attachments — `POST /attachment`

```
POST /attachment           body = the bytes, Content-Type = the media type
  → 200 { "id": "att-7c9e…", "mediaType": "image/png", "size": 48213, "bucket": "attach" }
```

Upload happens over HTTP — the WS stays light — and eagerly, at attach time:
the client uploads when the user picks the file, holds the returned reference,
and includes it in the eventual `say`'s `attachments`. towerd puts the bytes
into the deployment's **transit** object store (conversation-spec: transit,
not storage — the servicer fetches at its own edge; ids are opaque and
short-lived; the store's TTL is the cleanup, so an upload the user abandons
costs nothing and needs no delete call). The id is minted random — nothing is
kept long enough for content-addressing to buy anything.

`bucket` names the store the object actually landed in and rides in every
upload's reply — the client carries it verbatim into the reference block
it sends with the say (conversation-spec, `attachments`). A servicer
resolves against the bucket the block names, never a guess from its own
deployment config; a block naming no bucket cannot be resolved and the say
that carries it rejects (`attachment_unavailable`) rather than silently
lose the attachment.

```
GET /attachment/{id}   → the bytes (Content-Type from upload) — while the object lives
```

Preview, with transit semantics on purpose: past the store's TTL this
honestly 404s. The committed chip still states what was attached (type,
size); the bytes were for the model, and the repair — as everywhere — is
re-attaching.

## Tolerance

The wire's evolution rules, both directions: producers only add — new message
types, new optional fields; consumers tolerate — unknown `type` skipped
without error, unknown fields ignored, unknown enum values (`lastKind`,
`reason`, content block types) shown or skipped, never fatal. Breaking
changes are a new spec version.

## Timestamps

All `ts`/`lastEvent`/`after` values are unix milliseconds UTC. towerd
normalises the wire's ISO-with-offset timestamps once, at ingest; this
boundary never carries a timestamp string.

## Message schemas — normative

Same conventions as the concern specs: zod (v4), `z.looseObject` as the
add-only rule, `openEnum` for tolerated value sets, strict unions over known
types with unknown types handled by the receiver's routing, never by a
catch-all member.

```ts
import { z } from 'zod';

const openEnum = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values).or(z.string());

const millis = z.number().int();

const sender = z.looseObject({
  kind: openEnum(['human', 'agent', 'orchestrator']),
  userId: z.string().optional(),
});

const contentBlocks = z.array(z.looseObject({ type: z.string() }));

const conversationMessage = z.looseObject({
  id: z.string(),
  query: z.string(),
  turn: z.string(),
  role: openEnum(['user', 'assistant']),
  from: sender.optional(),
  content: contentBlocks,
  ts: millis,
});

const rowState = z.looseObject({
  conv: z.string(),
  lastEvent: millis,
  lastKind: z.string(),
  title: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

const agentInstance = z.looseObject({
  world: z.string(),
  instanceId: z.string(),
  host: z.string().optional(),
  lastPulse: millis,
  intervalS: z.number().int().optional(),
});

const agentAttachment = z.looseObject({
  world: z.string(),
  instanceId: z.string(),
  conv: z.string(),
  cwd: z.string().optional(),
  attachedTs: millis,
});

const approvalState = z.looseObject({
  id: z.string(),
  ask: z.looseObject({ type: z.string() }),
  correlation: z.looseObject({
    conversationId: z.string().optional(),
    queryId: z.string().optional(),
    turnId: z.string().optional(),
    toolUseId: z.string().optional(),
  }).optional(),
  raisedTs: millis,
  lastPulse: millis,
  settled: z.looseObject({
    approved: z.boolean(),
    by: sender,
    ts: millis,
  }).optional(),
});

export const clientMsg = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('open'),  id: z.string(), conv: z.string(), after: millis.nullable() }),
  z.looseObject({ type: z.literal('close'), id: z.string(), conv: z.string() }),
  z.looseObject({ type: z.literal('say'),   id: z.string(), conv: z.string(), text: z.string(), tip: z.string().nullable(),
                  attachments: z.array(z.looseObject({
                    type: z.string(),
                    source: z.looseObject({ type: z.string(), id: z.string(), bucket: z.string(), mediaType: z.string().optional(), size: z.number().int().optional() }),
                  })).optional() }),
  z.looseObject({ type: z.literal('cancel'), id: z.string(), conv: z.string(), query: z.string() }),
  z.looseObject({ type: z.literal('set_title'), id: z.string(), conv: z.string(), title: z.string() }),
  z.looseObject({ type: z.literal('set_tag'), id: z.string(), conv: z.string(), key: z.string(), value: z.string() }),
  z.looseObject({ type: z.literal('answer'), id: z.string(), approval: z.string(), approved: z.boolean() }),
]);

export const serverMsg = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('list'),         rows: z.array(rowState), tagKeys: z.record(z.string(), z.string()).optional() }),
  z.looseObject({ type: z.literal('row'),          conv: z.string(), lastEvent: millis, lastKind: z.string() }),
  z.looseObject({ type: z.literal('conversation'), id: z.string(), conv: z.string(), messages: z.array(conversationMessage) }),
  z.looseObject({ type: z.literal('closed'),       id: z.string(), conv: z.string() }),
  z.looseObject({ type: z.literal('title_set'),    id: z.string(), conv: z.string() }),
  z.looseObject({ type: z.literal('tag_set'),      id: z.string(), conv: z.string() }),
  z.looseObject({ type: z.literal('approvals'),    approvals: z.array(approvalState) }),
  z.looseObject({ type: z.literal('agents'),       instances: z.array(agentInstance), attachments: z.array(agentAttachment) }),
  z.looseObject({ type: z.literal('agent'),        kind: z.string(), world: z.string(), instanceId: z.string(), ts: millis,
                  conv: z.string().optional(), cwd: z.string().optional(), intervalS: z.number().int().optional(), host: z.string().optional() }),
  z.looseObject({ type: z.literal('approval') }).and(approvalState),
  z.looseObject({ type: z.literal('answer_result'), id: z.string(), outcome: z.literal('accepted') }),
  z.looseObject({ type: z.literal('answer_result'), id: z.string(), outcome: z.literal('rejected'), reason: z.string() }),
  z.looseObject({ type: z.literal('answer_result'), id: z.string(), outcome: z.literal('unreachable') }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('accepted'), query: z.string() }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('rejected'), reason: z.string() }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('unreachable') }),
  z.looseObject({ type: z.literal('cancel_result'), id: z.string(), outcome: z.literal('accepted') }),
  z.looseObject({ type: z.literal('cancel_result'), id: z.string(), outcome: z.literal('rejected'), reason: z.string() }),
  z.looseObject({ type: z.literal('cancel_result'), id: z.string(), outcome: z.literal('unreachable') }),
  z.looseObject({ type: z.literal('message'),      conv: z.string(), message: conversationMessage }),
  z.looseObject({ type: z.literal('query'),        conv: z.string(), queryId: z.string(), reason: z.string() }),
  z.looseObject({ type: z.literal('streaming'),    conv: z.string(), text: z.string() }),
  z.looseObject({ type: z.literal('stream_block'), conv: z.string(), blockType: z.string() }),
  z.looseObject({ type: z.literal('usage'),        conv: z.string(), model: z.string(),
                  inputTokens: z.number().int(), outputTokens: z.number().int(),
                  cacheCreationTokens: z.number().int(),
                  cacheCreation5mTokens: z.number().int(), cacheCreation1hTokens: z.number().int(),
                  cacheReadTokens: z.number().int(),
                  turns: z.number().int(), contextTokens: z.number().int() }),
  z.looseObject({ type: z.literal('error'),        id: z.string(), reason: z.string() }),
]);
```

(The three `say_result` shapes share a `type`; a validating harness routes on
`type` then `outcome`. In Rust these are one enum with an `outcome`-tagged
inner enum; the JSON is as shown.)

## Worked sequence

Connect; watch the fleet; open this conversation; say into it:

```json
→ (connect)
← {"type":"list","rows":[{"conv":"c65b…","lastEvent":1760187514000,"lastKind":"message"}]}
← {"type":"row","conv":"9f21…","lastEvent":1760187515102,"lastKind":"usage"}
→ {"type":"open","id":"r1","conv":"c65b…","after":null}
← {"type":"conversation","id":"r1","conv":"c65b…","messages":[ … ]}
← {"type":"streaming","conv":"c65b…","text":"🫖 Brewing."}
← {"type":"row","conv":"c65b…","lastEvent":1760187520000,"lastKind":"delta"}
← {"type":"message","conv":"c65b…","message":{ "id":"0c27…", … }}
→ {"type":"say","id":"r2","conv":"c65b…","text":"thanks","tip":"0c27…"}
← {"type":"say_result","id":"r2","outcome":"accepted","query":"d810…"}
← {"type":"row","conv":"c65b…","lastEvent":1760187531001,"lastKind":"message"}
← {"type":"message","conv":"c65b…","message":{ "id":"2f66…", "role":"user", … }}
```
