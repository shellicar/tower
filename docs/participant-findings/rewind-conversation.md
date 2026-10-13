# Rewinding Claude Code in-process: `rewind_conversation`

**Question.** Is there an in-process way, over the SDK, to make the next
prompt attach somewhere other than the end of Claude Code's chain (after a
cancel, or further back), without restarting Claude Code as the
[restart route](cancel-before-reply.md) does? A follow-up asked five things
about it: why a resume landed on the rewound point, what the terminal's
rewind writes, what happens to background shells, when the rewind reaches
`append()`, and when the refusals `prompt_pending` and `commands_queued` can
happen.

**Method.**
- A probe called the SDK directly, not through the participant's launcher.
  It sent an undeclared control request, `rewind_conversation`, as
  `(q as any).request({...})`, and logged every `append()` entry, the request
  bodies (`OTEL_LOG_RAW_API_BODIES`) and the transcript.
- It used the participant's environment shape: private `HOME` and
  `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR=~/.claude`,
  `settingSources: []` and an eager store. It differed from the participant
  in using `bypassPermissions` and not stripping claude.ai connectors.
- The handler and the terminal's rewind were read in the `strings` dump of
  the bundled binary.
- The follow-up ran nothing new: it used the same runs and more reading of
  the binary.

**Versions.** Agent SDK 0.3.285 and its bundled Claude Code 2.1.285, the
versions the participant pins in `pnpm-lock.yaml`; confirmed from the
binary's `manifest.json` and from `claude_code_version` in `system/init`.
Model: Haiku (`claude-haiku-4-5-20251001` in every request body on disk).

**Runs.** One run per case. The run data, the probe (`probe.mts`) and a body
reader (`bodies.mjs`) are kept locally in the main checkout at
`.claude/docs/cancel-rewind-reports/rewind-runs/`, not in git. Each run
directory holds `log.jsonl`, `bodies/` and the transcript under `config/`.
There are 9 run directories:
- `run-completed`, `run-cancel`, `run-oneshot`, `run-multiback`,
  `run-reach` (two cases) and `run-resume`: the 7 cases in the table below;
- `run-background` and `run-background2`: the background shell cases;
- `run-fork`: the `fork_conversation` check.

**Found.** Each point is marked read, observed or inferred.

### `rewind_conversation` works (observed)

In the 6 cases that targeted the current branch, the rewind succeeded (in
multiback after a first `stale_target`), the next prompt attached where it
should without restarting Claude Code, and none of the cut content reached
the model. The 7th, aimed at a cut branch, was refused.

| Case | Rewind result | Next prompt's body |
|---|---|---|
| completed: P1, P2, rewind to P2, P3 | `rewound:true`, 1 ms | alpha turn, then charlie. No "bravo" (0 grep hits). The model listed "alpha, charlie". |
| cancel: P1, P2 running, `interrupt()`, rewind to P2, P3 | `rewound:true`, 2 ms | alpha turn, then charlie. No cancelled prompt and no `[Request interrupted by user]` marker (0 hits). |
| oneshot: rewind to P2 with `interrupt_if_running:true` while P2 was streaming | `rewound:true`, 22 ms; the turn ended `error_during_execution` | Same as the cancel case. A single request both cancels and rewinds. |
| multiback: P1, P2, P3, rewind to P2 | Without `last_seen_user_message_uuid`: `stale_target`. With it set to P3: `rewound:true` | alpha turn, then charlie (two turns dropped). |
| reach: after a rewind and a new P3, target the old P2 | `target_not_found` | Not applicable. Only the in-memory current branch is reachable. |
| reach: target P1 (the root) | `rewound:true`, `precedingAssistantUuid:null` | The next prompt was written with `parentUuid:null` (a new root). The model saw only "echo". |
| resume: rewind, send nothing, close, relaunch with `resume` only | `rewound:true` | The next prompt attached at the rewound anchor, not the old end. The model listed "alpha, charlie". |

### What the request is (read)

- The handler is in the binary's headless stdio loop (offset about 38.79M in
  `strings` of `.../claude-agent-sdk-linux-x64/claude`). The cut is computed
  by `JS()`, target matching by `Cje()` (it matches the first 24 characters
  of `uuid` or the client id), and persistence by `ek()` then
  `rst()`/`uEr()`.
- Request: `{subtype:'rewind_conversation', target_message_uuid,
  last_seen_user_message_uuid?, interrupt_if_running?}`.
- Success: `{rewound:true, targetMessageUuid, prefillText,
  precedingAssistantUuid}`.
- Refusal: `{rewound:false, reason, error}`, the reasons being
  `commands_queued`, `prompt_pending`, `turn_running`, `target_not_found`,
  `stale_target`, `unseen_later_turn`, `poll_tool_result_target`,
  `target_splits_tool_call`, `delivered_poll_events_in_range`,
  `persist_failed` and `state_changed`.

**It is internal.**
- It appears in no SDK file (`sdk.d.ts`, `sdk.mjs`, `core.mjs`,
  `bridge.mjs`, `browser-sdk.js`: 0 hits) (read).
- It is not advertised in the `system/init` capabilities, which were
  `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1`,
  `mcp_read_resource_v1`, `mcp_tool_ui_meta_v1` (observed).
- `sdk.d.ts` does not declare `Query.request`; in the JS it is a plain
  method, not a `#private` one (read).
- It can change in any release, so it is safe only while the version stays
  pinned.

### What the target means (read in `JS()`; matches every run)

- `target_message_uuid` is the prompt to drop, not the entry to attach to.
  The in-memory messages are cut at the target's index. To attach the next
  prompt to entry X, target the first real prompt after X.
- A real prompt has to follow the attach point. A `tool_result` target, or a
  cut through a tool pair, is refused with `target_splits_tool_call`.
- The target could be matched on the `uuid` set on `SDKUserMessage`, because
  Claude Code kept it as the entry's uuid (observed).
- Rewinding back several turns needs `last_seen_user_message_uuid` set to the
  newest prompt (observed, multiback).

### The new prompt's parent (observed in every case)

- The next prompt's `parentUuid` is the last entry kept, the same parent the
  dropped prompt had. Often that is a trailing `attachment` entry.
- It is not `precedingAssistantUuid`, which named the assistant. The
  persisted `last-prompt.leafUuid` also names the assistant.
- So a `query.started.parent` would come from the `user` entry `append()`
  receives, not from the rewind response. Whether that changes the spec is
  open.

### What `append()` receives (observed)

- Everything from the abandoned branch stays in the store as a side branch:
  the cut prompt, the partial reply and the interrupt marker. Nothing is
  removed from the transcript.
- The rewind adds one entry: `{type:'last-prompt', leafUuid:<anchor
  assistant or null>, explicit:true, rewound:true}`, once, although it is
  both appended and mirrored.
- **It reaches `append()` at rewind time, with no next prompt needed.** In
  `run-background` and `run-background2` it arrived after the rewind
  response and before a check 1.5 s later, with no prompt sent; in
  `run-resume` it arrived after the rewind and before close, with no prompt
  ever sent. In `run-completed` the next prompt went out immediately, so
  there the order only looked as if the entry waited for it. From the code
  (read): the handler awaits the transcript write before it replies, and the
  eager store flush follows. The log has no timestamps, so the delay is
  bounded only at under 1.5 s.
- On close, Claude Code wrote another plain `last-prompt` at the anchor.
- The participant does not publish `last-prompt`: `roleOf()` in
  `mvp/apps/claude-code-participant/src/ConversationEntries.ts` drops entries
  without a `uuid` (read). The only sign of a rewind on the bus is therefore
  the next prompt's parent. Nothing else marks the rewind in `append()`.

### A rewind is durable

- **Observed:** a resume with no prompt sent lands on the anchor, not the old
  end (`run-resume`).
- **Why (read, the transcript loader `xun()`, around offset 38.1M):** while
  reading the transcript, each `last-prompt` sets the current leaf to its
  `leafUuid`. The `rewound` flag is carried by `_n = pn.rewound===!0 || _n &&
  pn.leafUuid===Mn`, and any later user or assistant entry on the main chain
  resets it. The loader returns `rewindAnchorUuid: _n ? Mn : undefined`, and
  resume passes that to the code that trims the message chain.
- In `run-resume` the transcript held the `rewound` `last-prompt` written at
  rewind time, then the plain one written on close (observed). The plain one
  names the same leaf, so the flag survives it, but it does not set the flag
  itself (read).
- **Without the `rewound` entry** (read): the loader falls back to the last
  `last-prompt` leaf only if that entry is still a chain tip. The anchor isn't
  one, because the abandoned branch hangs off it, so the loader takes the
  last main-chain entry: the old end.
- **Resuming from a store:**
  - The participant's `load()` returns `null` (`SessionStore.ts`), so a
    participant resume reads Claude Code's local transcript. The probe did
    the same and landed on the anchor, so the participant's resume would too
    (the report marks this observed, by the same path).
  - A store that returned the entries `append()` received would include the
    `last-prompt` entries, which the SDK hands to the same loader, so it would
    also land on the anchor (inferred).
  - What tower publishes doesn't carry `last-prompt`, so a resume rebuilt
    only from published entries would not carry the flag (inferred).

### The terminal's rewind (read, not observed)

- Esc with an empty input box: at turn end, if the abort reason is
  `user-cancel` and the input box is empty, the REPL calls
  `restoreMessageSync(lastPrompt, "auto_restore_cancel")`, which calls
  `rewindConversationTo()`. The message-selector rewind uses the same
  `rewindConversationTo()`. Both live only in the interactive REPL class, and
  nothing the SDK sends reaches them. One further condition on the Esc path
  was not isolated: the minified name `u7` is reused across chunks.
- `rewind_conversation` is the headless equivalent in the cut it makes, but
  not in what it persists. `rewindConversationTo()` cuts only the in-memory
  transcript (`N.cut()`, `N.replace(kept)`) and resets turn state. It
  contains no call to the `last-prompt` writers, unlike
  `rewind_conversation`, which calls `rst()`/`uEr()` with `rewound:true`
  before it replies.
- The plain leaf writer `NU()` writes the last in-memory message as an
  explicit leaf without `rewound`. Its callers found are all relaunch,
  restart and renderer-switch paths; it was not found on a plain exit, and
  that nothing is written then is not certain.
- With no `rewound` entry after the cut, the loader resumes at the old end
  (inferred). So the terminal's rewind is in memory only, while
  `rewind_conversation`'s is durable.

### Background shells survive the cut

- **Observed:** background shells started by the cut turn keep running, with
  the participant's `perTaskStopAffordance: true` and without it (`sleep 602`
  and `sleep 9` were still alive after the rewind). When one finished, its
  `<task-notification>` was appended to the new branch and reached the model:
  `SHELL-DONE-yankee` appeared in the next body. In `run-background2` each
  notification started its own turn.
- **Read:** the headless handler only kills running `mcp_task` tasks whose
  `tool_use` is in the cut range (`sk()`/`NT()`; the `rewind_conversation:
  stopping an MCP task failed` strings). Not exercised.
- **The terminal (read; nothing observed in the terminal):**
  `rewindConversationTo()` stops no tasks. It calls
  `_discardDetachedToolCallsOutside(kept)`, which throws away "detached tool
  calls" outside the kept messages and removes their queued task
  notifications. Whether a `run_in_background` Bash counts as a detached tool
  call was not established, so whether its notification is suppressed in the
  terminal is unknown. Nothing read kills the shell itself. The headless
  `rewind_conversation` does not call that function.

### The refusals `prompt_pending` and `commands_queued`

The reason picker sits next to the handler (read): `ge = queueLength>0 ?
"commands_queued" : !running && state==="requires_action" ?
"prompt_pending" : "turn_running"`.
- `commands_queued`: Claude Code's main-thread input queue holds something
  not yet started, such as a user message that has arrived but not begun, or
  a queued task notification.
- `prompt_pending`: no turn is running, but the session is waiting for an
  answer to a permission prompt, dialog or elicitation (`requires_action`).

Whether the participant could hit them (inferred from the code):
- **Its own prompt:** only if it pushes the prompt without awaiting the
  rewind response. The handler awaits its writes before replying, so a
  prompt read during that time lands in the queue, and the handler answers
  `state_changed` (it re-checks the queue and message count after persisting)
  or `commands_queued`. The participant must await the response before
  sending.
- **A background task notification:** it can still collide, and this is the
  realistic case. A finishing task's notification is queued
  (`commands_queued`), and since each notification started its own turn in
  `run-background2` (observed), that gives `turn_running` while the turn
  runs. `interrupt_if_running:true` aborts a running turn, but only when the
  queue is empty, so a queued notification still refuses.
- **`prompt_pending`:** needs an unanswered permission prompt. The
  participant sets `permissionPrompts: 'none'`, so this should not arise (not
  tested).
- Sent after `result`, the rewind never hit a refusal in these runs, but one
  run per case can't rule the race out.

### Cost and reach

- **Speed (observed):** 0 to 22 ms in the runs. The restart route's 1.1 to
  1.7 s comes from [the restart route's runs](cancel-before-reply.md) and was
  not observed again here. Background tasks, shells and in-process state all
  survive.
- **Returning to an abandoned branch:** it can't. Only the in-memory current
  branch is reachable (`target_not_found`, observed). The report names the
  restart route with `resumeSessionAt` as still needed for that; no run
  resumed onto a cut branch.
- **Stopping a cancelled prompt from being kept:** the only in-process way is
  `rewind_conversation`, after `interrupt()` or in place of it with
  `interrupt_if_running:true`. A plain `interrupt()` keeps the prompt and the
  marker.

### Other things checked: none gives a route

- **`fork_conversation`** (binary `Sk()`): needs a remote-control `sdkUrl`
  and creates a new remote session. Run locally (`run-fork`), it returned
  `{forked:false, error:'unsupported'}`.
- **`turn_handoff`:** hands an answered turn over to the queue (read). Not a
  rewind.
- **`cancel_async_message`** (public, `sdk.d.ts`): only withdraws messages
  still queued.
- **Message fields:** the binary's own user-message schema has no parent or
  leaf field. The stripped internal fields include `interrupted_message_id`,
  which its description and its one use show is telemetry only ("the API
  msg_* id that Esc cancelled"). Compaction's `anchor_uuid` and
  `logical_parent_uuid` are unrelated.
- **Options settable at runtime:** none in `sdk.d.ts` touches the
  conversation tip. `rewindFiles()` restores files only.

**Limits.** One run per case, Haiku only, one version pair. Some body logs
held only the new turn; `bodies/index.jsonl`'s `query_source:"sdk"`
identifies the main-loop requests. Inside the probe, Claude Code's Read of a
task's output file hit "read-only file system" from the nested sandbox; it
does not affect the findings.

**Resume comparison.** Neither.

**See also.** [The restart route](cancel-before-reply.md), and
[running.md](../participant/running.md), Cancel, rewind and the next say.
