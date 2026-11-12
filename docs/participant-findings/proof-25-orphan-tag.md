# Proof 25: tagging each Claude Code to find leftovers

**Question.** Does an environment tag on each Claude Code close proof 21's
pid-file gap? Prove that it works.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 84 runs, 168 conversations; 740 run dirs, on Sonnet 5. Branch
`proof-25-orphan-tag` (3ffe775 to 33dd70b). The tag was then called
`TOWER_AGENT`; the build uses `TOWER_PARTICIPANT=<config dir>`.

**Found.**
- Every Claude Code was found, including proof 21's misses, with serves
  starting 1 to 7 ms after the death; no fork.
- Edges: tools exiting 1 to 3 ms into a scan; reading an environment fails
  with EACCES in a process's last 1 to 13 ms (21 of 26,072 samples); a
  thread-group leader can read as a zombie.
- The control (no tag) forked in every crash cell.
- The harness's own process lister missed every store-resumed Claude Code.
- More scan edge cases, gathered from the proofs and the third integration
  attempt, are in the [attempt 3 code review](integration-attempt-3-review.md).

**Resume comparison.** Neither.

**Used by.** [shutdown.md](../participant/shutdown.md) (identity, leftovers).
