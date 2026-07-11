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

## towerd → client

### `list` — once, on connect

```json
{ "type": "list", "rows": [
  { "conv": "c65b902d-…", "lastEvent": 1760187514000, "lastKind": "message" }
] }
```

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
});

export const clientMsg = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('open'),  id: z.string(), conv: z.string(), after: millis.nullable() }),
  z.looseObject({ type: z.literal('close'), id: z.string(), conv: z.string() }),
  z.looseObject({ type: z.literal('say'),   id: z.string(), conv: z.string(), text: z.string(), tip: z.string().nullable() }),
]);

export const serverMsg = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('list'),         rows: z.array(rowState) }),
  z.looseObject({ type: z.literal('row'),          conv: z.string(), lastEvent: millis, lastKind: z.string() }),
  z.looseObject({ type: z.literal('conversation'), id: z.string(), conv: z.string(), messages: z.array(conversationMessage) }),
  z.looseObject({ type: z.literal('closed'),       id: z.string(), conv: z.string() }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('accepted'), query: z.string() }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('rejected'), reason: z.string() }),
  z.looseObject({ type: z.literal('say_result'),   id: z.string(), outcome: z.literal('unreachable') }),
  z.looseObject({ type: z.literal('message'),      conv: z.string(), message: conversationMessage }),
  z.looseObject({ type: z.literal('streaming'),    conv: z.string(), text: z.string() }),
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
