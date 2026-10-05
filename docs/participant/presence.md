# Presence on the bus, and the requests

The spec states the events and requests as reference (`docs/spec/agent.md`,
`docs/spec/conversation.md`). This file says how the participant uses them.

## The agent events

- **Three events: `ready`, `unavailable`, `offline`.**
  - `ready`: the instance can receive requests, and pulses.
  - `unavailable`: it can't receive requests, and still pulses, because its
    next state is `offline` or `ready`.
  - `offline`: it stops pulsing and is inert.
- **`offline` doesn't require the process to exit.** Provisional: it may be
  required later if this causes problems.
- **`offline` is final for its `instanceId`.** A process that can take
  requests again publishes `ready` under a new `instanceId`.
- **`ready` only once the participant can serve:** after it has connected,
  delivered what an earlier run left in its outbox, finished the leftover
  scan, and had every required setting set. Only then does it join the
  world's queue group, publish `ready` and start pulsing. A `start()` left
  waiting when shutdown comes first is never awaited.
- **Once `unavailable`, it takes no new work.** It unsubscribes from the
  world's requests, then publishes `unavailable`. A `service`, or a `say` on
  a conversation it still holds, is rejected `unavailable`. It may stay
  subscribed to its conversations until it detaches. A request that then
  finds no responder is expected.
- **At shutdown the bus sees** `unavailable`, then `detached` for each
  conversation held, then `offline`.
- **`drain` is answered `unsupported`;** the participant stops on signals
  (see [shutdown.md](shutdown.md)).

`unavailable` lets an instance say it is no longer available before it stops
subscribing. `offline` lets tower know at once that the instance has stopped,
rather than after its pulse goes quiet. `offline` is final because otherwise
a live holder that had published `offline` would read as stranded, and its
conversations could be taken over.

## The requests

- **`service`:**
  - without a cwd: rejected `invalid`. Every conversation brings its own cwd;
    there is no process-wide or default one.
  - with a cwd that can't be used: rejected `invalid_cwd`.
  - without a conversation id: rejected `invalid`; an id that isn't a UUID is
    rejected too.
  - naming a model: rejected `unsupported` (the spec lets presence bind a
    model; `src/Presence.ts`, marked as work left).
  - for a conversation already served: the spec's premise rules decide it
    within a world. The participant doesn't read the premise yet: a
    conversation this instance doesn't hold is always taken
    (`src/Presence.ts`, marked as work left).
- **`say`:**
  - checked against the tip in Claude Code's own record.
  - while a query runs: rejected (`stale`). There is no queueing; the flow is
    cancel, then say. Queueing is v1, by one of two routes: a spec change, or
    a `say` whose precondition is the current query.
  - carrying attachments: rejected `unsupported` until sending images is
    built (see [object-stores.md](object-stores.md), Images).
- **`cancel`** names a query id. It behaves like Esc in Claude Code's
  terminal: the turn and its foreground subagents stop, background subagents
  keep running. The query is launched with `perTaskStopAffordance: true`;
  without it, an interrupt stops background subagents too
  ([subagent stop](../participant-findings/subagent-stop.md)). Stopping one
  agent at a time is a future feature. What reaches `changes` afterwards is
  whatever Claude Code kept.
- **`chdir`** is answered `unsupported`; it comes after the MVP as a feature
  across the stack. How it will work: through Claude Code's undocumented
  `set_cwd` (answered `unsupported` if a version removes it), answering
  Claude Code's folder-trust question with `trust_accepted: true`, and
  rejecting a `chdir` while a query runs with `busy`, since `set_cwd` works
  only when idle.
- **Where bridge is off the spec, the participant follows the spec:**
  `instanceId` on change events, `detached` on a clean exit, and `usage` per
  usage frame once it publishes telemetry (it publishes none yet).

The spec was built for several users sharing a conversation, which is why a
`say` during a running query is stale rather than queued.

## The connection

Once connected, the NATS client reconnects without limit. A broker that
can't be reached at start ends the process (see [delivery.md](delivery.md)).
`ready` is not published again after a reconnect.

## The status line (MVP)

The user's Claude Code status line, in tower: folder name, model, output
style, cost, session duration, turns, input and output tokens, context used
of its size and the percentage left, the session title, and the permission
mode. Each field is independent and none is required. The question is
whether NATS has a channel for each: tower's usage line today is fed by
bridge's `telemetry.turn.started` and `telemetry.usage`, with cost and
context computed in the browser; the participant publishes no telemetry, and
there is no channel for the title, output style or mode. The title can ride
as an extra field. Nothing here is designed yet.

## Parked

- **`drain` can't choose its instance.** It goes to the world's queue group,
  so whichever instance NATS picks answers; the spec states this as a known
  limitation. The shape for the fix: `drain` names the `instanceId` in its
  body (never in the subject), every instance receives it and only the named
  one acts, and a `drain` reaching an instance already `unavailable` is
  `accepted`. A restart is meant for a chosen agent, not a random one.

## Open

Undecided, each built one way for now (some follow the spec or bridge):

- `service` while not configured is answered `failed`; a cwd starting with
  `~` is `invalid_cwd` (bridge expands `~`); a malformed `say` or `cancel` is
  `invalid`; a `say` that throws is `failed`.
- The queue group is named `servicers`, shared with bridge, so a world mixing
  both splits `service` requests at random.
- `ready` carries no `host`; the pulse interval is 30 s.
- The tip is not carried on `attached`.
- No watch for being displaced from a conversation.
- A turn Claude Code starts itself is not tracked as a running query.
- Incoming `ts` isn't validated.

What happens after the participant's own Claude Code exits on its own is an
MVP item (see [shutdown.md](shutdown.md)).
