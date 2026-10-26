# Proof 1: summarised thinking

**Question.** Does summarised thinking work end to end through the SDK, and
what switches it off?

**Method.** `proofs/thinking.mts <model> <scenario>` on the proof harness,
streaming (`includePartialMessages`), with scenarios summarized, omitted,
none, long, long-summarized, tools, setting and switch. Requests read through
Claude Code's own `OTEL_LOG_RAW_API_BODIES=file:<dir>`, no proxy.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (the SDK's bundled
binary).

**Runs.** Sonnet 5, Opus 5.5, Fable 5.1, Haiku 4.5. The run count isn't
recorded. Code: commit ce55fd8 on `claude-code-harness`, not merged.

**Found.**
- With `display: 'summarized'`, thinking deltas carry text and the complete
  message carries the summary, on Sonnet 5, Opus 5.5 and Fable 5.1. Haiku 4.5
  works too (with a budget, 31,999).
- With no display set, Claude Code asks for `display: "updates"` (beta
  `thinking-display-updates-2026-08-18`), which returns no summary. An
  explicit `omitted` becomes `updates` too. `showThinkingSummaries: true` in
  settings doesn't turn summaries on.
- `setMaxThinkingTokens(null, 'summarized')` switches the next turn with no
  prompt-cache break.
- Empty thinking blocks are emitted (with a signature) and kept in the
  transcript.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` drops the display.
- Bedrock, Vertex and gateways untested.
- Risks seen: account connectors reach runs despite `settingSources: []`;
  every session sends its first prompt to Haiku for a title; unredacted
  request bodies are kept at `~/.local/state/tower-claude-code-harness/api-bodies/`.
- Spec fit (not required): `turn.started.thinking` is a boolean; thinking
  progress without text has no carrier; a thinking block can't say what kind
  of text it holds; system-role messages, side requests (the title) and
  account rate-limit events have no place.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md), The
required settings (thinking).
