# Shutdown: live checks and findings

**Question.** Does the three-stage shutdown escalate and clean up as
designed, against real Claude Codes?

**Method.** Scenarios A, A0, B, C, D, E, F, I, G2 and H, then fix-round runs P,
Q, R, S and U; a reviewer's pty probe. Logs in the building session's
scratchpad; `scripts/shutdown-check.ts` in the app.

**Versions.** Claude Code 2.1.283, claude-haiku-4-5. Agent SDK version not
recorded.

**Found.**
- Each trigger and each deadline escalated as designed. A terminal closing
  stays in stage 1 (exit 0).
- Stage 2's process-group kill doesn't reach Bash commands, which run in
  sessions of their own; hence the tag sweep.
- Back-to-back signals merge in the kernel.
- Stage 3's `process.exit` still makes the SDK's exit handler SIGTERM every
  Claude Code. The SDK installs no signal handlers.
- An interrupt written after stdin ends is silently dropped.
- `interrupt({cancelQueued: true})` works at runtime but isn't in the type
  definition.
- A hung `sessionStore.append` can hold the SDK up to about 60 s.
- A terminal closing gives stdin end, then SIGHUP 1 to 3 ms later.
- Claude Code refuses `setsid` without asking.
- Latent: a conversation launched after stage 1 begins is neither
  interrupted nor swept (`service` is rejected once not serving; the window
  during a launch already under way isn't verified); stage 2 can SIGTERM a
  live Claude Code's commands if its group can't be signalled (EPERM).
- From the later cancel piece, which added stopping subagents at shutdown:
  with a background subagent stopped at shutdown, Claude Code exits 1 and
  logs a misleading "process exited with code 1", while the participant still
  exits 0. Stopping subagents before interrupting caused an extra turn, so
  the order matters.

**Resume comparison.** Not about resume (two scenarios resumed only to check
no resume copy is made).

**Used by.** [shutdown.md](../participant/shutdown.md).
