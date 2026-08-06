# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The lookout watches the workers on a handler's reporting line and delivers one batched digest when they change state: a turn finished and is worth reading, a worker has a query open and has gone quiet with nothing to account for it, or a worker is idle waiting on someone. It watches the reporting-lines bucket, so a worker commissioned after it started is picked up and a worker whose line is removed is let go. A worker waiting on a tool it announced is left alone however long that takes, because the agent host publishes nothing between a tool call and its result, and silence there has a cause rather than a guess. It ticks on a clock so a worker that crashed and published nothing is still found, and says into the handler only after re-reading its tip. A digest names workers, states and silences; nothing a worker said travels with it, and it draws no conclusion the events do not carry.
