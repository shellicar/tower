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
`role`, the `from` object verbatim from the wire, `content` blocks verbatim
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
  from: sender,
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
  z.looseObject({ type: z.literal('say'),   id: z.string(), conv: z.string(), text: z.string(), tip: z.string().nullable() }),
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
  z.looseObject({ type: z.literal('approval') }).and(approvalState),
  z.looseObject({ type: z.literal('answer_result'), id: z.string(), outcome: z.literal('accepted') }),
  z.looseObject({ type: z.literal('answer_result'), id: z.string(), outcome: z.literal('rejected'), reason: z.string() }),
  z.looseObject({ type: z.literal('answer_result'), id: z.string(), outcome: z.literal('unreachable') }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('accepted'), query: z.string() }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('rejected'), reason: z.string() }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('unreachable') }),
  z.looseObject({ type: z.literal('message'),      conv: z.string(), message: conversationMessage }),
  z.looseObject({ type: z.literal('streaming'),    conv: z.string(), text: z.string() }),
  z.looseObject({ type: z.literal('stream_block'), conv: z.string(), blockType: z.string() }),
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
