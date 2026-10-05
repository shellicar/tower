# Proof 10: working directories and permissions

**Question.** How `removeDirectories` works; how permissions differ inside
and outside the working directory across modes; whether auto mode works
through the SDK. Nothing adds or removes access as such: the permission
system behaves differently inside and outside the working directory.

**Method.** 11 Claude Code documentation pages read raw, plus runs.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 40 (37 Haiku 4.5, 3 Sonnet 4.6). Branch
`proof-10-directories-permissions` (38f54f0 to 6565ddc).

**Found.**
- `removeDirectories` exists only in `sdk.d.ts`, removes by path whatever the
  destination, and fires no hook.
- Inside the working directory, reads run without asking in every mode.
  Outside it: default, plan and acceptEdits ask; dontAsk refuses;
  bypassPermissions and auto run. `blockReadsOutsideWorkingDirectories` is a
  hard boundary even under bypass.
- `auto` is accepted by the typed `permissionMode`, at start and live
  (`setPermissionMode('auto')`).
- An added directory doesn't survive a resume.
- `--add-dir` brings skills, commands, subagents, some plugin settings and
  CLAUDE.md (with an env var); directories added through settings give file
  access only.
- `applyFlagSettings({permissions})` replaces the whole permissions object on
  each live call.

**Resume comparison.** Not a request comparison; it found that added
directories don't persist across a resume.

**Used by.** [running.md](../participant/running.md) (additional
directories), [configuration.md](../participant/configuration.md)
(permission mode).
