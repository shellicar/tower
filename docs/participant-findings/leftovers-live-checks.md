# Leftovers: live checks

**Question.** Does the built leftover scan, lock and config-dir handling work
against real processes?

**Method.** Scripts in the building session's scratchpad (`refuse.sh`,
`kill.sh`, `kill2.sh`, `kill3.sh`, `lock2.sh`, `stdin.sh`); not committed.

**Versions.** Model claude-haiku-4-5. Claude Code and Agent SDK versions not
recorded.

**Found.**
- A second participant on the same config dir was refused.
- C, no `setpriv`: 4 leftovers, all gone 2,852 ms after SIGINT.
- A, `setpriv` present: only Claude Code left, gone after 2,399 ms.
- B, both SIGKILLed: an orphaned bash, wait script and sleep, gone in 5 ms.
- The sqlite lock held.
- Stdin was answered 0.56 s into the scan.
- A stand-in leftover that ignored signals: SIGINT at 15.6 s, SIGTERM at
  20.6 s, SIGKILL at 25.6 s, all gone after 10,020 ms.
- SIGTERM and SIGKILL never reached a real Claude Code.
- Also noticed: a stale lock after a reboot could match an unrelated pid
  (sqlite replaced that); the lock's journal file stays after a SIGKILL;
  Windows has no uids, so it is refused at start too.

**Resume comparison.** Not about resume.

**Used by.** [shutdown.md](../participant/shutdown.md).
