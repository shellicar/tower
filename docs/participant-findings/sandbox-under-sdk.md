# Claude Code's sandbox under the SDK

**Question.** What happens when Claude Code's sandbox can't run under the
participant, and can the SDK tell whether it is active?

**Method.** Documentation and SDK and CLI code. The live runs were refused by
the auto-mode classifier, so nothing was observed. A probe was written
(`probe.mjs`, in a session scratchpad under `/tmp`, probably gone).

**Versions.** Claude Code 2.1.283, Agent SDK 0.3.283.

**Found.** (Docs and code, not proven live.)
- When the sandbox can't start, Claude Code warns on stderr and runs Bash
  unsandboxed. On the participant's route (the sandbox inside settings) there
  is no `failIfUnavailable` default. The SDK's `sandbox` launch option
  defaults `failIfUnavailable: true` but replaces any `settings.sandbox`
  whole. `failIfUnavailable` covers only a missing `bwrap` or `socat`, or an
  unsupported platform, at startup.
- Today the warning is only a log line, because Claude Code's stderr passes
  straight through.
- `getSandboxDialog().enabled` is the only running-state signal. It exists on
  `Query` at runtime but is undeclared in `sdk.d.ts` and marked internal. The
  init message and `getSettings()` don't say whether the sandbox started.
- Flag settings apply even with `settingSources: []` (inferred). With
  `allowUnsandboxedCommands` at its default (true), a blocked command can be
  retried unsandboxed; `false` closes that.
- Options for checking before serving: `failIfUnavailable` in
  `claudeSettings`; the `sandbox` launch option; gating on
  `getSandboxDialog().enabled`; matching "Sandbox disabled" on stderr; a
  canary write; `managedSettings`.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md), Other
settings.
