# How Claude Code finds its login on macOS

**Question.** How Claude Code finds the login on macOS, and whether the
participant can detect when the Keychain is in use; plus a one-command test
for a Mac.

**Method.** Code reading of the darwin-arm64 build of Claude Code 2.1.282
(downloaded from npm, sha512 checked), and a test script
`proofs/macos-keychain.mts`, first run later on Stephen's Mac.

**Versions.** Claude Code 2.1.282 (the code read; the design record names it
as the darwin-arm64 binary of Agent SDK 0.3.282). The Mac run's versions are
not recorded.

**Runs.** No runs on Linux. The Mac run's results are recorded only here and
in the old design record, not on the branch. Branch `research-macos-keychain`
(86b1dc5, 5575fb8), pushed as `origin/feature/research/macos-keychain`.

**Found (code reading).**
- Keychain first, with a file fallback.
- The Keychain service name is hashed from `CLAUDE_SECURESTORAGE_CONFIG_DIR`
  or `CLAUDE_CONFIG_DIR`, so a dedicated directory names its own entry.
- No combination shares both the entry and the refresh lock with another
  Claude Code.
- Hazard 1: an absolute path on a Mac using the file fallback means a refresh
  writes a hashed Keychain copy, then deletes `~/.claude/.credentials.json`.
- Hazard 2: a store resume with `CLAUDE_CONFIG_DIR` unset writes the access
  token into `claude-resume-*`.

**Found (the Mac run).**
- Under a private `HOME`, `/usr/bin/security` finds no keychain at all.
- With an absolute `CLAUDE_SECURESTORAGE_CONFIG_DIR` (cases C and F), Claude
  Code logged in through the `.credentials.json` fallback in that directory,
  not the Keychain.
- With `security` run under the real `HOME` (case G), it logged in through the
  Keychain entry.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md): the
`security` shim and `PARTICIPANT_LOGIN_DIR`.
