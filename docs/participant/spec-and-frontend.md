# Spec and frontend changes the participant brought

The spec is reference only: it states the contract, with no argument,
history or quotes. The reasons live in these participant docs. Spec changes
for the participant have gone on the epic branch rather than as separate PRs.

## Done

- **`turn.started.maxTokens` is optional;** wire and helm accept a missing
  value. No conformance fixture exercises it yet.
- **`system` is a named `changes.message` role** beside `user` and
  `assistant`. The role is an open set.
- **`from` is defined by authorship:** a human, an agent or an orchestrator.
  A message the harness generated (a tool result, a system message, a
  reminder) has none.
- **A turn is one API round,** what was sent and what came back; every message
  belongs to the turn it first appears in.
- **A cancelled turn's partial reply is the implementation's declaration,**
  with no recommendation (fixture `v2/scenario-2c.jsonl`). Claude Code keeps
  the partial reply and the model sees it; what a harness commits is up to it.
- **`busy` is a known `chdir` rejection reason** beside `unsupported`, for a
  `chdir` while a query runs (fixture `agent/scenario-a17.jsonl`).
- **The agent events `unavailable` and `offline`,** with `ready` redefined
  (see [presence.md](presence.md)).
- **The durable object store** (see [object-stores.md](object-stores.md)).
- **A query's parent is explicit.** `changes.query.started` carries `queryId`
  and an optional `parent` (a message id; absent means the query follows the
  tip; never `null`). The closure is renamed `changes.query.closed`;
  `changes.query` stays in v2 as its old name, read forever and never
  published again. The rename stays inside v2 with no exception sentence,
  because tower is the consumer. Towerd reads `query.closed`; the participant
  publishes `query.closed` but not yet `query.started`.
  - Why the parent belongs to the query and not to every message: inside a
    query messages follow in order, and a single Claude Code was never seen
    to branch inside a query. A per-message parent (like Claude Code's
    `parentUuid`) can be added later as an extension; taking it away later
    couldn't be done ([branch analysis](../participant-findings/branch-analysis.md)).
  - Why a start event: the query's only other change on the wire is its
    closure, which comes too late to place its messages as they stream. A
    parent on the query's first message was rejected: that is a parent on a
    message, not on the query.
  - `tip.moved` is for an isolated move, such as a rewind; you can't rewind
    mid-query without aborting it.
- **Not taken:** a `shutdown` query reason. A query cut by shutdown closes
  `aborted`, which the spec already has.

## Frontends

- A message with no `from` is labelled by what it is, in both frontends
  (`sender_label` in `mvp/frontend-leptos/src/concerns/conversation.rs`,
  `senderLabel` in `mvp/frontend-svelte/src/lib/core/sender.ts`): the author;
  else "tool" for a tool result; else "system" for role `system`; else
  "unknown". The label belongs to the message, not its blocks.

## Owed

- Old fixtures that still use `changes.query`; whether a start away from the
  tip moves the tip. With `null` gone, a new root in a non-empty conversation
  can't be expressed.
- The code side of `query.started` (wire, towerd, bridge).
- The spec doesn't say that a retried API request keeps its turn (one
  sentence, its own spec PR, when wanted). A glossary line is owed too:
  Anthropic's "turn" is tower's query.
- From the agent events: fixtures for `unavailable`, `offline` and a repeated
  `ready`; `mvp/docs/tower-ws-spec.md`, `tower-v1-design.md` and CLAUDE.md
  still derive liveness from `lastPulse` alone; `scenarios.md` line 374.
  Cases the definitions don't cover: whether `unavailable` blocks a same-world
  `service` forever, whether `ready` starts the silence clock, ordering across
  leaves, world availability across instances, `host` on the new events.
- `mvp/docs/tower-ws-spec.md`, Attachments, still has wording from before the
  durable store.
- Towerd shows the row's last kind as "query" for a `query.closed` (keep it,
  use the literal leaf, or "query_closed").
- A glossary for model, harness, conversation, transcript, session, commit
  and local state, worked out but not written.
