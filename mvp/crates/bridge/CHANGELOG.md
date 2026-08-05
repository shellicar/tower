# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- A world can be asked to serve a conversation over NATS: bridge answers agent.v1.{world}.requests.service, spawning, adopting, or taking over per the conversation's own attachment record, and rejects every other request leaf honestly.

### Fixed

- AppendFile flushes its write before returning, so a reader that opens the file immediately after the append sees the appended content instead of an empty file.
- A turn whose stream ends before the service reports why now publishes turn_ended with no stopReason, instead of a fabricated end_turn. A truncated answer no longer looks identical to a finished one.
