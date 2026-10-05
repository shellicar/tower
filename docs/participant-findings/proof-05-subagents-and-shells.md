# Proof 5: subagents and shells

**Question.** Everything Claude Code communicates about subagents and
shells.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (from the run logs).

**Runs.** 17, on Sonnet 5. Branch `proof-5-subagents-shells` (08563fc).

**Found.**
- Nothing from a subagent streams; each block arrives complete, live while
  the subagent runs.
- Subagent text: foreground without `forwardSubagentText`, none; with it,
  yes; background, yes either way (undocumented).
- Subagent thinking: foreground without the flag, never; with
  `display: summarized`, summarised; with no display, empty.
- Channels: `parent_tool_use_id`, `subagent_type`; task_started,
  task_progress, task_updated, task_notification, background_tasks_changed;
  tool_progress, tool_use_result; `result.subagent_stats` (undocumented);
  stopTask, backgroundTasks; SubagentStart and SubagentStop hooks with
  agent_id; transcript and output files; OTEL.
- A background shell sends nothing while it runs.
- A finishing background agent or shell starts a new turn by itself
  (`origin: task-notification`), and its opening user-role message is never
  sent to the host. Background is the Agent tool's default.
- Not run: Monitor; stopping or backgrounding a subagent; nested subagents;
  `perTaskStopAffordance`; permissions inside subagents (see
  [subagent stop](subagent-stop.md) for stopping).

**Resume comparison.** Not about resume.

**Used by.** [subagents.md](../participant/subagents.md),
[running.md](../participant/running.md) (self-started turns),
[publishing.md](../participant/publishing.md) (live replies).
