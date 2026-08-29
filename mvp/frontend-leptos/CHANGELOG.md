# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The rail can be filtered to only conversations a live agent is serving, or only unread ones, saved per tab.
- A conversation's panel shows the directory the agent serving it is working in, and follows that agent when it changes directory. A second agent taking the conversation over, or an old one releasing the claim it no longer holds, leaves the directory reading correctly rather than blank.

### Fixed

- A conversation whose agent claimed it without naming its world now shows that agent as alive on the rail, instead of showing nothing attached or going stranded a minute later while the agent is plainly still working.
