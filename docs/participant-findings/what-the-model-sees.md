# What the model sees, entry by entry

**Question.** What is in Claude Code's transcripts and requests, how entries
reach the participant, which ones the model sees, how the request is built,
and how that compares with what the participant publishes.

**Method.** Statistics over 12 of Stephen's transcripts (35,148 lines,
534 MB); reading the SDK (`sdk.mjs`) and the 2.1.285 binary; observations in
the main session's own context after Stephen ran `! echo hello`,
`! ls /nonexistent` and `/config`; one captured request, which Stephen made
with Claude Code 2.1.287 (`claude --continue` in the main tower session with
`OTEL_LOG_RAW_API_BODIES=file:<dir>`). No section rests on Stephen's screen
(for that, see [Claude Code's rendering](claude-code-rendering.md)). The
scripts were in a session scratchpad under `/tmp`.

**Versions.** Claude Code 2.1.285 (binary read) and 2.1.287 (the capture).
Agent SDK not recorded.

**Found.**
- **How entries reach the participant:** in transcript order (52 of 52),
  0.3 to 2.3 ms after the disk write; `doFlush` can batch; `result` comes
  after that turn's appends. Exceptions: writes after the SDK's SIGTERM on
  abort; a host exiting within milliseconds loses 4 to 5 entries; a rejected
  `append()` is retried 3 times (a 60 s timeout is not), then the batch is
  dropped with `mirror_error`. Subagent records come with `key.subpath`, and
  the participant drops them. That `append()` entries equal transcript lines
  is argued from code and proof 3, not captured live.
- **An API message is split across entries** sharing `message.id`, one per
  content block (up to 11); a tool-result entry can sit between the pieces;
  each tool-result entry holds exactly one result.
- **Flags that mark machine-made entries:** `origin` (human,
  task-notification, peer, auto-continuation; `producer`), `promptSource`,
  `turnOrigin`, `isMeta`, `isCompactSummary`, `queueTranscriptOnly`,
  `sourceToolUseID`, `turnCompanion`, `interruptedMessageId`; on assistant
  entries `<synthetic>`, `isApiErrorMessage`, `error`, `apiErrorStatus`,
  `quotaLimits`, `isAbortedMidStream`. No stored entry holds reminder text:
  reminders are `attachment` entries whose `rendered` is the list of blocks
  the model gets.
- **Links:** a mid-turn typed message is a `queued_command` attachment, not a
  user entry; a task notice's `<task-id>` equals the Agent tool result's
  `agentId`; a compaction's `compact_boundary` is a chain root with
  `logicalParentUuid` and `compactMetadata`.
- **The model sees:** assistant pieces (except thinking-only and API-error
  pieces), tool results, prompts, task notices (wrapped at send time with a
  "[SYSTEM NOTIFICATION - NOT USER INPUT]" frame), hand-backs, `isMeta` text
  (`isMeta` marks origin, not "not sent"), the compaction summary, interrupt
  markers, slash-command records, `system/local_command`, attachments with
  `rendered`, `!` bash entries (as `<bash-input>`, `<bash-stdout>`,
  `<bash-stderr>`), and "No response requested." as its own earlier turn.
- **The model doesn't see:** API-error synthetic text, every `system` subtype
  except `local_command`, attachments without `rendered`
  (`deferred_tools_record`, `prompt_snapshot`, `credential_org`,
  `command_permissions`, `thinking_drop`, `compact_file_reference`).
- **Against what the participant published at the time (2 to 3 Oct):** seen
  but not published: hand-backs (published since), caveat and image notes,
  skill text, the compaction summary, interrupt markers, attachments with
  text, the usage-limit "continue" nudge. Published but not seen: Claude
  Code's API-error text, and `system` entries (published with empty content).
  Unknown: transcript-only task notices.
- **How the request is built (2.1.285):** user entries merge into the previous
  API user message; tool results go first; assistant entries sharing
  `message.id` merge; an attachment's role comes from its rendering, and
  system turns are model-dependent; a mid-turn message's place is decided by
  the attachment's own fields; send-time additions (the notice wrapper, "Tool
  loaded.", tool-addition blocks, `cache_control` with a 1 h TTL).
- **The captured request:** 246 messages (86 user, 75 system, 85 assistant)
  from 537 entries. All 75 system messages come from attachments. 73 stored
  entries are absent from it: 62 `turn_duration`, 5 `deferred_tools_record`,
  3 `command_permissions`, 2 `prompt_snapshot`, 1 `credential_org`. Thinking
  text is logged as redacted.
- **Time:** the participant stamps `ts` at publish. An entry's `timestamp` is
  set at creation; pieces of one API message spread a median 2.2 s (max
  234 s) and can be out of file order. `turn_duration.timestamp` is the turn's
  end and `durationMs` its wall-clock length (the displayed verb is hashed
  from the uuid). An away summary's time is when it was generated.
- **Capturing a request:** `OTEL_LOG_RAW_API_BODIES=file:<dir>` writes whole
  requests and responses with only thinking redacted. A base-URL proxy
  changes Claude Code's behaviour. `CLAUDE_CODE_ELEGANT_MEADOW=1` is an
  undocumented recorder.
- **No test pins publishing for resume** (see
  [resume.md](../participant/resume.md)).

**Resume comparison.** Neither: transcript entries against a captured
request, not two resumes.

**Used by.** [purpose.md](../participant/purpose.md) (the publish rule),
[publishing.md](../participant/publishing.md).
