# Scope: v0, the MVP, and after

This file covers what v0 was, what the MVP means, its items and where each
stands, the order of work, and what comes after or not at all. Each item's
detail is in the file for its area, linked from the table; the goals behind
the MVP are in [purpose.md](purpose.md).

## v0 (reached)

v0 made Claude Code addressable from the bus and usable from tower's UI
alone, with auto mode. Its milestone, driving a conversation from tower, was
reached on the test broker: a say from tower got Claude Code's reply back.
v0 proved the concept; it is not the MVP, because individual features are
missing and some behaviour is wrong.

## The MVP

**What it means:** its user using the participant day to day instead of the
terminal, with no scripts outside tower needed to support it. It is not a
product release for other people.

**The measure for an item:** what not having it costs. A risk counts the
effort to build as well as the chance of breakage. A bug that leaves things
broken for good (rather than a transient glitch) weighs more.

**Out of the MVP's way:** tower's own existing usability issues, which belong
to a separate UI revamp. "Future feature" in a decision means MVP or beyond;
it does not by itself put something after the MVP.

**The items**, with where each stands (commits are on
`epic/claude-code-participant`; each built item is checked against the test
broker in [piece live checks](../participant-findings/piece-live-checks.md)):

| Item | What it means | Status |
|---|---|---|
| Cancel behaves like Esc | Cancel stops the turn and its foreground subagents; background subagents run on | Built (ec68c8e) |
| Replies say who wrote them | Every published message carries the right `from`; with none, tower labels it by what it is, falling back to "unknown" | Built (d327899) |
| `ready` only once configured | `ready` is published, and the world's queue joined, only when every required setting is set | Built (7eda1db) |
| No control line leaves a required setting unset | `null`, an empty or whitespace-padded model name, and a text-only `system` line are refused, with tests for every line (see [configuration.md](configuration.md)) | Built (f1498ff, 48cd6c3) |
| A message is never lost | A publish that fails is retried until delivered | Built (c98a481), except messages over the broker's size limit |
| Messages over 1 MB are delivered | The oversize case above, delivered rather than dropped | Not built; a design (see [delivery.md](delivery.md)) |
| Skills | The user's skills, from at least one directory | Not built ([skills.md](skills.md)) |
| Live replies | Each block streamed as it is written, thinking included | Not built ([publishing.md](publishing.md)) |
| Serving from tower | Start a new conversation and continue an existing one from tower | Not built; partly designed ([serving-from-tower.md](serving-from-tower.md)) |
| Re-serve after a restart | Conversations served again automatically when the participant restarts | Not built; details open |
| Stop serving | Stop serving one conversation | Not built; not designed |
| Status line | The user's Claude Code status line fields in tower | Not built ([presence.md](presence.md), Status line) |
| Claude Code exiting on its own | The conversation recovers instead of wedging | Not built ([shutdown.md](shutdown.md)) |
| Sending images | Attaching images to a say from tower | Not built ([object-stores.md](object-stores.md), Images) |
| Approvals | Answering what auto mode escalates | Not built ([approvals.md](approvals.md)) |
| Subagents | What is running, what each is doing, for how long; stopping a runaway or hung one | Not built ([subagents.md](subagents.md)) |

**Not in the MVP:**

- Showing the conversation the way Claude Code's terminal does.
- Resuming a conversation from the bus (the published record). Today a
  conversation resumes from Claude Code's own record on the same machine.
- `chdir`, which comes after the MVP as its own feature across the stack, with
  a proper UI component.
- Keeping Claude Code current automatically (see [building.md](building.md),
  Keeping Claude Code current).
- Subagent shells, and inspecting a subagent's conversation.
- Seeing images Claude Code reads from disk.

## The order of work

Done: cancel, reply author, `ready`, required settings, never losing a
message. Next, in order: over 1 MB, skills, live replies, serving from tower,
re-serve after a restart, stop serving, the status line, Claude Code exiting
on its own, images, approvals, subagents.

Provisional: the order as a whole. No single position in it is decided.

Errors in tower (see [errors.md](errors.md)) and the extras design (see
[publishing.md](publishing.md)) are not placed in the order.

### Why this order

A cancel that isn't like Esc destroys work on every cancel. `ready`, the
reply author and the required settings are cheap correctness. A lost message
breaks a conversation for good. Skills and live replies touch every conversation.
Serving comes before recovery because automatic re-serving turns a recovery
failure into a blip
([cadence](../participant-findings/cadence.md),
[the gap against bridge](../participant-findings/bridge-gap.md)).

## Later, after the MVP

- Queueing messages (v1). Two routes: a spec change, or a `say` whose
  precondition is the current query.
- Claude Code's own rewinds published as `tip.moved`.
- The `tools` control line.
- Running as a service.
- Logging.
- Resuming from the bus.
- Windows (v1).
- `drain` naming its instance.
- The Files API for images.

## Not at all

- File checkpointing.
- A proxy between Claude Code and the API, except as a fallback.

## Open

- Whether publishing everything the model sees is an MVP item. Resuming from
  the bus is not MVP either way.
- Archive: MVP or not.
- How firm re-serving after a restart is, and whether it is an option rather
  than always on.
- Where these items now sit, since the MVP list doesn't name them:
  publishing `query.started` and tower reading it; the permission mode,
  effort and sandbox state per query (the permission mode is inside the
  status line item); a folded status in tower's conversation list with
  `unavailable` and `offline`; the sandbox badge; the repo declaring its
  tools. Whether publishing `query.started` is an item at all is undecided.
