# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- The lookout watches the workers on a handler's reporting line and delivers one batched digest when a worker changes state: it finished a turn and is worth reading, it announced a tool that has been outstanding longer than a tool can run, it has a query open and has gone quiet with no tool to account for it, or it is idle waiting on someone. Each reading names the query it is about, so a handler can tell one stop from the next and a handler that has been reset can tell an old one from a new one. It watches the reporting-lines bucket, so a worker commissioned after it started is picked up and a worker whose line is removed is let go. A worker waiting on a tool it announced is left alone until that wait passes the longest a tool can run. It ticks on a clock, so a worker that stopped without publishing anything is still classified. A digest names workers, states, queries and silences; nothing a worker said travels with it, and it draws no conclusion the events do not carry.
