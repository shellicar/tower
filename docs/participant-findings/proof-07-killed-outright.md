# Proof 7: stopping and killing Claude Code mid-turn

**Question.** What each way of stopping or killing Claude Code does to what
is committed, and how to recover.

**Method.** `proofs/stopped.mts`, `stopped-q1.sh`, `stopped-q2.sh`. The spawn
hook bypasses the capture wrapper so signals reach the real pid; strace.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 85, on Sonnet 5. Branch `proof-7-stopped` (1d6ce8b, 1b99c34).

**Found.**
- **abort:** the SDK closes input, waits 2 s, then sends SIGTERM. No partial
  reply or marker. Writes after the SIGTERM never reach the store (2 to 9
  lines).
- **`interrupt()`:** the partial reply and a marker (or a rejected tool
  result) within about 40 ms; the store complete.
- **SIGINT to Claude Code:** the same as interrupt; exit 0 in about 0.8 s.
- **SIGTERM:** no partial reply or marker; store complete; exit 143. It
  doesn't cancel the request in flight: one conversation wrote its full reply
  2.5 s later.
- Tool children get SIGTERM about 55 ms after Claude Code stops.
- Three presses: a terminal Ctrl-C makes every Claude Code commit and exit 0.
  A first press implemented as abort loses data.
- SIGKILL of the participant: each Claude Code carries on unsupervised,
  finishes its turn, and exits when its input closes; everything after the
  kill is missing from the store.
- Recovery: find the transcript by session id (the config dir, then
  `/tmp/claude-resume-*`), read it with `importSessionToStore`, dedupe by
  uuid. Tested only after the orphans had exited.

**Resume comparison.** Neither: it judged whether the resumed answer was
correct, not request identity.

**Used by.** [shutdown.md](../participant/shutdown.md). The first Ctrl-C
interrupts because of this proof.
