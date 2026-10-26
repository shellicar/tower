# Cancel and kill, over the SDK and the CLI

**Question.** What Claude Code keeps and sends next after each way of
cancelling or killing it, over the SDK and in the interactive CLI.

**Method.**
- `cancel-scenarios` and `cancel-sdk-d` (the latter adds a fault-injecting
  forwarder): the SDK runner. Interrupt, kill (SIGTERM, SIGHUP, SIGINT,
  SIGKILL), abort, push; then a store resume and a transcript resume per
  scenario, with or without `resumeSessionAt`.
- `cancel-cli`: the interactive CLI driven through tmux.

**Versions.** SDK runs: Agent SDK 0.3.282, Claude Code 2.1.282. CLI runs:
Claude Code 2.1.283.

**Runs.** 178 and 477 run dirs (SDK), 133 (CLI), on Sonnet 5. Branches
`cancel-scenarios` (ea1f6f4 to a4b9cd2), `cancel-sdk-d` (3acef27 to 70b0591),
`cancel-cli` (6da5882 to 3cb11b3). The recordings feed
[store commit and resume](store-commit-resume.md) and
[minimum entries](minimum-entries.md).

**Found.**
- Every scenario was covered except auto-compaction in the CLI. The full
  report exists only in the session that ran it.
- Over the SDK, an Esc during thinking keeps the prompt and sends it next
  time: a straight line (prompt, marker, next prompt, merged into one user
  message). In Stephen's CLI transcripts the cancelled prompt is a dead end
  the next prompt branches around. Whether the difference is the version or
  the interactive Esc against `interrupt()` isn't settled.
- A kill leaves the prompt; on restart Claude Code adds its own "No response
  requested." (model `<synthetic>`) under it.
- From the committer options report (its file, `/tmp/committer-options/
  final-report.md`, is gone): anchoring fails when a resume from tower differs
  from what Claude Code sent, and a killed participant loses Claude Code's
  last writes from the store.

**Resume comparison.** Unclear: both a store and a transcript resume were
recorded per scenario, but no verdict comparing them was found.
