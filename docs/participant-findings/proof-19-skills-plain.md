# Proof 19: skills from config-declared directories, without a prefix

**Question.** The goal: skills dynamic like bridge's, from directories
declared in config, with plain names. Find every route, not only the plugin
one.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 14 scenarios, 25 run dirs, on Sonnet 5, per-run config dirs.
Branch `proof-19-skills-plain` (a20ff48 to ba6240b).

**Found.**
- **The user dir** (`<CLAUDE_CONFIG_DIR>/skills`): needs `userSettings` open;
  plain names, watched live; also loads that dir's CLAUDE.md, rules, agents,
  commands and settings.json; adopts a plugin-shaped entry.
- **The managed dir** (`/etc/claude-code/.claude/skills`): loads under `[]`
  with plain names, but machine-wide, root-owned and unwatched.
- **`--add-dir`, `projectConfigRoot`, `register_repo_root`:** need
  `projectSettings` open; plain, watched; start the CLAUDE.md ancestor walk.
- `canUseTool` adding directories: nothing. `--bare`: skips discovery. An
  undocumented MCP `skills/list` route is gated by `tengu_mcp_skills`.
- A removal is never announced except through `reloadSkills()`. The watcher
  polls every 2 s, then every 30 s when idle.
- Risk: `extraArgs: {'setting-sources'}` bypasses `settingSources: []`.

**Resume comparison.** Not about resume.

**Used by.** [skills.md](../participant/skills.md).
