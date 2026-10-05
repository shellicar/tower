# Proof 6: max tokens

**Question.** Does the SDK report the `max_tokens` actually sent?

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 9 (6 Sonnet 5, 1 Opus 5.5, 1 Fable 5.1, 1 Haiku 4.5). Branch
`proof-6-max-tokens` (787b8a1).

**Found.**
- The SDK never reports the value sent; `modelUsage[].maxOutputTokens` is the
  model's default.
- Sonnet 5 rose from 64,000 to 128,000 through an account experiment
  (`heather_vale`, cached 24 h), which can change with no version change.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` at or below the model's limit is sent
  exactly on every request; above it, the value is capped silently.
- Set very high, it gives 128,000 on Sonnet 5, Opus 5.5 and Fable 5.1, and
  64,000 on Haiku 4.5.
- SDK assistant messages carry `stop_reason: null`, so a turn's stop reason
  has to come from stream events.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md), The
required settings (max tokens).
