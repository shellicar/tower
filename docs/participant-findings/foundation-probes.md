# Foundation probes: giving Claude Code the required values

**Question.** How to give Claude Code the required values (model, effort,
permission mode, thinking, max tokens) so that its own settings still win
over them; which environment variables outrank settings; whether effort `max`
can be carried.

**Method.** A probe script (deleted afterwards), then a 13-case live matrix
through the real control lines and launcher under `just broker-run`, reading
the raw request body of each main-loop request (`scripts/live-check.ts` with
`OTEL_LOG_RAW_API_BODIES`). Some points were read from the binary by the
reviewer.

**Versions.** Agent SDK 0.3.283, Claude Code 2.1.283.

**Runs.** 17 exploratory probes, 13 matrix cases (L01 to L13), 4 strip runs.
Only the matrix is repeatable (`scripts/live-check.ts`).

**Found.**
- A permission mode in settings alone is never applied; it has to go as a
  launch option too.
- A model in settings alone is applied (the `--model` flag beats it).
- `ANTHROPIC_MODEL` outranks the settings' model, and
  `CLAUDE_CODE_EFFORT_LEVEL` outranks settings' effort. After stripping them,
  the declared values were sent, and `claudeSettings.env.ANTHROPIC_MODEL`
  still won. Claude Code picks its model from: an explicit value, then
  `ANTHROPIC_MODEL`, then the settings' model (read from the binary).
- `--effort` beats `modelSettings`. The settings schema drops
  `effortLevel: max`, per model too.
- The display flag is needed, or the request asks for a display with no
  summary.
- The mode flag beats `disableAutoMode`.
- Matrix: a model override works; Haiku got budget thinking (Claude Code
  substituting per model); plan mode applies; `effortLevel` and per-model
  effort win; `alwaysThinkingEnabled: true` means thinking on, even over a
  declared `disabled`; `env.CLAUDE_CODE_MAX_OUTPUT_TOKENS` wins; `max` beats
  the override.
- Not verified: whether effort set only in settings is applied.
- The first live check showed the process's own process group and session,
  `setpriv` handing over, and the private HOME empty after the runs.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md): the three
cases, the strip, the open items on the mode and `max`.
