# Tap spec — v1

The stage-1 contract from `roadmap.md`: the existing node CLI publishes observability
events to NATS; consumers (the tower dashboard first, anything else as a peer) read
them. Two missions build against this page — the CLI tap and the dashboard — and
never talk to each other. The spec is the only surface.

## Glossary

The word "session" is retired — too overloaded. The terms:

- **conversation** — the durable thing. `conversationId` is *the* identity on the
  wire. Pre-generatable by the creator (the fleet scripts already do this — no
  scraping); survives resume.
- **run** — one process execution attached to a conversation: pid, started, ended.
  A conversation has many runs across restarts and resumes. Liveness belongs to the
  run; continuity belongs to the conversation.
- **label** — creator-supplied metadata on `run_started`: org, mission, role, kind —
  whatever the creator knows. Free-form map; never parsed for identity. Organisation
  (the tmux-server taxonomy) lives here, not in the subject tree.
- **location** — optional part of the label: a navigable address for where the run
  lives, so "waiting on you" comes with a way to arrive. For today's fleet, tmux
  coordinates self-reported by the CLI at startup; a containered run reports
  something else or nothing.

## Subjects and versioning

- `tap.v1.{conversationId}.events` — the run publishes all events here. Broadcast.
- `tap.v1.{conversationId}.requests` — **reserved, empty in v1.** The
  request/response channel (addressed, response routed to sender) for when a
  consumer answers an approval remotely or an orchestration escalation needs a
  human decision. Named now so it lands later without re-architecture.

The major version lives in the subject. Within v1, evolution is add-only: new event
types, new optional fields, new enum values. Producers may only add; consumers must
tolerate additions:

- unknown event types are skipped without error,
- unknown fields are ignored,
- unknown enum values are non-fatal.

Both halves of that discipline are required. A breaking change (remove a field,
change a meaning) is a new subject tree — old consumers keep working, migration is
unhurried, a bridge can republish between versions if needed.

## Persistence (JetStream)

Plain broadcast has no memory — an event with no subscriber never happened, and the
Cage's *record now, analyse later* would be an empty claim. So the broker runs with
JetStream enabled and one stream captures `tap.v1.>`.

- **Publishers don't change**: still plain publishes to the same subjects.
- **Live consumers don't change**: the dashboard is an ordinary subscriber.
- **Analytics and late joiners replay the stream** — catch-up and history are a
  JetStream read, not a spec feature.

The spec requires the stream to exist; retention policy (age/size limits) is
deployment configuration, not contract.

## Events vs requests

Two kinds of traffic, per the architecture docs:

- **Events** — things that happened. Broadcast, cannot be rejected. Everything in
  v1 is an event — including `approval_pending`/`approval_settled`, which in v1 are
  events *about* a request being resolved elsewhere (the CLI's own UI answers it;
  the wire only observes).
- **Requests** — operations with a response pair; something waits on them. Empty in
  v1; the reserved subject is their home.

Two approval layers exist, one built, one named:

- **Agent-level** (v1): may the process do this — deletes, network calls (curl,
  git, az). The `approval_*` events observe this layer.
- **Orchestration-level** (future): human intervention in the workflow — supervisor
  failed the phase, retry Y/N; handler approved, continue Y/N. Lands later as new
  request types on the reserved channel; the dashboard's "waiting on you" state
  generalises to both.

## Events

Every event carries `run` and `ts` (ISO-8601 with UTC offset) — cost analytics
without time is not analytics. The table lists only the fields each event adds.
(Known wart, accepted for v1: with no mediator there is
no handshake to bind a channel to a run, so the stream must be self-describing.
When tower becomes a mediator — control plane — a run registers at connect, the
channel is the identity, and per-event `run` can be dropped in v2.)

| Event | Fields | Notes |
|---|---|---|
| `run_started` | `conv`, `pid`, `label` (incl. optional `location`) | announce + discovery; label repeats here so a late consumer needs no history |
| `run_ended` | `reason` | clean exit only — crash is heartbeat silence |
| `heartbeat` | — | ~15s cadence |
| `turn_started` | — | |
| `turn_ended` | `stopReason` | |
| `tool_use` | `id`, `name`, `input` | `id` is the opaque tool-use id (`toolu_…`); `input` included — approvals are unreviewable without the payload |
| `approval_pending` | `toolUseId` | references the `tool_use`; the "waiting on you" signal |
| `approval_settled` | `toolUseId`, `approved` | |
| `usage` | `inputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `outputTokens`, `costUsd` | per turn, straight from the SDK's `message_usage` |

Deliberate exclusions, all reversible under add-only: no text deltas (monitoring,
not mirroring — republishing conversations is a later, deliberate decision), and no
prediction yet. When the bookie exists, prediction has exactly two homes: run-level
in `run_started`'s label, phase-level as an optional field on `phase_done` — no
schema change either way. This is the single story; the roadmap defers to it.

**Reserved for stage 2 (orchestration, not v1):** `phase_done` — the done-signal
with a debrief pointer (`debriefRef`) and optional prediction. Named here so the
roadmap's review-surface constraint (signals carry debrief pointers from the start)
is not silently dropped; it lands under add-only when stage 2 is real.

The tap is a thin projection of events the SDK already emits: `message_start`/`done`
→ turn start/end, `tool_use_input_stop` → `tool_use`, `tool_approval_request`/
`response` → the approval pair, `message_usage` → `usage`.

## Worked example

One conversation, a crash, a resume — all on `tap.v1.conv-abc.events`:

```json
{ "type": "run_started", "conv": "conv-abc", "run": "run-12345", "ts": "2026-07-05T17:39:58+10:00",
  "pid": 4021,
  "label": { "org": "shellicar", "mission": "markdown-render", "role": "operator",
             "location": { "tmux": { "socket": "shellicar", "pane": "claude-cli:2.0" } } } }

{ "type": "turn_started",  "run": "run-12345", "ts": "2026-07-05T17:40:11+10:00" }
{ "type": "tool_use",      "run": "run-12345", "ts": "2026-07-05T17:40:19+10:00",
  "id": "toolu_01ABC", "name": "DeleteFile",
  "input": { "content": { "type": "files", "values": ["./old.ts"] } } }
{ "type": "approval_pending", "run": "run-12345", "ts": "2026-07-05T17:40:19+10:00", "toolUseId": "toolu_01ABC" }
{ "type": "approval_settled", "run": "run-12345", "ts": "2026-07-05T17:41:02+10:00", "toolUseId": "toolu_01ABC", "approved": true }
{ "type": "turn_ended",    "run": "run-12345", "ts": "2026-07-05T17:41:20+10:00", "stopReason": "end_turn" }
{ "type": "usage",         "run": "run-12345", "ts": "2026-07-05T17:41:20+10:00", "inputTokens": 9120,
  "cacheCreationTokens": 0, "cacheReadTokens": 84210, "outputTokens": 640, "costUsd": 0.041 }

{ "type": "heartbeat",     "run": "run-12345", "ts": "2026-07-05T17:41:35+10:00" }
// heartbeats stop — process killed, no run_ended: consumers mark the run stale

{ "type": "run_started", "conv": "conv-abc", "run": "run-6789", "ts": "2026-07-05T18:03:41+10:00",
  "pid": 7788,
  "label": { "org": "shellicar", "mission": "markdown-render", "role": "operator" } }
```

**Recommended projection** — intended use, not a property of the events. On the
wire, `run` is only a correlation id; live, stale, and retired are state a consumer
derives by folding the stream. These rules are published so independent consumers
project *consistently*, which is the actual value:

- Continuity is the conversation: one panel, timeline unbroken across runs.
- Liveness is the run: heartbeat silence means stale; a newer `run_started` for the
  same conversation means the older run is gone (one live run per conversation —
  an assumption the CLI enforces, not the wire).
- A run projected stale or gone voids its pending approvals — "waiting on you"
  clears with the run, so a crash mid-approval never dangles.

## Configuration

```json
"tap": { "enabled": true, "url": "nats://localhost:4222" }
```

- `enabled` and `url` are separate — enabling is never done by editing a URL.
- **Disabled (default): zero effect.** No connection, no dependency, the CLI is
  exactly what it is today.
- **Enabled: fail fast.** If the broker is unreachable at startup, say so loudly.
  A session that silently becomes invisible is observability rot — the forgotten
  broker restart must fail once, visibly, not as quiet absence from the dashboard.
- **Mid-run disconnects: tolerated, explicitly.** Network partitions during
  operation are an accepted risk, for now — and likely never a real problem to
  solve: if NATS is down, nothing could have delivered the events anyway. The tap
  relies on the client's auto-reconnect with buffering, and must never interrupt
  the session over observability — the asymmetry with startup is deliberate (at
  startup the tap is the thing being asked for; mid-turn the conversation is).
  A prolonged outage shows as staleness on the dashboard and a gap in the JetStream
  record — an honest hole, not a lie. Events dropped past the reconnect buffer are
  simply lost.

## What consumers may assume

- Events for one run arrive in order (single publisher, single connection).
- Live subscribers joining late see nothing until the next event; discovery is any
  event from an unknown conversation (plus `run_started` when it comes). Catch-up
  and history are a JetStream replay, not a live-subscription feature.
- No localhost assumptions anywhere — broker URL is always configuration, on both
  ends. A containered run on the same subjects is just another publisher.
