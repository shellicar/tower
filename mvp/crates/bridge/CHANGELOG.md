# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- A world can be asked to serve a conversation over NATS: bridge answers agent.v1.{world}.requests.service, spawning, adopting, or taking over per the conversation's own attachment record, and rejects every other request leaf honestly.
- Six GitHub pull request tools open, edit, comment on, review and queue auto-merge for a pull request, each with a fixed set of flags: creating always opens a draft, reviewing has no option that approves, and auto-merge can only be queued or cleared, never performed.
- A credential is configured by name with the `credentials` control line and bound to a tool group with the `tools` line; `settings` reports what each group resolves to, and both report a warnings array. The secret itself is read from the macOS Keychain at the moment a child process is spawned and is never held.

### Changed

- Configuring a credential for a provider removes that provider's ambient environment from every Exec child, replacing it with whatever the exec group carries. For GitHub that covers GH_TOKEN, GITHUB_TOKEN and SSH_AUTH_SOCK.
- The Skill tool is now offered whether or not a skills directory is set, so the tool array no longer changes when one arrives. Invoking it with no catalogue returns an error saying so.

### Fixed

- AppendFile flushes its write before returning, so a reader that opens the file immediately after the append sees the appended content instead of an empty file.
