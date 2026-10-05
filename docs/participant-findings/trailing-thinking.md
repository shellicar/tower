# When Claude Code keeps a thinking-only reply

**Question.** When does Claude Code keep a reply that is only thinking?

**Method.** Code reading of the linux-x64 binary.

**Versions.** Claude Code 2.1.282.

**Found.**
- The `preserveTrailingThinking` path exists but is off by default. It needs
  the remote flag `tengu_thinking_block_resumption`, a first-party model
  that isn't Claude 3, the beta `thinking-resumption-2026-07-17`, and a server
  mark `resumable: true`. It fires when a response is a single signed thinking
  block cut off by `max_tokens`.
- When it fires, the next request keeps that reply as the trailing assistant
  message, and every frame of the continuation carries
  `resumed_from_incomplete_thinking: true`. It is dropped again when attempts
  run out (3), the resume is refused, the beta is rejected, the model
  changes, or the continuation is empty.
- It is turned off by `DISABLE_GROWTHBOOK`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`,
  `DO_NOT_TRACK` and `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`.
- Otherwise a thinking-only reply is written, then dropped (see
  [proof 23](proof-23-commit-timing.md)); a hold-until-sibling rule is R19 in
  the [resume requirements](resume-requirements.md).

**Resume comparison.** Not about resume.
