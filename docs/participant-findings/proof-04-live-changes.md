# Proof 4: what can change on a running Claude Code

**Question.** What can be configured while Claude Code runs, and what only
at start?

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 30 (29 Sonnet 5, 1 Opus 5.5), a `summary.txt` per run. Branch
`proof-4-live-changes` (01349e9).

**Found.**
- **Live:** the model (`setModel`, which starts a new server-side thread and
  re-derives thinking, max tokens and effort per model); thinking, effort,
  fast mode; env for tools, and partly for Claude Code itself, through
  `applyFlagSettings({env})` (undocumented); sandbox on (undocumented; off
  untested); allow rules; acceptEdits and plan modes; hooks; `reloadSkills`
  for new plugin skills; `setMcpServers`; output style; file rewinds through
  env; `set_cwd` (an undocumented control request, idle only, with a
  `needs_trust` handshake). `applyFlagSettings` takes arbitrary keys,
  validated only for nesting depth.
- **Partly:** a deny rule refuses the call but doesn't hide the tool (at start
  it hides it); an agent switch replaces the system prompt only with
  `{preset: 'claude_code', snapshot: false}`.
- **Start only:** `tools`, `canUseTool`, `allowDangerouslySkipPermissions`,
  agent definitions, the system prompt text, plugin dirs,
  `includePartialMessages`, `forwardSubagentText`, the session id.
  `skillOverrides` doesn't reach the model.
- Claude Code usually continues a server-side thread; a model switch, plan
  mode, `set_cwd` and a `snapshot: false` agent switch start a new one.
  Changes reach the model as system messages or reminders, never through the
  SDK stream.
- Risks: undocumented calls; the proof accepted a directory-trust prompt
  itself; a session started with `allowDangerouslySkipPermissions` was
  switched to bypass mode and auto mode didn't block it.
- Spec fit (not required): reminders have no role; `/model` output has no
  honest `from`; `turn.started` lacks fast mode; `chdir` fits `set_cwd`
  except for trust.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md) (pinned per
conversation), [presence.md](../participant/presence.md) (`chdir`).
