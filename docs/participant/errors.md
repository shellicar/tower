# Errors and logging

## Errors in tower

- **Any error should be shown to the user,** for example an API request that
  failed after its retries. Tower has no concept of an error yet; it is a
  missing feature.
- **Tower is meant to be harness- and agent-agnostic,** so it needs a message
  of some kind that indicates errors.
- **Claude Code's error text is published,** even though the model never sees
  it: it is for the user of tower. It is published today as a plain
  `<synthetic>` assistant message with no `from`, its error marker dropped.
- There are two sides: the feature in tower's UI, and the channel that gets
  the error there. Neither is designed.
- Errors come from two sources: Claude Code's own error entries, and failures
  only the participant sees (the broker going away, Claude Code exiting, the
  SDK's mirror error, a sandbox that failed to start).

This replaces the older line that transient errors are telemetry, not
intrinsic to the conversation. `turn_aborted` says an attempt failed, not
what failed.

For reference, Stephen's claude-cli shows errors as plain `[error: ...]`
lines in the transcript, with a notice line per round for account-limit and
stream-drop retries, and no popup
([claude-cli errors](../participant-findings/claude-cli-errors.md)).

## Logging

- Claude Code's stderr goes to the participant's stderr. Logging isn't
  designed.
- **API response logging** is wanted as a switch, for when it is needed; not
  through a proxy, because Claude Code knows when a proxy is there and can
  change its behaviour. Whether full responses or not is open. Two routes are
  known: `ANTHROPIC_LOG=debug` with `--debug-to-stderr` logs each response's
  status and headers (credentials masked); `OTEL_LOG_RAW_API_BODIES=file:<dir>`
  writes whole requests and responses, with only thinking redacted. Not
  built. Open: whether the switch defaults on or off.
- When Claude Code's sandbox can't start it only warns on stderr, so today the
  warning is a log line and nothing more.

## Open

- The error message's shape on the wire (a spec design), and tower's display.
- Where errors sit in the order of work.
- Logging as a whole.
