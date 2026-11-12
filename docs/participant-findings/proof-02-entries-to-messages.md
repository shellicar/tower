# Proof 2: transcript entries and SDK messages

**Question.** How do Claude Code's transcript entries map to SDK messages
and to API requests?

**Method.** One response with thinking, text and a tool call; a per-run
`analysis.txt`.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (from the run logs).

**Runs.** 3, on Sonnet 5. Branch `proof-2-entries` (05e6cd7); no README
section of its own.

**Found.**
- One API response arrives from the SDK as one assistant message per content
  block, each with its own uuid, sharing `message.id` and `request_id`, with
  an interim `stop_reason: null`.
- The transcript holds one entry per block (with `apiBlockIndex`, the final
  stop reason and usage); the next request merges them back into one
  assistant message.
- A prompt sent with a client uuid keeps it; without one Claude Code mints
  one. The SDK echoes prompts only with `--replay-user-messages`.
- A message sent mid-turn gets no user entry and reaches the model as a
  system reminder.
- An interrupt keeps the partial reply (`isAbortedMidStream`) and adds
  "[Request interrupted by user]"; the model sees both.
- Bookkeeping entry kinds: queue-operation; attachments (environment, model,
  token reminders, date, queued command, MCP instructions), which become
  system-role text; session_context, credential_org, prompt_snapshot,
  atis-latch, ai-title, last-prompt, cost-state.
- `parentUuid` points to the previously written entry, attachments included;
  parallel tool results branch the chain; `promptId` groups a prompt with its
  tool results.
- With the betas `mid-conversation-system-2026-04-07` and
  `message-threads-2026-08-12`, what the model saw of an interrupted reply is
  held server-side.
- The account email reached the model through `session_context`.
- Spec fit at the time (required if the participant publishes what Claude
  Code keeps): a cancelled turn's partial reply. Since changed in the spec.

**Resume comparison.** Not about resume.

**Used by.** [running.md](../participant/running.md),
[spec-and-frontend.md](../participant/spec-and-frontend.md).
