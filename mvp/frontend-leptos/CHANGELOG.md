# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The app logs its own build to the browser console on load: version, the commit it was built from (suffixed -dirty when the tree it compiled had uncommitted or untracked changes), and the build time, so a stale cached bundle is visible.
