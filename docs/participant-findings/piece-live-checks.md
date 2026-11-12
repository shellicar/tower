# Live checks of the built pieces

Each built piece was checked against the test broker before merging. The
Claude Code and Agent SDK versions weren't recorded for these.

- **Bus** (`scripts/bus-check.ts`, world `bus-check`): `ready`, `pulse`,
  `attached`; a say accepted; a second say `stale`; cancel, then
  `already_complete`; shutdown order `unavailable`, `detached`, `offline`;
  exit 0. Found: the NATS client gave up after about 10 reconnects and the
  process exited 1 with no events (since fixed: it reconnects without limit);
  `ready` isn't republished on reconnect; no displacement watch; a
  self-started turn isn't tracked as a running query; wall-clock `ts`
  against a monotonic timer.
- **Publisher** (`scripts/publisher-check.ts`, 2 runs, world
  `publisher-check`, bucket `durable`): turn and query ids right; the object
  stored before the message and read back with the same bytes; the tip after a
  cancel excludes the marker. Found: tool results and attachments arrive
  mid-stream; a slash-command say is published as a prompt; an SDK error at
  shutdown (`ede_diagnostic`) wasn't reproduced.
- **Driving kit** (world `kit-test`, run by hand because `just broker-run`
  was refused in the isolated worktree), model `claude-sonnet-5-5`: every
  control line accepted; service and say accepted; Ctrl-C exit 0. Found:
  `ready` was published before configuration (since fixed);
  `claude-sonnet-5-5` was an unrecognised model on SDK 0.3.283 (fixed by
  moving to 0.3.285); `describeError` printed the NATS error twice; every say
  after the first needs the tip, which the kit doesn't print.
- **Cancel** (world `cancel-check`): a cancel left the background subagent
  running; SIGINT ended with exit 0.
- **Reply author** (`publisher-check.ts`, then `scripts/author-check.ts`):
  replies carry `agent`, tool results none; background-task notices carry
  `orchestrator`. Across Stephen's transcripts: 149 task-finished notices and
  13 synthetic entries.
- **Ready after config** (through the broker-run recipe): `ready` 6 to 7 ms
  after the last control line. Found: a bare `cd` inside
  `broker-run '<cmd>'` sends the recipe's teardown to the wrong directory, so
  multi-step runs go in a script.

**Resume comparison.** None of these is about resume.
