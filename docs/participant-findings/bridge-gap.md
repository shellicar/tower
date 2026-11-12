# The participant against bridge and tower

**Question.** What the participant lacked, on 2 Oct, against bridge plus
tower, and how long bridge took to become usable.

**Method.** An agent's reading of git history and code.

**Found.**
- Bridge's timeline: first served 13 Jul, with streaming; tools and approvals
  15 Jul; adopt and self-heal 15 to 16 Jul; attachments, cancel and liveness
  15 Jul; usage and cost 16 Jul; full tools, token refresh, memory and
  history, caching and cwd 19 Jul (from bugs found by using it); the model
  name 22 Jul; permission policy 23 Jul; retry 24 Aug; adopt replaying the
  whole record 29 Aug. Daily use from about 19 to 20 Jul.
- What the participant lacked against bridge: deltas; all conversation
  telemetry (`turn.*`, `tool.use`, `usage`); `from` on replies (since built);
  attachments on a say; `chdir`; approvals; re-serving after a restart;
  surviving broker loss (since built); a dropped or oversized message leaving
  says stale (the dropped case since fixed); Claude Code exiting on its own;
  towerd showing durable images; skills.
- Not parity gaps (bridge never had them): `query.started`, subagent and
  shell display, mode, effort and sandbox per query, a folded status,
  `unavailable` and `offline` display.
- Missed by the plan at the time: usage telemetry; turn telemetry and the
  model name; re-serving after a restart; `chdir`; the cause of over-1 MB
  messages; the towerd durable route. Usage and turn telemetry partly fall
  under the status line item; the towerd durable route isn't in the order.

**Resume comparison.** Not applicable.

**Used by.** [scope.md](../participant/scope.md).
