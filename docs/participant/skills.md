# Skills (MVP)

This file covers what is decided for skills, where they stand, and what is
known about how Claude Code loads them. The no-ambient-config principle is
in [configuration.md](configuration.md).

## Decided

- **Skills are required for the MVP, from at least one skills directory.**
- **Skills directories are declared in config,** and skills keep their plain
  names, with no plugin prefix.
- **Skills are managed per process, not per conversation.** Two participants
  with different skill configuration don't contest. What matters is
  isolation, and the available skills changing when the config changes; the
  exact config shape doesn't. Nothing is forced that Claude Code doesn't
  support.
- **Skills are not ambient** (see [configuration.md](configuration.md)).

Skills are not ambient because ambient skills would leave sessions impossible
to control or compare.

## Where it stands

Not built. The participant runs Claude Code with `settingSources: []`, which
loads no skills.

Undecided: the route. The one proven so far: Claude Code's `user` setting
source over the agent's config dir, with the spawn hook linking each
declared skill folder into whichever config dir each Claude Code gets,
skipping folders that carry `.claude-plugin`, and a private HOME keeping the
housekeeping that opening `user` turns on out of the real home. Opening the
`user` source also opens CLAUDE.md, hooks, permissions, agents, commands and
MCP from that dir. The question is how to declare a skills directory without
opening Claude Code's whole `user` source.

Undecided: how skills are configured. Bridge takes its skills directory on a
stdio control line, and the no-ambient-config principle points the same way.

## What is known

From proofs [12](../participant-findings/proof-12-skills-dir.md),
[19](../participant-findings/proof-19-skills-plain.md) and
[22](../participant-findings/proof-22-skills-user-level.md), and the
[reloadSkills code read](../participant-findings/reload-skills.md):

- Under `settingSources: []` only plugin routes load skills, and plugin skills
  are always prefixed. The managed directory loads plain names under `[]` but
  is machine-wide and root-owned.
- The `user` directory (`<CLAUDE_CONFIG_DIR>/skills`) gives plain names,
  watched live, but needs `userSettings` open.
- A skills directory must exist before Claude Code starts; a new directory
  isn't watched.
- A resume through the session store (a temporary config dir) sees no skills
  unless they are linked there.
- `reloadSkills()` rescans and re-sends the whole list; removals are never
  announced to the model. It blocks Claude Code's input while it runs, up to
  30 s while claude.ai skill sync is on.
- A skill folder with `.claude-plugin/plugin.json` is adopted as a plugin,
  hooks and MCP included.

## Open

- The route, and how a skills directory is declared.
- Whether the participant needs to call `reloadSkills()` at all (Claude Code
  watches the directory itself).
- `syncClaudeAiSkills` is left at Claude Code's default (see
  [configuration.md](configuration.md), Open).
