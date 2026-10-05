# Proof 22: plain-named skills through the user level

**Question.** Do plain-named skills work through Claude Code's user level,
for a fresh Claude Code and a store-resumed one?

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (README: "What the runs
showed (Claude Code 2.1.282, SDK 0.3.282, claude-sonnet-5)").

**Runs.** 21, on Sonnet 5. Branch `proof-22-skills-user-level` (b98f37d to
7006754).

**Found.**
- A store-resumed Claude Code sees 0 skills (it runs in a temp config dir).
- A `spawnClaudeCodeProcess` hook linking the skills into each config dir
  works fresh and resumed.
- Live changes arrive as deltas, but a removal needs `reloadSkills()`.
- A skill folder with `.claude-plugin/plugin.json` is still adopted as a
  plugin (its hooks ran).
- Opening `user` also loads CLAUDE.md, rules and more from that dir.
- Risk: a retention clean-up in Claude Code is hard-coded to real-home paths
  (`~/.claude/bridge-spawn`, `state/served-calls`, `settings-review.json`).
  Nothing was changed in the runs. This is one reason for the private HOME.
- The SDK would copy `.credentials.json` without the refresh token.

**Resume comparison.** Neither: skills visible in a resumed Claude Code.

**Used by.** [skills.md](../participant/skills.md),
[configuration.md](../participant/configuration.md) (private HOME).
