# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The lookout watches the workers on a handler's reporting line and delivers one batched digest when they change state: a turn finished and is worth reading, a worker died mid-turn holding unpushed work, or a worker has gone idle waiting on someone. It reads the reporting-lines bucket and each worker's own change subtree, ticks on a clock so a worker that crashed and published nothing is still found, and says into the handler only after re-reading its tip. A digest names workers and states; nothing a worker said travels with it.
