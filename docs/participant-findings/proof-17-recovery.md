# Proof 17: recovering blind, whatever ended the last run

**Question.** Can the participant, on every serve, add whatever Claude
Code's record holds that the store lacks, without knowing what ended the last
run? Recovery has to be proven resilient, not special-cased per known ending.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 220, on Sonnet 5, with a file store and the old per-run config
dirs. Branch `proof-17-recovery` (dceefa3 to 6441513), off `proof-7-stopped`.

**Found.**
- Every case recovered everything written (after each Ctrl-C press, SIGKILL,
  a crash, a lone Claude Code SIGKILL, abort, a mid-turn reboot), except a
  reboot after orphans had finished.
- The reply in flight is never written.
- A reboot after a resumed conversation lost 5 and 8 entries (they lived only
  in the SDK's temp copy) while the check reported nothing missing. Accepted
  as an edge case: if the local conversation is gone, the bus is the
  authority anyway.
- The check changed nothing when nothing was missing (70 checks), and took 9
  to 25 ms over 598 to 760 config dirs.
- An orphan still running is detectable. Logging it and serving anyway gives
  two branches, and the next resume follows the orphan's; "lost 0" holds for
  the store only.

**Resume comparison.** Neither: it scored whether the last-written entries
were in the resumed Claude Code's first request (completeness).

**Status.** Recovery is deferred until the participant crashes in practice
(see [shutdown.md](../participant/shutdown.md)).
