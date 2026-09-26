# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The rail can be filtered to only conversations a live agent is serving, or only unread ones, saved per tab.
- A conversation's panel shows the directory its agent is working in.
- Allow filtering for conversations missing a tag.
- A conversation's id can be searched for in the rail and copied from its panel.

### Fixed

- An agent whose claim omits its world reads as alive on the rail.
- Stop tags randomly changing order in the filter.
- Allow clearing a filter that no conversations match.
