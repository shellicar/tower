# How subagents can be stopped

**Question.** What each way of stopping does to foreground, background and
nested subagents; how `stopTask` and the model's TaskStop tool behave; how to
list running subagents.

**Method.** `mvp/claude-code-harness/proofs/subagent-stop.mts` (on branch
`feature/research/subagent-stop`, 6462049, unmerged), which builds a tree of
subagents, each running a roughly 90 s loop that writes a timestamp every
2 s; the tick files are the ground truth, with checkpoints listing processes
and transcript sizes. Cases: interrupt, interrupt with the affordance,
stoptask, close, abort, end-input, taskstop-model. A code and docs reading
came first. Stephen ran the live runs himself.

**Versions.** Claude Code 2.1.282, Agent SDK 0.3.282 (in the run's
`run.json`), Haiku 4.5.

**Runs.** 8 run dirs, the seven cases plus one partial interrupt run; abort is
incomplete (a script bug). In the harness worktree's `runs/`, uncommitted.

**Found.**
- `interrupt()` with no affordance stops everything: foreground, background
  and nested (loops went from 6 to 0 within 3 s; host events in about 40 ms).
  This contradicts the code reading.
- With `perTaskStopAffordance`, only the lead's foreground subagents stop;
  background ones run on, and the host hears nothing more about them.
- `stopTask(id)` takes 2 to 5 ms and stops its target within one tick:
  foreground, nested or background. A made-up id and a double stop both
  return success.
- The cascade is inconsistent: a foreground parent took its foreground child;
  a background parent didn't stop its background child, which ran about 50 s
  more (Claude Code issue #95138); stopping a nested child leaves its parent
  running.
- `close()` and `abort()` kill everything about 2 s later (SIGTERM, exit 143),
  with no task events and no result.
- Ending input stops nothing: everything runs to completion, then exit 0.
  Hook callbacks stop when input closes.
- The model's TaskStop (deferred, needs ToolSearch): the lead's works; a
  subagent can stop nothing, not even its own child.
- A nested `task_started` reaches the host (spawn depth 2), with no parent id.
  `background_tasks_changed` lists background agents only. `SubagentStop`
  never fired for stopped subagents.
- A claude.ai Docs connector reached the harness session despite empty
  `settingSources`.
- From docs and code only: the default nesting depth is 3, against a
  changelog line (0.3.217, depth 5 to 1), unresolved; SDK 0.3.287's changelog
  says a `now`-priority message moves running work to the background; Claude
  Code issue #75043 (`not_owner` after a resume). A comment on #75043 with the
  TaskStop cause was drafted, not posted.
- Untested: a background shell under interrupt; a subagent stopping its own
  foreground child; end-input with a background agent outliving the turn.

**Resume comparison.** Not about resume.

**Used by.** [subagents.md](../participant/subagents.md),
[presence.md](../participant/presence.md) (cancel with
`perTaskStopAffordance: true`), [shutdown.md](../participant/shutdown.md)
(stopping tasks in stage 1).
