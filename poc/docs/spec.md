# POC spec — agent over NATS

The contract every component builds against. Four components, four separate sessions,
no shared code: if the parts interoperate, the spec did its job. The protocol is the
only surface.

## Components

| Component  | What it is                                                         | Language |
|------------|--------------------------------------------------------------------|----------|
| fake-model | HTTP server with a Messages-API-shaped streaming endpoint          | Rust     |
| agent      | Headless process: NATS bridge up, streaming HTTP client down       | Rust     |
| tui        | Terminal client: renders a conversation, sends input (ratatui ok)  | Rust     |
| tower      | Dashboard webapp: discovers agents, live-watches their events      | Rust backend (axum, NATS client, WS gateway) + TS frontend |

NATS itself runs in docker and is not a component anyone builds.

## Topology

```
tui ──┐                        ┌── agent.{id}.messages ──► agent ──► fake-model (HTTP/SSE)
      ├──── NATS (docker) ─────┤
tower ─┘                       └── agent.{id}.events ◄─── agent
```

Every client speaks only NATS. The agent is the only component that speaks HTTP.

## NATS subjects

- `agent.announce` — agents publish `agent_ready` here at startup. Discovery: Tower
  (or any client) subscribes here to learn which agents exist. Additionally, any event
  arriving on `agent.*.events` from an unknown agent id counts as discovery of that
  agent — so a client started after the agents still finds them as soon as they speak.
- `agent.{id}.events` — the agent publishes all its events here (including a copy of
  its `agent_ready`). Broadcast: any number of subscribers.
- `agent.{id}.messages` — the agent subscribes here; clients publish messages to it.
- `agent.{id}.history` — DESIRABLE (see below). NATS request/reply.

`{id}` is the agent id: lowercase alphanumeric plus hyphens, unique per agent process.
Given as a CLI argument; if absent, the agent generates one (short random suffix, e.g.
`agent-4f2a`).

## Wire shapes

JSON, UTF-8, one object per NATS message. Unknown fields must be ignored; unknown
`type` values must be skipped without error (forward compatibility).

### Events (agent → subscribers, on `agent.{id}.events`)

```json
{ "type": "agent_ready", "agentId": "agent-4f2a" }
{ "type": "turn_started", "turnId": "t-1", "text": "What's 2+2?", "from": { "kind": "human" } }
{ "type": "text_delta",   "turnId": "t-1", "text": "hello" }
{ "type": "turn_ended",   "turnId": "t-1", "stopReason": "end_turn" }
{ "type": "error",        "message": "turn already in progress" }
{ "type": "error",        "turnId": "t-1", "message": "model call failed" }
```

- `turnId`: agent-assigned, unique within the agent's life.
- `turn_started` carries the input `text` and `from` that began the turn, so every
  subscriber sees both sides of the conversation, not just the assistant's.
- `stopReason`: `"end_turn"` (normal) or `"error"` (model call failed mid-turn).
- `error` is a broadcast event, not addressed to the sender (per-client responses are
  out of scope for this POC). `turnId` is optional: present when a running turn failed
  mid-flight, absent when an input was rejected — which distinguishes the two.

### Messages (client → agent, on `agent.{id}.messages`)

```json
{ "type": "user_input", "from": { "kind": "human" }, "text": "What's 2+2?" }
```

- `from.kind`: `"human"` | `"orchestrator"`. Nothing else in identity for the POC.

## Turn semantics

- One turn at a time. A `user_input` arriving while a turn runs is rejected with an
  `error` event and is NOT queued.
- A turn: agent receives `user_input` → emits `turn_started` → calls the model,
  appending the input to its in-memory conversation → emits one `text_delta` per SSE
  text chunk received → on stream end, appends the assistant reply to the conversation
  and emits `turn_ended`.
- The conversation lives in agent memory only. No persistence.
- If the model call fails, emit `error` then `turn_ended` with `stopReason: "error"`.

## Fake model contract

An HTTP server on **port 8090** exposing a shape-faithful subset of the Anthropic
Messages API. Purpose: the agent's model adapter is a real streaming HTTP client, with
no real key and no network dependency.

**Request**: `POST /v1/messages`

```json
{
  "model": "fake-1",
  "stream": true,
  "max_tokens": 1024,
  "messages": [ { "role": "user", "content": "What's 2+2?" } ]
}
```

`messages` alternates `user` / `assistant` roles; `content` is a plain string.

**Response**: `200`, `Content-Type: text/event-stream`, SSE events in this order:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","role":"assistant"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"4"}}

(… more content_block_delta events …)

event: message_stop
data: {"type":"message_stop"}
```

**Behaviour**: scripted, deterministic-ish. The reply is generated from the last user
message (e.g. a canned sentence that quotes it back), streamed word-by-word with a
small delay (~50ms) between deltas so streaming is visible in the clients.

Invalid body → `400` with `{ "error": "..." }`.

## Component responsibilities

**fake-model** — the HTTP contract above. Nothing else. No NATS.

**agent** — CLI args: agent id (optional), NATS URL (default `nats://localhost:4222`),
model URL (default `http://localhost:8090`). On start: connect NATS, publish
`agent_ready` on `agent.announce` and on its own events subject, subscribe to its
messages subject, run turns per the semantics above.

**tui** — CLI arg: agent id to attach to. Subscribes to the agent's events, renders
the conversation with live streaming text, takes typed input, publishes `user_input`.
Ratatui (or any library) allowed.

**tower** — backend: NATS client subscribed to `agent.announce` and `agent.*.events`,
serving the frontend and forwarding events over a WebSocket. Frontend: a responsive
dashboard of movable/resizable panels — one panel per discovered agent showing its
live event feed and current streaming text; agents appear as they announce.

## Runbook

Start order: NATS → fake-model → agent(s) → tui / tower.

```
docker run -d --name poc-nats -p 4222:4222 nats:latest
```

Ports: NATS 4222, fake-model 8090, tower web 8091.

Done when: two agents running, the TUI attached to one holding a streamed
conversation, and the tower dashboard showing both agents' live feeds at once.

## Desirable (not required)

- **History** — request/reply on `agent.{id}.history`: empty request payload; reply
  `{ "messages": [ { "role": "user"|"assistant", "content": "..." } ] }`. Lets a
  late-attaching client catch up instead of starting blank.
- **Heartbeat** — agent republishes `agent_ready` on `agent.announce` every 10s, so
  Tower can mark dead agents stale.
