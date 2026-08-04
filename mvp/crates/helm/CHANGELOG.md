# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- The `m` command changes the model name only.
- A `cwd` line in a `-c` configuration batch now sets the directory the conversation runs in.

### Fixed

- A `-c` configuration batch is applied before the conversation is created.
### Added

- helm names its own build before it takes the screen: version, the commit it was built from (suffixed -dirty when any file it was compiled from was uncommitted, staged or untracked), and the build time.
