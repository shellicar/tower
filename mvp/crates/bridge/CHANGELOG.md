# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- A world can be asked to serve a conversation over NATS: bridge answers agent.v1.{world}.requests.service, spawning, adopting, or taking over per the conversation's own attachment record, and rejects every other request leaf honestly.

### Fixed

- AppendFile flushes its write before returning, so a reader that opens the file immediately after the append sees the appended content instead of an empty file.
- The commit in bridge's build stamp can now be trusted: the hash carries a -dirty suffix unless a git status over bridge and the crates it compiles reported no modified, staged or untracked files, so a binary built from an edited tree no longer names a commit it does not contain.
