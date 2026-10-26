# Proof 26: keeping Claude Code out of the user's home

**Question.** Prevent Claude Code's unwanted `$HOME` machinery, or override
`$HOME` and fix what should still be inherited? This is not about stopping
the model reading the home, but about what the SDK and Claude Code do there.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (README: "What the runs
showed (Claude Code 2.1.282, SDK 0.3.282, claude-sonnet-5, 27 Sep)").

**Runs.** 32, on Sonnet 5. Branch `proof-26-home` (ending 7832ea8), pushed as
`origin/feature/research/proof-26-home`.

**Found.**
- The baseline already writes MCP logs to the real `~/.cache` and reads
  updater dirs.
- Option 1 (prevent) needs env switches plus `cleanupPeriodDays: 0`, which
  works only through a validation error, and the switches leak into
  commands.
- Option 2 (a private HOME, the login through an absolute
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointing at the real `~/.claude`, and
  `CLAUDE_CODE_SHELL_PREFIX` running `HOME=<real> bash -c "$1"`) keeps the
  housekeeping private.
- Option 2's gaps: Read and Write resolve `~` to the private home; no rc
  files; ssh uses the real home (through the shell prefix).
- macOS Keychain naming, read from code.

**Resume comparison.** Neither.

**Used by.** [configuration.md](../participant/configuration.md): option 2
was chosen, one private home per participant process (the reading of "one
per process" Stephen didn't contradict), in the temp dir so no clean-up is
needed.
