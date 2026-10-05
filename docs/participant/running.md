# How the participant runs Claude Code

## The shape

- **Through the Agent SDK,** so the participant stays small: there has to be
  code to translate to NATS anyway, and the SDK does the rest.
- **TypeScript, in `mvp/apps/claude-code-participant`,** inside the repo's
  pnpm workspace (not a submodule). See [building.md](building.md).
- **One `query()` per served conversation, fed a stream of messages**
  (streaming input). Claude Code keeps running between messages, so
  background tasks keep running and can report back. A `query()` per message
  would exit after each reply.
- **Tower starts nothing itself.** Things happen through requests on NATS,
  such as `service`.
- **The conversation id is Claude Code's session id.** The participant
  rejects an id that isn't a UUID; the spec leaves the id a free string by
  design.
- **Message ids are Claude Code's own entry ids.**

## When something counts as committed

- **A message is published only once Claude Code has committed it** to its
  own record.
- **The commit signal is the SDK's session store.** With a session store, the
  SDK runs Claude Code with `--session-mirror`; after each local write Claude
  Code emits a mirror frame and the SDK hands the entries to the store's
  `append()`, every entry, in order, with the same content as the transcript
  file. A Ctrl-C is the case to get right, not Claude Code being killed with
  no chance to act.
- **Eager flush:** each entry reaches `append()` as soon as Claude Code writes
  it, within a few milliseconds, which is the closest match to how Claude
  Code commits on its own. The SDK delivers a query's `result` only after
  that query's appends.
- **Entries come from `append()`.** Messages are never rebuilt by reading
  Claude Code's transcript file, which is an undocumented format.
- **The conversation is what is published,** which is almost, but not
  exactly, Claude Code's transcript. What is committed is part of the
  conversation; what isn't committed yet is local state. The spec leaves a
  harness leeway here: publish a query and then its abort, or publish only
  once something comes back. The participant takes the first:
- **What is committed follows Claude Code.** Whatever Claude Code keeps in
  its record is committed, including a cancelled prompt: over the SDK Claude
  Code keeps it in a straight line (prompt, interrupt marker, next prompt)
  and sends it merged with the next prompt. A killed host (no chance to
  flush) is the known gap; it loses only the end, and only when there is no
  transcript to recover from either.
  (Findings: [proof 3](../participant-findings/proof-03-session-store.md),
  [proof 23](../participant-findings/proof-23-commit-timing.md),
  [cancel scenarios](../participant-findings/cancel-scenarios.md),
  [store commit and resume](../participant-findings/store-commit-resume.md).)

## Messages and turns

- **Each piece of a reply is its own message:** thinking, text and each tool
  call are published as separate `changes.message`s with Claude Code's ids,
  as they are written. Every piece keeps its own id on tower, so a rewind to
  any piece has an id to name
  ([proof 2](../participant-findings/proof-02-entries-to-messages.md)).
- **A turn is one API round:** what was sent to the API and what came back.
  Every message belongs to the turn it first appears in. The publisher groups
  a reply's pieces by the API response id they share (`message.id`), so
  parallel tool calls stay in one turn; input that follows a reply joins the
  next turn.
- **A retried API request keeps its turn;** retrying is internal to Claude
  Code. An abort followed by a resend is a new turn. If Claude Code has no id
  for an API request, one may be minted. The name "turn" stays, because cost
  scales with the turn count. (The spec doesn't yet say that retries share a
  turn; see [spec-and-frontend.md](spec-and-frontend.md).)
- **Turns Claude Code starts itself,** when a background task finishes: the
  participant mints the query id, as the spec allows for input that didn't
  come through a say.

## Resuming

- **A conversation resumes from Claude Code's own record** in the agent's
  config dir. The session store's `load()` returns null, which makes the SDK
  read the local record. Returning entries instead would make the SDK resume
  from a temporary copy it writes under `/tmp/claude-resume-<uuid>` (see
  [resume.md](resume.md)).
- **Resume goes through the session store,** the SDK's supported path, not
  Claude Code's undocumented `--resume` from files.
- As built, whether a conversation is fresh or resumed is decided by whether
  a local record exists for its id. That was the builder's choice; nobody
  ruled on it.

## State and authority

- **Claude Code is the source of state.** The participant publishes what
  Claude Code knows, so a say's precondition is checked against the tip in
  Claude Code's own record.
- **The model is not conversation state.** A conversation can continue on a
  different model; Claude Code checks `message.model` only loosely on resume
  ([proof 9](../participant-findings/proof-09-resume-spec.md)).
- **Whatever Claude Code loads may go onto NATS,** the account email in
  reminders included. The bus is the storage of the conversation, just as the
  transcript on disk is.
- **Open: whether tower (the published record) is the authority on what a
  conversation holds.** A brief stated that tower is the authority and a commit
  is a fact; it rests only on that brief being sent. Stephen's own words are
  narrower: if the local conversation is gone, the bus is the authority
  anyway.

## Working directories

- **Every `service` carries a cwd;** there is no default (see
  [presence.md](presence.md)).
- **Additional working directories** use the SDK's documented
  `additionalDirectories` (passed as `--add-dir`), set when a conversation is
  served and sent again on every resume, because a resume drops them
  ([proof 10](../participant-findings/proof-10-directories-permissions.md)).
  Removing one is not needed, and neither is adding one to a running
  conversation. As built, the launcher takes the list but `service` passes
  an empty one: nothing on the bus names additional directories yet.

## Claude Code's process

- Each Claude Code runs in its own process group (see
  [shutdown.md](shutdown.md)), through `setpriv --pdeathsig SIGINT` where
  `setpriv` exists.
- Claude Code's stderr goes to the participant's stderr. Logging isn't
  designed (see [errors.md](errors.md)).
- Claude Code runs with a private `HOME` and the participant's config dir
  (see [configuration.md](configuration.md), The login and the private HOME).
