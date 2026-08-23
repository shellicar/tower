# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- A world can be asked to serve a conversation over NATS: bridge answers agent.v1.{world}.requests.service, spawning, adopting, or taking over per the conversation's own attachment record, and rejects every other request leaf honestly.
- Six GitHub pull request tools, each limited to a fixed set of gh flags: creating always drafts, reviewing cannot approve, and auto-merge is only queued or cleared.
- `credentials` and `tools` control lines name credentials and bind them to tool groups.

### Changed

- The Skill tool is offered whether or not a skills directory is set.

### Fixed

- AppendFile flushes its write before returning, so a reader that opens the file immediately after the append sees the appended content instead of an empty file.

### Security

- Configuring a GitHub credential stops Exec children authenticating with the host's own gh login. A host that configures none is unaffected.
