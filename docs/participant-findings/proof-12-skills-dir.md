# Proof 12: skills from a dynamic directory

**Question.** How skills can load from directories declared in config,
without a plugin prefix.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (10 of 14 runs logged
it).

**Runs.** 9 live scenarios, 14 run dirs, on Haiku 4.5. Branch
`proof-12-skills-dir` (7b74853 to e94bfd3); README section "Findings, each
with its run".

**Found.**
- Under `settingSources: []` only plugin routes load skills. `Options.plugins`
  names are always `<plugin>:<skill>`, picked up only through
  `reloadSkills()`, with the path fixed at start. A settings-declared
  directory marketplace works, prefixed.
- `additionalDirectories`, `projectConfigRoot` and `register_repo_root` don't
  load skills; `Options.skills` only filters.
- A plugin root can also carry hooks, agents, commands and `.mcp.json`.

**Resume comparison.** Not about resume.

**Used by.** [skills.md](../participant/skills.md).
