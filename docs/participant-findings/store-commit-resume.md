# Store commit and resume

**Question.** Does committing every store entry unchanged, then resuming with
`resumeSessionAt` at the last committed entry, reproduce the next request?

**Method.** The cancel-scenario recordings replayed against a fake API, with
commit rules R0, R0@, H, Hp, Hl (and their `@` variants) and the OWN/OWN@
references. At mid-conversation pickups (P) each holding's request is
compared with the live run's next request. At end pickups the reference
(OWN@) is Claude Code's own transcript cut at the pickup, loaded through the
same store path, so not a true resume from Claude Code's own record; a true
own-record resume is the reference only for killed runs.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (497 of 499 run dirs
logged it).

**Runs.** 499 run dirs; 78 pickups. Branch `proof-store-commit-resume`
(c8e89db, dcf4638). The matrix is in the worktree's
`runs/commit-resume/plan1/matrix.txt` (not committed).

**Found.**
- R0@ (every entry unchanged, `resumeSessionAt` at the last committed uuid)
  sent the live request at every P pickup, except compaction summaries. The
  committer reads only `uuid`.
- At end pickups it differed from OWN@ in some rows: a SIGKILL or SIGTERM on
  a plain host (a string against a text-block prompt), a pdeathsig run (a
  marker merge), and rows the matrix marks "=c" (meaning not checked).

**Resume comparison.** At P pickups, the resumed request against the live one
(before against after). At end pickups, close to a store resume against
Claude Code's own record, but through the same store path. So "sent the live
request at every pickup" is true of the P pickups, not every end pickup.

**Used by.** "What is committed follows Claude Code" in
[running.md](../participant/running.md).
