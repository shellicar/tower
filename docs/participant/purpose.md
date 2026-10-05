# Purpose and the publish rule

## What the participant is for

The Claude Code participant puts Claude Code on tower's bus as one more
participant, through the Agent SDK. Claude Code is the harness, tower is the
interface, and the bus is the seam between them. The point is to get Claude
Code's features without rebuilding them, while the effort goes into
presentation (tower's UI) instead of harness tooling.

Tower's protocol does not change to suit Claude Code. The spec changes the
participant has needed so far are listed in
[spec-and-frontend.md](spec-and-frontend.md).

## Goals

- **The happy path first:** seeing a conversation in tower and saying into it.
  What works easily comes first; features that need more work come later.
- **Auto mode is make or break.** It is one of the main reasons for using
  Claude Code at all.
- **Summarised thinking is make or break.** It works end to end on Sonnet 5,
  Opus 5.5, Fable 5.1 and Haiku 4.5 when the display is declared
  ([proof 1](../participant-findings/proof-01-thinking.md)).
- **Rewind is make or break,** but not needed to start using the
  participant. When Claude Code rewinds itself, the move is published as
  `tip.moved`. Tower needs no request to ask for a rewind.
- **Daily use instead of the terminal.** The MVP is what it takes for its user
  to use the participant every day with no scripts outside tower (see
  [scope.md](scope.md)).
- **The wider aim:** connect every machine at home to one broker and manage
  all sessions in one UI. Resuming a conversation from the bus is a goal, but
  not the primary one, and it may have to be relaxed (see [resume.md](resume.md)).

## The publish rule

**Everything the model sees must be published.** The test for an entry is
whether it is sent to the API; if it is, it must be published. That is the
minimum.

- "Published" means carried on the bus by the participant. It does not have to
  mean that tower stores or shows it; "in tower" is shorthand.
- What is published does not have to render in tower, and is not limited to
  what tower shows.
- Beyond the minimum, what gets published is not decided.
- What the user needs to see is published too, even when the model never sees
  it. Claude Code's error text is the standing example (see
  [errors.md](errors.md)).

**Where it stands in the code.** The participant publishes prompts, every
piece of each reply, tool results, background agents' reports and Claude
Code's `system` entries. Reminders (`isMeta` entries), compaction summaries,
attachment entries and interrupt markers are seen by the model and are not
published yet; under this rule they are owed. Subagents' own entries are not
published either; whether the rule covers what a subagent's model sees is
open (see [subagents.md](subagents.md)). Details are in
[publishing.md](publishing.md).

### Why everything the model sees

A conversation that wasn't published can't be reproduced: nothing can rebuild
what it doesn't have. Full reproduction (a resume from the published record
sending the same request as a resume from Claude Code's own record) may turn
out not to be achievable. The minimum is what makes trying possible, so the
rule holds either way.

## Showing is a separate question

What tower shows is not the same as what is published. Tower shows the
current state of a conversation, not everything Claude Code records, and it
collapses messages by default (as Claude Code does with verbose off). Showing
a conversation the way Claude Code's terminal does is an aim, not part of the
MVP, and not a copy of Claude Code's UI (see [publishing.md](publishing.md),
Display).

## Constraints that shape everything

- **No ambient configuration.** Everything that changes the outcome is
  declared; nothing comes from the user's own Claude Code setup. See
  [configuration.md](configuration.md).
- **Linux and macOS only for now;** Windows is planned for v1.
- **The test broker for every trial run** (port 31416, never 4222). Conv
  subjects are keyed by conversation id, so anything published to the live
  broker is permanent.
- **Fix only what the participant needs.** Anything else found along the way
  is noted and parked, not fixed in passing
  ([parked elsewhere](../participant-findings/parked-elsewhere.md)).
  Undecided: how this applies to MVP items that change tower itself (serving
  from tower, the frontends).

## Open

- Whether the rule covers what a subagent's model sees, given that subagent
  entries don't go onto the bus.
- Whether publishing everything the model sees is itself an MVP item (see
  [scope.md](scope.md), Open).
- How the unpublished model-seen kinds are carried (see
  [publishing.md](publishing.md), Extras).
