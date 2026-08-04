# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The rail can be filtered to only conversations a live agent is serving, or only unread ones, saved per tab.
- A conversation's panel shows the directory its agent is working in.
- A conversation's id can be searched for in the rail and copied from its panel.

### Fixed

- An agent whose claim omits its world reads as alive on the rail.
- The app logs its own build to the browser console on load: version, the commit it was built from (suffixed -dirty when the tree it compiled had uncommitted or untracked changes), and the build time, so a stale cached bundle is visible.
- The app logs its own build to the browser console on load: version, the commit it was built from (suffixed -dirty when any file it was compiled from was uncommitted, staged or untracked), and the build time, so a stale cached bundle is visible.
