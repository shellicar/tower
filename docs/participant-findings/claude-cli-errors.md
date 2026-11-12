# How claude-cli shows errors

**Question.** How Stephen's own claude-cli
(`/home/stephen/repos/@shellicar/claude-cli`) shows errors, as an idea for how
tower might.

**Method.** Code reading only; nothing run.

**Found.**
- Errors are plain `[error: <prefix>: <message>]` lines appended to the
  active block and sealed into scrollback. No toast, no colour.
- Account-limit and stream-drop retries each get a notice line per round;
  other retries are silent (up to 10, with 0.5 to 32 s backoff).
- Attempt counts, delays, `retryAfterMs`, request ids and rate-limit headers
  are collected but never shown.
- Notices aren't in the saved API messages, so presumably they don't survive
  a resume (not checked).
- `[stop: <reason>]` is added when a turn doesn't end with `end_turn`.

**Resume comparison.** Not about resume.

**Used by.** [errors.md](../participant/errors.md).
