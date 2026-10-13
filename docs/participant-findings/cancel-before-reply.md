# Cancel before the reply: the restart route

**Question.** Can the participant, through the Agent SDK, cancel a query so
that the next query attaches before the cancelled prompt? The next request
should carry neither the prompt nor the `[Request interrupted by user]`
marker, as the terminal does when Esc is pressed with an empty input box.
What does that cost, and what would the participant publish around it?

**Method.**
- **Harness.** One probe script ran the participant's own code:
  `composeConfig`, `participantServices`, `beforeServing`, `ControlLines` and
  `ConversationLauncher`. Two services were replaced through the DI container
  (the last registration wins), so no repo file changed:
  - a recording `IPublisher` in place of `BusPublisher`, logging every
    `append()` entry in order with the participant's own `kindOf`/`isPrompt`
    verdict on whether it would be published;
  - a wrapping `IClaudeCode` adding `includePartialMessages: true` (needed to
    time the cancels) and, on a relaunch, the resume options under test.
- **Each run:**
  1. Send `Reply with the word READY only.`
  2. Send the prompt to be cancelled, and cancel it with the participant's
     `Conversation.interrupt()`.
  3. Send `Reply with the word NEXT only.`, either in the same process, or
     after `close()`, waiting for Claude Code to exit, and relaunching with
     `resume: true` plus the options under test.
- **Captured:** request bodies with `OTEL_LOG_RAW_API_BODIES`, and the
  transcript afterwards.
- **Cancel triggers and prompts,** taken from the
  [cancel scenarios](cancel-scenarios.md) harness:
  - **Before the first byte:** when the cancelled prompt's request body file
    appears. No stream event had arrived in any of these runs.
  - **During thinking:** 700 ms into an open thinking block.
  - **After text:** 60 characters of text streamed.
- **Routes:**
  - `plain`: same process, today's behaviour.
  - `resume`: restart and resume.
  - `drop`: restart with `resumeSessionAt` = the cancelled prompt's
    `parentUuid` and `resumeDropsTurn` = the prompt's uuid.
  - `truncate`: `resumeSessionAt` alone.
  - `keep-last`: restart with `resumeSessionAt` = the last chain entry, which
    is the marker.

**Versions.** Agent SDK 0.3.285 (what the participant pins, `^0.3.285`) and
its bundled Claude Code 2.1.285; every captured body showed
`cc_version=2.1.285.cc3`. Model `claude-sonnet-5-5`, thinking adaptive,
display summarized, effort medium: the `start.ts` model line.

**Runs.** All observed.

| Cancel point | plain | drop | resume | truncate | keep-last |
|---|---|---|---|---|---|
| Before the first byte | 1 | 3 | | | 1 |
| During thinking | 1 (+1 that missed its trigger, excluded) | 3 | 1 | 1 | |
| After text | 1 | 1 | 1 | | 2 |

Plus one control run with no cancel. The report counts 18 runs in all, which
includes the excluded run. The run data was in a session scratchpad and has
been lost, so neither the runs nor these counts could be checked on disk.

**Found.**

### 1. A route exists where nothing came back (observed)

After the interrupted turn's `result`: close the conversation, wait for
Claude Code to exit, then relaunch with `resume`, `resumeSessionAt` = the
cancelled prompt's `parentUuid` and `resumeDropsTurn` = the cancelled
prompt's uuid. `resumeDropsTurn` was never refused.

The NEXT request carried neither the prompt nor the marker in every drop run:
3 of 3 before the first byte, 3 of 3 during thinking. In 2 of those 6 the
NEXT message also carried a session-context reminder block (point 6).

Before the first byte (run `first-byte-drop-...13-14-14`), with the opening
reminders and the Environment system message shortened:

```
thread: {"type":"create"}  diagnostics: {"previous_message_id":"msg_011CfxQM6TUpm8pUMhpwhqLf"}
[0] user:      <system-reminder>(session context)</system-reminder> | <system-reminder>(git attribution)</system-reminder> | "Reply with the word READY only."
[1] system:    "# Environment ... Today's date is 2026-10-13."
[2] assistant: "READY"
[3] user:      "Reply with the word NEXT only."
[4] system:    "<total_tokens>15000000 tokens left</total_tokens>"
```

During thinking (run `thinking-drop-...13-11-40`): the same shape.

For comparison, today's same-process `interrupt()` on 2.1.285 sends
`[3] user: <cancelled prompt> | "[Request interrupted by user]\n" | "Reply
with the word NEXT only."` (runs `first-byte-plain`,
`thinking-plain-...13-09-11`), matching the SDK row for 2.1.282 in
[cancel scenarios](cancel-scenarios.md).

Inferred, not a run comparison: the drop request's messages are the same
content as a conversation with no cancel. The control can't be compared body
to body, because its NEXT went `thread: continue` with only the new messages.

**The transcript after a drop** (observed): the cancelled prompt and its
marker stay in the file. The NEXT prompt's `parentUuid` is the cancelled
prompt's parent, so the cancelled turn is a side branch: the terminal's
shape.

`resumeSessionAt` without `resumeDropsTurn` (one run, during thinking) gave
the same request as drop.

Not run: the refusal path of `resumeDropsTurn`; a cancel during a tool run;
any model other than Sonnet 5.5.

### 2. After text has started, drop throws the partial reply away (observed)

- **Same process (`plain`) keeps the partial reply and the marker,** matching
  the terminal: `[5] assistant: "one\ntwo...thirte"` (the partial, recorded
  with `isAbortedMidStream`), then `[6] user: "[Request interrupted by
  user]\n" | "Reply with the word NEXT only."`.
- **`drop` wasn't refused here either, and threw the partial reply and the
  marker away.** The NEXT request was READY then NEXT. The guard does not
  protect a partial reply, so the participant would have to decide drop or
  keep itself, from what `append()` gave it for that query: an assistant
  entry with `isAbortedMidStream`, or none.
- **A plain `resume` adds a reply that was never there.** After the marker,
  Claude Code inserts `assistant: "No response requested."`. The same happens
  after a thinking cancel with a plain resume.
- **`keep-last` (restart with `resumeSessionAt` = the marker) gives the same
  request as same-process.** Run `mid-text-keep-last-...13-12-19`:

```
[2] assistant "READY" [3] user <prompt> [4] system <total_tokens>
[5] assistant "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve"
[6] user: "[Request interrupted by user]\n" | "Reply with the word NEXT only."   [7] system <total_tokens>
```

So with text: either don't restart, or restart with `resumeSessionAt` = the
last entry. Both keep the partial reply and the marker.

### 3. What `append()` receives, in order (observed)

**Before the first byte** (all 5 runs): the interrupt landed 3 to 4 ms before
the prompt's append. The prompt, its `total_tokens_reminder` attachment and
the marker arrived in one batch, after the cancel:
- the prompt (`kind=prompt`, published);
- the attachment (not published);
- the marker (`kind=null`, not published);
- then `last-prompt` and `cost-state`.

So at this trigger the prompt was not yet published when the cancel landed.
That is a race at the earliest trigger, not a guarantee, and the participant
still publishes the prompt the moment it arrives, because it publishes on
append.

**During thinking and after text:** the prompt and its attachment arrived
about 80 to 100 ms after the send, well before the cancel, so they were
published first. Then:
- during thinking: the marker;
- after text: the partial assistant entry (`kind=reply`,
  `isAbortedMidStream: true`, published), then the marker.

**After the relaunch:**
- No earlier entry is appended again.
- The new process appends, in order: two `queue-operation` entries; the NEXT
  prompt, its parent the fork point; `total_tokens_reminder`; sometimes a
  `session_context` attachment; the reply; `last-prompt`, `mode`,
  `cost-state`.
- Same session id, same `.jsonl` file: no fork to a new session.

### 4. Cost

- **Restart time (observed):** close to Claude Code's exit took 0.45 to
  1.0 s; relaunch to the NEXT request going out took 0.66 to 0.93 s. About
  1.1 to 1.7 s in total, against about 10 ms from send to request in the same
  process. These leave out the harness's fixed 2 s wait after the cancelled
  turn's result.
- **Cache (observed):** cache reads on the NEXT request matched exactly
  between drop and plain interrupt: 12929 against 12929, and 13108 against
  13108. Both are `thread: create`, because a same-process send after an
  interrupt also re-creates the thread, so `create` is not a cost of the
  route.
- **The old query's iterator throws (observed, every restart run).** Closing
  the conversation after an interrupted turn makes it throw `Claude Code
  returned an error result: [ede_diagnostic] result_type=user
  last_content_type=n/a stop_reason=null`. In the participant,
  `ServedConversation.follow()` logs that and calls `endQuery('aborted')`.
  `ConversationChanges.close()` publishes nothing when no query is open
  (read), so there is no extra closure, only a log line.
- **Read, not run:**
  - Background tasks and shells end with the process. Today,
    `Conversation.interrupt()` leaves them running.
  - In-memory state is lost: read-file state, MCP connections, any mode
    change made at runtime.
  - `ConversationLauncher` relaunches with whatever the control lines hold
    now, not what the conversation started with.

### 5. What the route has to handle

- **The fork point is not a published message (observed).** In every run the
  cancelled prompt's `parentUuid` was an attachment uuid, not the READY
  reply's uuid. Message ids on the bus are entry uuids, so any `parent` or
  `to` the participant states has to name the last published message at or
  before the fork point, which takes a step to map one to the other.
- **The tip read for a say's precondition would be wrong after a drop
  (inferred, not run).** `lastMessageId` in `ClaudeCodeRecord.ts` reads the
  transcript in file order. After a drop, the cancelled prompt is still the
  last line with a role until the next prompt is written, so a say whose
  `precondition.tip` names the message before the cancelled prompt would be
  refused as stale.

### 6. Session-context reminder (observed; doesn't change the answer)

The report says that in 3 of 6 resumed runs the next user message gained a
block: `<system-reminder>The session context was re-read when this session
started; these values replace the earlier ones: # userEmail ...`. In
`keep-last` it was merged into the marker message. It appeared only when the
first turn had recorded an empty `session_context`: a race at session start,
visible in the first requests too, which a restart re-reads. The probe
inherited the agent session's environment, not the participant's usual
start, so whether the participant would see it is not claimed either way.

### 7. Spec options for the entries already published (read; none chosen)

The entries: the cancelled prompt, which is published (before the first
byte, possibly not yet at the moment of the cancel, but published on
arrival). The marker isn't published today. With text, the partial reply is
published and is meant to stay. Sections are in `docs/spec/conversation.md`.

- **`tip_moved`** with `to` = the last kept published message (The change
  stream; the tree and rewind text in The entity; scenario 3). This is a
  rewind: the cancelled prompt becomes unreachable from the tip but stays in
  the log (unreachable is not deleted).
- **`query_started` with `parent`** = the last kept published message, for the
  next query (The change stream; Query start and closure). The next query
  then attaches before the cancelled prompt. Two things are open: whether a
  start away from the tip with no `tip_moved` before it moves the tip is
  unspecified (Open questions); and the participant publishes no
  `query.started` today, only `query.closed`.
- **Both:** `tip_moved`, then `query_started` whose `parent` is the new tip.
  This is scenario 9's shape (`docs/spec/scenarios.md`), where the open
  question doesn't arise.
- **`query_closed` with `cancelled`** (The change stream; Query start and
  closure) records that the query ended. It doesn't take the prompt out of
  the conversation, because the record is the answer.
- **`revision`** only changes content under a stable id. The message stays
  reachable.
- **Not committing the prompt at all** is the spec's recommended declaration
  for a cancelled say (The change stream; Implementation details). It applies
  only to a prompt not yet published: the participant would have to hold the
  prompt until something comes back. The before-first-byte case shows that
  hold would sometimes be in time.

**Limits.** Sonnet 5.5 only; one version pair; the sandbox control line left
out, because no tools were used; `includePartialMessages` added; the thinking
prompt changed to a harder one, because the cancel scenarios one didn't think
at medium effort. The terminal itself wasn't run: the terminal target is
taken from [cancel scenarios](cancel-scenarios.md) (2.1.283).

**Resume comparison.** Before against after: the resumed NEXT request
compared with the same-process one; the control could not be compared body
to body.

**See also.** [rewind_conversation](rewind-conversation.md), the in-process
route, and [running.md](../participant/running.md), Cancel, rewind and the
next say.
