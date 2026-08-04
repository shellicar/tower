# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- Open towerd's database in WAL mode.
- Ignore a displaced agent's release of a claim it no longer holds.
- Order attachments in the connect snapshot oldest first.
### Added

- towerd names its own build on startup: version, the commit it was built from (suffixed -dirty when any file it was compiled from was uncommitted, staged or untracked), and the build time.
