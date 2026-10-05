# Proof 3: the session store as the commit signal

**Question.** Does the SDK's session store `append()` work as the commit
signal, and how do shutdown and resume behave with it?

**Method.** `proofs/session-store.mts` (modes turns, resume, shutdown,
`--analyse`), recording `store-appends.jsonl`, `transcript-watch.jsonl` and
`analysis.txt`.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 34, on Sonnet 5. Branch `proof-3-session-store` (532c958).

**Found.**
- With a session store the SDK passes `--session-mirror`; Claude Code prints a
  `transcript_mirror` frame after each local write, and the SDK hands the
  entries to `append()`.
- Every entry reaches `append()` with the same content and order as the
  transcript (52 of 52, eager and batched).
- Eager: 0.3 to 2.3 ms after the disk write. Batched: at the end of the turn.
  `result` is delivered only after the turn's appends. The SDK's assistant
  message is not the committed form. A tool starts before its `tool_use`
  entry is committed.
- Interrupt mid-stream: the partial reply plus a marker. Interrupt mid-tool:
  a rejected tool result (the model is told it was rejected though it ran)
  plus "[Request interrupted by user for tool use]".
- Shutdown with three Claude Codes: an interrupt-based first stage commits
  within about 50 ms; three presses 0 ms apart lost 4 to 5 entries each;
  abort writes no partial reply and drops late writes; a terminal Ctrl-C
  reaches each Claude Code directly.
- Resuming from Claude Code's own files while mirroring needs undocumented
  `extraArgs`. `resume` with a session store always resumes through the
  store, into `/tmp/claude-resume-<uuid>`, deleted on exit, and the local
  files don't get the new turns. In a default install the access token (no
  refresh token) is copied there, and left behind if the host dies (read from
  code).

**Resume comparison.** Neither: resume path and credentials only.

**Used by.** [running.md](../participant/running.md). Stephen chose resume
through the store (the SDK's supported path) after this proof.
