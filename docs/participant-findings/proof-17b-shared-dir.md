# Proof 17b: two processes on one session

**Question.** What happens when two Claude Codes share one session and one
config dir? Surely Claude Code refuses, given its lock file?

**Method.** Four variants, strace per variant.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 42, on Sonnet 5. Branch `proof-17b-shared-dir` (f1a9035 to
7b9aa28), on the harness after it moved to one config dir per agent.

**Found.**
- Nothing refuses a second process. `sessions/<pid>.json` is a registration,
  not a lock (no O_EXCL, no flock).
- A store resume always gets its own `/tmp/claude-resume-<uuid>` as
  `CLAUDE_CONFIG_DIR`.
- A resume straight from the dir shares one transcript: interleaved,
  branched, and the next resume keeps the later tip.
- The blind recovery check found the orphan every time.
- Risk: strace captured part of the `sessions/*.key` peer tokens in one run.

**Resume comparison.** Neither: which branch the next resume follows.

**Used by.** [shutdown.md](../participant/shutdown.md) (one participant per
config dir, the sqlite lock). Stephen's ruling here: one config dir per
agent, never one per run.
