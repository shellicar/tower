# Shutdown, leftovers, identity and platforms

## Shutdown

- **Each Ctrl-C escalates.** First: exit gracefully, stopping what is in
  flight and waiting for everything to finish. Second: still shut down, but
  don't wait. Third: terminate at once, short of something in the kernel
  preventing it. The three levels are fixed. Provisional: how each stage
  works.
- **The first stage interrupts rather than aborts.** `interrupt()` commits the
  partial reply and a marker within about 50 ms with the store complete.
- **Two graceful stages, then a hard one:**
  - Stage 1 interrupts each Claude Code, stops each subagent and workflow it
    reported still running (by task id, before closing its input), waits for
    it, then sends SIGTERM to whatever is still tagged.
  - Stage 2 sends SIGTERM to each Claude Code's process group, waits, then
    SIGTERM to whatever is left. It never sends SIGKILL.
  - Stage 3 SIGKILLs every tagged process and exits at once.
- **Triggers split by what they mean.** SIGINT and SIGTERM are someone
  asking: each escalates a stage. SIGHUP, stdin closing and a stdin read error
  mean the driver has gone: they start shutdown and never escalate it, so a
  closing terminal (stdin's end, then SIGHUP) stays in stage 1. No timing
  guard between presses.
- **Each stage has a deadline,** and a new trigger escalates at once. The
  `shutdownPolicy` control line carries `gracefulMs` and `teardownMs`, both
  required and replaced together, each 1 to 600,000 ms; `null` is refused.
  Until one is sent, 30 s and 10 s. A deadline sent mid-shutdown applies to
  the next stage.
- **Nothing the participant started survives its exit.** It reaches every
  process whose environment carries its config dir's tag (below), because
  Claude Code runs each command in a session of its own, out of reach of its
  process group. While a Claude Code is alive, its commands are left to it.
- **What the bus sees:** `unavailable`, then `detached` for each
  conversation, then `offline`.
- **One exit code per way of exiting,** in one table in the code
  (`src/ExitCodes.ts`) with a test that no two share a number and all but 0
  sit in 64 to 113: clean (stage 1) 0, stage 2 64, stage 3 65, a bad
  environment value 66, the config dir held by another participant 67, an
  unsupported platform 68, a process list that couldn't be read before the
  participant was ready 69. A crash stays on Node's own 1. Which failures share a code is free to
  change.
- **Each Claude Code runs in its own process group,** so every trigger,
  including a terminal's Ctrl-C, goes through the participant's one path. An
  `interrupt()` that fails against a Claude Code already stopping or gone is
  tolerated. The spawn uses Node's `detached: true` (its own group and
  session on Linux and macOS) with `windowsHide: true`. How Claude Code
  reacts to each signal is in the
  [attempt 3 code review](../participant-findings/integration-attempt-3-review.md).
- **Running as a service** (and what SIGHUP means then) comes later.

Interrupting keeps what was written: abort discards the unfinished piece and
loses lines, and losing everything isn't acceptable
([proof 7](../participant-findings/proof-07-killed-outright.md)). The
deadlines have values before any `shutdownPolicy` line because shutdown has
to work whatever was configured. A failed `interrupt()` is expected, since
something else may have signalled that Claude Code directly.

## Orphans after a hard kill

- Each Claude Code is launched through `setpriv --pdeathsig SIGINT` when
  `setpriv` is available, so a SIGKILLed participant's Claude Codes are
  interrupted within about 2.6 s instead of running on unsupervised. When it
  isn't available it is skipped without a log line. `setpriv` is Linux only,
  so on macOS a SIGKILLed participant can leave a Claude Code running until
  the next start's scan
  ([proof 21](../participant-findings/proof-21-orphans.md)).
- The participant killed outright is an edge case, not make or break.

## Identity and the lock

- **The config dir is the participant's identity.** Each Claude Code is
  spawned with `TOWER_PARTICIPANT=<config dir>` in its environment, which the
  commands it starts inherit. No two agents share a config dir: it is one per
  agent, reused across its runs, never fresh per run.
- **One participant per config dir:** an exclusive sqlite transaction
  (`node:sqlite`) on a file in the config dir, held for the process's life;
  the kernel releases it however the holder dies. A second participant on the
  same dir refuses to start (exit 67).
- **The config dir is owner-only:** a missing one is created `0o700`; one that
  isn't a directory, is a symlink, or isn't the user's is refused; the user's
  own with group or other access is tightened to `0o700`. No ACL check.

The lock is sqlite rather than a pid file because sqlite closes the race a
pid file would leave, and nothing in Claude Code refuses a second process on
one session ([proof 17b](../participant-findings/proof-17b-shared-dir.md)).

## Leftovers

- **Stopped once, at startup,** after the lock is taken. Every process
  carrying this config dir's tag, other than the participant itself, its
  ancestors and its descendants, gets SIGINT, 5 s, SIGTERM, 5 s, SIGKILL.
  Whatever is still there is reported, and the participant serves anyway.
  The scan's waits don't depend on `shutdownPolicy`
  ([proof 25](../participant-findings/proof-25-orphan-tag.md)).
- **Stdin is answered during the scan:** control lines are read and answered
  at once; only launching a Claude Code waits for the scan. A launch during
  the scan may use the values from either moment, with no guarantee either
  way.
- **Recovery is not built:** adding to the store whatever Claude Code's record
  holds that the store lacks, before serving. It was proven to work after
  every kind of ending except a reboot after orphans finish (an accepted edge case). It
  gets built if the participant crashes in practice
  ([proof 17](../participant-findings/proof-17-recovery.md)).

## Platforms

- **Linux and macOS.** Any other platform refuses to start with "platform not
  supported" (exit 68). Windows is planned for v1; tower and bridge already
  run there.
- **The leftover scan reads processes behind an abstract class:** on Linux
  each process's environment from `/proc`; on macOS from `ps -axwwE`.
- **On macOS:**
  - `ps -E` prints the command and the environment as one line, so the tag
    counts only in what follows the plain command line (read again without
    `-E`); a tag named only in a process's arguments is no match. A config dir
    path holding a space can still match ambiguously.
  - The start time is `ps`'s `lstart` text, compared for equality only.
  - macOS hides the environment of its own platform binaries from `ps -E`, so
    a leftover `/bin/sh` or `bash` that Claude Code started isn't found.
    Provisional: accepted as a known gap.
  - A `ps` failure: until the participant is ready, a `ps` that can't be run,
    or a full listing that exits non-zero, ends it with exit 69 and serving
    never starts. After it is ready, the same failure reads as no processes.
    A `ps -p` read exiting non-zero means some pids have gone. A shutdown
    that begins before the participant is ready cancels startup: the scan
    stops as interrupted, a `ps` failure in it no longer counts, and shutdown
    exits with its own code.
  - There's no `setpriv`, and the login works differently (see
    [configuration.md](configuration.md), The login and the private HOME).

## Claude Code exiting on its own (MVP)

Not handled. The next say goes into input nobody reads; later says are
rejected `stale`; `attached` stands, so a new `service` gets
`already_attached`. Undecided: publish `detached` and release the
conversation, or relaunch Claude Code and keep the claim. It comes after
serving from tower in the order of work (see [scope.md](scope.md)).

## Open

Undecided, each built one way for now: stdin closing aborts the scan and
leaves what runs; each stage re-reads the process list; the tag is the
config dir's realpath; parent dirs are created `0o700`; the scan logs full
command lines, which can hold secrets. Stage 2 can SIGTERM a live Claude
Code's commands if its group can't be signalled.

Undecided: whether a third press may lose the last few entries.

Findings: [shutdown live checks](../participant-findings/shutdown-live-checks.md),
[leftovers live checks](../participant-findings/leftovers-live-checks.md).
