# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- A world can be asked to serve a conversation over NATS: bridge answers agent.v1.{world}.requests.service, spawning, adopting, or taking over per the conversation's own attachment record, and rejects every other request leaf honestly.
- The broker seam now covers a client's needs as well as a servicer's: reading and watching a key-value bucket, reading the newest message on one subject, consuming a stream through a named durable consumer that acks cumulatively and can be removed, and sending a request that expects a reply. A durable consumer's ack is confirmed by the server rather than fired and forgotten, so an ack is not lost when the reader exits or reopens immediately after.

### Fixed

- AppendFile flushes its write before returning, so a reader that opens the file immediately after the append sees the appended content instead of an empty file.
