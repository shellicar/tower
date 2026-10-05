# Minimum entries for a resume from the published record

**Question.** What is the minimum the published record must hold for a
resume to send the same request? The aim was the minimum, not a place to put
everything.

**Method.** Recordings from the cancel scenarios replayed against a fake API
(and the real API for some), with entries removed kind by kind; "the same"
means a reduced store holding, resumed, against the full store holding
(every entry kept, resumed with `resumeSessionAt` at the last entry). The
full holding was also checked against the live request.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (3,689 of 3,747 run dirs
logged it).

**Runs.** 3,747 run dirs (2,238 Sonnet, 494 Opus, 483 Fable, 474 Haiku); 9
recordings and 32 resumes on the real API. Branch `proof-minimum-entries`
(e7beff6, 5dbba8a), off `proof-store-commit-resume`.

**Found.** (The agent's report, not re-run.)
- The minimum per model: user and assistant entries plus every attachment
  kind that becomes reminder text: environment, model, session_context, date,
  mcp_instructions_delta, remote_session_change, agent_listing_delta,
  queued_command, compact_boundary, total_tokens_reminder. Re-pointed, it
  gave the same request at 146 pickups.
- Off-chain kinds, `credential_org` and API-error entries can go (the last
  with `resumeSessionAt`).
- `prompt_snapshot` and `stop_hook_summary` are needed at compaction pickups;
  Opus with connectors needs `deferred_tools_delta` plus `prompt_snapshot`
  (resting on 4 pickups).
- Dropping chain entries needs their children re-pointed.
- The API host decides features (a forwarder against the real API against
  first party); an extra `cache_control` marker appears.
- Not settled: compaction, subagents, and other kinds on non-Sonnet models.

**Resume comparison.** Neither, strictly: a reduced store resume against a
full store resume (both store resumes). The full store holding against the
live request is the before-against-after comparison. Neither is a store
resume against Claude Code resuming its own record.

**Used by.** [resume.md](../participant/resume.md),
[resume requirements](resume-requirements.md).
