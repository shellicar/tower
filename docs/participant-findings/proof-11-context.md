# Proof 11: CLAUDE.md and context

**Question.** How CLAUDE.md reaches the model in current Claude Code, and the
participant's own options for adding context.

**Method.** Raw request bodies per route.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 3, on Haiku 4.5. Branch `proof-11-context` (723bcf5, 8be2ccc).

**Found.**
- Text in the first user message arrives verbatim.
- `UserPromptSubmit` additionalContext is wrapped as a reminder every turn.
- The SDK's in-process `SessionStart` callback never fired in streaming-input
  mode (a settings.json command hook did).
- The preset's `append` goes into the system block on every request.
- CLAUDE.md through `settingSources` arrives as one bundled reminder,
  identical to the interactive format, read once per session: an edit
  mid-conversation doesn't reach the model.
- `settings.claudeMd` never reaches the model.
- `settingSources: []` blocks CLAUDE.md on every route; `['project','user']`
  walked up to `~/.claude/CLAUDE.md`.
- An escape hatch for loading CLAUDE.md anyway wasn't kept: the harness is
  the harness, and anyone who needs that can do it themselves.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md) (no ambient
configuration; the `context` line).
