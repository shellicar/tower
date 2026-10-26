# Subagents

## Decided

- **Subagents don't show up as conversations of their own,** and aren't
  addressable on the bus. Their entries don't go onto the bus. Addressable
  subagents would likely need first-class support in the spec.
- **Cancel doesn't cancel background subagents.** Cancel behaves like Esc:
  the turn and its foreground subagents stop, background ones keep running.
  Stopping one agent at a time is a future feature (see
  [presence.md](presence.md)).
- **Shutdown stops them:** stage 1 stops each running subagent and workflow
  task by id before closing Claude Code's input. Shells are left to Claude
  Code.
- **A background agent's report, handed back to the main conversation, is
  published** (the model sees it), with `from: {kind: "agent"}` (see
  [publishing.md](publishing.md)).
- **The MVP covers basic metrics and stopping:** what is running, what each
  subagent is doing and for how long, and stopping a runaway or hung one.
  After the MVP: shells, and inspecting a subagent's conversation.

## What the SDK offers

From the subagent and stop proofs
([proof 5](../participant-findings/proof-05-subagents-and-shells.md),
[subagent stop](../participant-findings/subagent-stop.md)):

- `task_started` fires for every subagent, nested ones included (description,
  depth, no parent id; the parent can be derived through `tool_use_id`).
  `task_notification` and `task_updated` mark the end;
  `background_tasks_changed` lists background agents only.
- `stopTask(id)` stops its target within milliseconds at any depth. A wrong
  id also reports success. Stopping a background parent leaves its background
  children running (Claude Code issue #95138).
- `interrupt()` without `perTaskStopAffordance` stops everything, background
  included.
- The participant already tracks running tasks, for shutdown.
- Nothing from a subagent streams; foreground subagents send only tool calls
  unless `forwardSubagentText` is set; background ones send everything.

## Open

- Whether the publish rule covers what a subagent's model sees, given that
  subagent entries don't go onto the bus.
- For the MVP item: stop all or one at a time; which fields; where they ride
  on the wire.
- What a resume does with a queued "stopped" notification (untested).
