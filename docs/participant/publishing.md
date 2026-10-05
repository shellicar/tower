# The publisher: what goes on `changes`

The rule this follows is in [purpose.md](purpose.md): everything the model
sees must be published, and what the user needs to see is published too.
How the published messages reach the stream is in [delivery.md](delivery.md).

## What is published today

Each entry Claude Code commits reaches the session store's `append()` (see
[running.md](running.md)); the participant classifies it and publishes:

- **prompts** (user text with no `origin`, or a `human` one);
- **every piece of each reply** (thinking, text, each tool call), each its own
  `changes.message`;
- **tool results**, interrupted ones included;
- **background agents' reports,** handed back to the main conversation;
- **Claude Code's notice that a background task ended;**
- **assistant entries Claude Code writes itself** (model `<synthetic>`: an
  API error, "No response requested.");
- **Claude Code's `system` entries;**
- **each query's end** as `changes.query.closed` (`completed` when the SDK
  reports success without an error, `cancelled` for an accepted cancel,
  `aborted` otherwise, including a query cut by shutdown).

`query.started` is never published yet.

## What is not published yet

Seen by the model, owed under the rule: reminders (`isMeta` user entries),
compaction summaries, attachment entries (whose `rendered` blocks become the
reminder text the model gets), interrupt markers (the texts Claude Code
writes to mark an interruption, matched against a fixed list read from
Claude Code 2.1.283).

**Where a reminder sits in what the model received is semantic,** not
presentation. Publishing Claude Code's entries in the order it writes them,
where that differs from where the model received a reminder, records a
conversation that never happened. How the participant produces the form the
model received, and turns it back into Claude Code's entries on resume, is
open (see [resume.md](resume.md)).

Not seen by the model: bookkeeping entries. Subagent entries (their own
records) are not published; see [subagents.md](subagents.md).

What the model sees, entry kind by entry kind, is in
[what the model sees](../participant-findings/what-the-model-sees.md).

## Roles

- `user` and `assistant` as the API has them: the user's side of the API and
  the model's side. No single flag marks what Claude Code wrote itself, so
  the classifier works kind by kind
  ([proof 15](../participant-findings/proof-15-machine-messages.md)).
- **`system` is Claude Code's own notes:** the `system` entries in its record,
  such as a compaction notice or a turn's duration, which the model mostly
  never sees. The spec's role is an open set and names `system`.
- A `system` entry is published with its `subtype` and fields dropped, so a
  turn-finished line publishes empty content and tower can't tell it from a
  recap or a retry note.

## Who wrote each message (`from`)

`from` says who wrote a message: a human, an agent or an orchestrator. A
message the harness generated has none. It is provenance, never fabricated.
Each kind of message the participant publishes is its own case in code
(`kindOf` in `src/ConversationEntries.ts`), and each case's `from` is set in
one place (`fromOf` in `src/ConversationChanges.ts`). Anything no case
recognises gets the catch-all, which is always "unknown" in tower (no
`from`).

| Kind | `from` |
|---|---|
| A prompt | The `from` of the say that opened its query, used by the first prompt in it |
| A piece of Claude's reply | `{kind: "agent"}`, as bridge does |
| A tool result | none |
| A `<synthetic>` assistant entry | none |
| Claude Code's notice that a background task (a command or an agent) ended | `{kind: "orchestrator"}`: a message generated for orchestration |
| A background agent's report, handed back | `{kind: "agent"}` |
| Every other task notification, each its own case by `subkind` or `source` | none |
| User text with any other `origin` kind, each its own case | none |
| A Claude Code `system` entry | none |
| Anything unrecognised | none |

Peer messages (from other sessions) and check-ins are not handled. A peer
message would be `{kind: "agent"}` too, with a way to say which agent;
undecided: how it says which. Check-ins wait until they show in the UI.

**How tower labels a message** (both frontends, the same way): with a `from`,
the author; without one, "tool" if it holds a tool result, "system" if its
role is `system`, and "unknown" otherwise. The label belongs to the message,
not its blocks. A fallback to "system" or "assistant" for every message
without a `from` would be a fabrication, right only by coincidence.

## Files in messages

A file a message carries (base64 image or document, including inside tool
results) is stored in the durable bucket first, and the message carries a
reference in its place. A message is never published pointing at a file that
isn't stored (see [object-stores.md](object-stores.md)). A file that can't be
referenced (no media type) aborts the main turn; background subagents run on.

## Time

The participant stamps `ts` when the message is handed to the outbox, not
when Claude Code wrote the entry. Tower must be able to show a message's
original time (for example a turn-finished line's time, like Claude Code's
"done HH:MM"). Whether that reuses `ts` or adds a field is open, as is
whether query-level timing metadata could serve instead.

## Live replies (MVP)

Each block streamed as it is written, thinking included. Not built: the
participant doesn't set the SDK's `includePartialMessages`, so it has no
deltas. The wire has `conv.v2.{id}.deltas` (flat; `{type: block, blockType}`
and `{type: delta, text}`), and tower already renders bridge's deltas.
Foreground subagents send only tool calls unless `forwardSubagentText` is set
([proof 5](../participant-findings/proof-05-subagents-and-shells.md)). Open:
which partial events map to block and delta, and whether subagent output
streams.

## Extras (open)

"Extras" are the kinds of message beyond the plain chat that the model or the
user sees: reminders, hand-backs, task notices, interrupt markers, compaction,
turn-finished lines, API errors, alerts and so on. Each kind is worked
through for how it is sent to the API, whether it reaches the model (its
visibility), and how hard it is to support. Extras are not an MVP blocker.

21 kinds are catalogued, with two designs: A (generic: `audience`,
`userContent`, `at`, `scope` on `changes.message`) and B (typed: A plus
`kind` and `fields`), prototyped on the unmerged branches
`proto/extras-generic` and `proto/extras-typed`, not yet looked at
([extras design](../participant-findings/extras-design.md)). Undecided:
which design, if either. Towerd reads a closed set of fields from
`changes.message`, so a new envelope field needs towerd, the WS spec and both
frontends to change.

## Display

- Tower shows the current state of the conversation, not everything Claude
  Code records. Publishing everything Claude Code records isn't wrong, only
  wasteful.
- **Tower collapses messages by default,** as Claude Code does with verbose
  off.
- **Alerts are a sticky line above the input,** not transcript messages
  (usage-limit warnings, "update installed", key hints). They aren't in
  Claude Code's transcript. "Alert" is a kind, not the line. The SDK's
  `system/notification` messages are a candidate channel; whether they fire
  headless isn't known.
- **Showing a conversation as Claude Code's terminal does** is an aim, not
  MVP, and not a copy of Claude Code's UI. How Claude Code draws each kind is
  in [Claude Code's rendering](../participant-findings/claude-code-rendering.md).

## Open

- How the unpublished model-seen kinds are carried, and the extras design.
- Keeping each `system` entry's subtype and fields.
- The original-time carrier.
- A test that pins what is published against what a resume needs (nothing
  pins it today; see [resume.md](resume.md)).
- The two catch-all cases marked in `src/ConversationEntries.ts`: whether each
  `artifact-*` task-notification source is its own case, and what a bare
  task notification (no subkind, source or producer, as webhooks write) is.
- Known edges in the classifier: a reworded interrupt marker would be
  published as a prompt (and could carry the say's `from`); a slash-command
  record is published as a prompt; a compaction's preserved-message list
  names entries never handed to the store.
