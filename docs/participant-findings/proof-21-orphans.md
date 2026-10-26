# Proof 21: stopping an orphaned Claude Code

**Question.** Two layers against orphans: layer 2 (find a leftover, SIGINT
it, wait, recover, serve) and layer 1 (`setpriv --pdeathsig SIGINT`). Does
layer 1 add anything over layer 2 alone?

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 32 runs, 64 conversations; 236 run dirs, on Sonnet 5. Branch
`proof-21-orphans` (9b1c3b9 to 4a12a58).

**Found.**
- Layer 2 works on a normal orphan: it exits 2.5 to 2.9 s after SIGINT, with
  no fork.
- Gap: Claude Code deletes its pid file 3 to 27 ms after SIGINT or SIGTERM
  but runs on 2.5 to 2.9 s, so an orphan already shutting down is invisible
  to a pid-file scan.
- Layer 1 fires on SIGKILL and adds nothing on a JavaScript crash (the SDK's
  exit handler covers that). Without it, a SIGKILL orphan ran 36 to 64 s and
  finished its tool.
- "No response requested." starts every serve after an interrupt.

**Resume comparison.** Neither: completeness (no fork, everything carried).

**Used by.** [shutdown.md](../participant/shutdown.md) (setpriv when
available). The pid-file gap led to [proof 25](proof-25-orphan-tag.md).
