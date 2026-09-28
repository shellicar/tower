# Claude Code as a participant

Claude Code joining tower's bus as one more participant, through the Agent
SDK.

This is the decision record. Nothing is built yet. Every decision here is
Stephen's, with the date he made it and, where it matters, his words. Open
questions are listed under [Open](#open). Evidence comes from proofs run on
26 and 27 Sep, each on its own branch (listed under [Evidence](#evidence)).

## Goal

- Claude Code joins tower's bus protocol as one more participant. Tower's
  protocol does not change to suit Claude Code (23 Sep).
- What's published on `changes` is exactly what the model sees. "if it
  doesnt have somtehing, then i need to know / if it has something that the
  model doesnt see, id want to know why" (26 Sep). It is about `changes`, not
  everything published.
- The happy path is what matters: seeing a conversation in tower and saying
  into it (23 Sep). "get what works easily first, if it requires more work
  later for more features, thats fine" (26 Sep).
- Auto mode is make or break: "its one of the major reasons im moving to
  using claude code again" (26 Sep).
- Summarised thinking is make or break (26 Sep). It works end to end on
  Sonnet 5, Opus 5.5, Fable 5.1 and Haiku 4.5 when declared (proof 1).

## Scope of v0

In:

- Seeing a conversation in tower and saying into it.
- Auto mode.
- Images sent with a `say` (26 Sep).

Out of v0:

- **Approvals.** "anything that cannot be auto approved by automode, can be
  droped, ie AskUserQuestion" (26 Sep). When they come, each ask only has to
  work in one place: answers on the bus and in the terminal aren't
  reconciled (23 Sep).
- **Rewind.** Make or break, but "i dont need it to *start using* it"
  (23 Sep). When Claude Code rewinds itself, that is published as
  `tip.moved`. Tower doesn't need a way to ask for a rewind (23 Sep).
- **Addressable subagents.** Not needed, though they'd be nice. They "likely
  needs first class support on the bus". They could be conversations of
  their own, "but then they would show up as well, and havign them *not*
  show up as independent conversation is the v0 goal" (26 Sep).
- **Showing a conversation's shells and subagents.** "its not needed for v0,
  but highly desirable, it is for v1" (26 Sep). What Claude Code can send
  about them is mapped in proof 5.
- **Queueing messages.** "not needed to start using claude / but it is
  something that i find useful / remember that i designed the nats spec
  around multi user / but realistically, i need it to work for me today / so
  that would *potentially* require a change to the spec, or to use say with
  the precondition as the current query" (26 Sep). v1.

Not at all:

- File checkpointing (23 Sep).
- A proxy between Claude Code and the API, except as a fallback (23 Sep).

## How it runs

- **The Agent SDK** (23 Sep): "i dont want to write a huge amount of code /
  and we need some code to do the nats layer translation *anyway*".
- **TypeScript,** as a directory under `mvp/`, not a submodule (25 Sep).
- **pnpm, inside the repo's workspace** (25 Sep).
- **The official NATS client,** `@nats-io/transport-node` 3.4.0 and its
  `@nats-io/*` companions, never the deprecated `nats`: "if issues come up,
  we address them" (25 Sep).
- **One `query()` per served conversation, fed a stream of messages**
  ("streaming input"), so Claude Code keeps running between messages and
  background tasks can keep running and report back (26 Sep). One `query()`
  per message exits after each reply; the V2 session interface was removed
  in SDK 0.3.142.
- **Tower starts nothing itself.** Things happen through requests such as
  `service` on NATS (23 Sep).
- **The conversation id is the Claude Code session id** (23 Sep). The
  participant rejects a non-UUID id: "in practice everything should be a
  uuid, but it's a free string on the spec by design" (26 Sep).
- **Message ids are Claude Code's own ids** (25 Sep, confirmed 26 Sep).
- **A message is published only once Claude Code has committed it** (23 Sep).
- **The commit signal is the SDK's session store** (25 Sep): "ctrl-c is what
  we're going for, not claude code being kill -9 with no ability to do
  anything about it". Proof 3: `append()` receives every transcript entry,
  same content and order.
- **Eager flush:** each entry reaches the store as soon as Claude Code
  writes it. Follows from "we dont want to commit too early, as close is
  better" (25 Sep), which Stephen confirmed is the same thing, and "the
  question just comes down to timing, what most closely mirrors how claude
  code operates normally?" (26 Sep): Claude Code writes each entry as it
  commits, and the eager store gets it within about 2 ms (proof 3).
- **Resume goes through the session store,** the SDK's supported path: "B is
  what we're going with for various reasons" (26 Sep).
- **Each piece of a reply is its own message** (26 Sep): thinking, text and
  each tool call are published as their own `changes.message` the moment
  Claude Code writes them, with Claude Code's own id. "we should commit as
  things happen". Every piece keeps its own id on tower, so a rewind to any
  piece has an id to name. Which pieces form one reply is carried by
  `turnId`: the spec defines a turn as one round of the loop, which is one
  API response (proof 9 rebuilt replies from it).
- **Claude Code's `role: "system"` messages are published on
  `changes.message` as sent** (26 Sep): "add role to changes.message DONE".
  The schema's role is an open set (conversation.md, Message schemas), and
  it now lists `system` (see [Spec changes owed](#spec-changes-owed)).
- **Where a reminder sits in what the model received is semantic, not
  presentation** (27 Sep): "yes semantic". Publishing Claude Code's entries
  as written "records a conversation that never happened" (Stephen:
  "right"). How the participant produces the form the model received, and
  turns it back into Claude Code's entries on resume, is open (see
  [Open](#open)).
- **Tower carries the typed `attachment` entries Claude Code decides from**
  (type and fields), so a resume from tower is pure (26 Sep): "how is this a
  choice? / why would i accept this?". Proof 14 showed a resume from tower
  byte-identical to one from Claude Code's full record once tower carries
  them. Where they go is open (see [Open](#open)).
- **Turns Claude Code starts itself** (a background task finishing,
  proof 5): the participant mints the query id, as the spec allows for input
  that didn't come through a `say` ("yes it is, how is it not?", 26 Sep).
  The opening notice the model saw is published on `changes` with `from`
  absent, the same as a tool result: "the message didnt originate from the
  user / but the message to the model still comes from the machine, just
  like a tool result" (26 Sep).
- **Additional working directories** (26 Sep): the standard add, the SDK's
  documented `additionalDirectories` (passed as `--add-dir`), set when a
  conversation is served and sent again on every resume, since resume drops
  them (proof 10). Removal is not needed now: "just do the standard add
  then, remove i thought would be simple, its not really anything i need
  right now". Adding to a conversation already running is not part of this.
- **The model isn't conversation state:** "you have to ask yourself if the
  model is intrinsically tied to the conversation, i say its not" (26 Sep).
  Proof 9: Claude Code checks `message.model` only loosely on resume (any
  valid model name keeps thinking), so `load()` needn't read it from
  telemetry.
- **Anything Claude Code loads going onto NATS is fine,** the account email
  in reminders included: "remember that this is the storage of the
  conversation / what happens right now if claude loads a secret? it goes
  onto my disk in the transcript / in this case, it goes onto nats / either
  way, its \"published\" on this machine" (26 Sep).

## Configuration

### The principle

- **No ambient configuration:** "it shouldnt use ~/.claude unless the user
  explicitly allows that" (25 Sep). The participant runs Claude Code with a
  launcher-chosen `CLAUDE_CONFIG_DIR` and `settingSources: []`, which blocks
  settings files and CLAUDE.md on every route tried (harness smoke run,
  proof 11).
- **Config is declared, and a default counts as undeclared config:** "it
  means that config is *declared, explicitly* / default config is the same
  thing" (26 Sep). A default is config that "any update can change … at any
  time for no reason invisibly" (26 Sep).
- **Accepting a default is allowed, per setting, as a decision:** "now i
  might change my mind about something, to make it more usable / for
  example, i might *accept* the default value / but thats a decision"
  (26 Sep). Accepting one is Stephen's decision each time, made explicitly.
- **Declare what changes the outcome; leave what doesn't to Claude Code:**
  "one way or the other, behaviour will not change / ie something like the
  model, effort, thinking / they all affect the outcome / this doesnt"
  (26 Sep).
- **Bridge is the reference** (25 Sep): "use bridge as the reference, for
  where it can make sense / env vars are OKAY for some things, because they
  aren't really things you would change, like subagent depth, config
  directories / anything that can potentially be changed or configured in
  runtime should be stdio". The process starts without configuration and
  refuses to serve until configured.
- **`NATS_URL` has no default,** and the participant won't start without it:
  "having a default that is \"prod\" is what led to the mess that made me
  have the test nats anyway" (25 Sep).

### The login

- Both Stephen's own Claude Code and the participant keep working, with
  settings separate from the login and one login per machine (26 Sep).
- **A private `HOME` for Claude Code's own machinery** (28 Sep, proof 26):
  each participant process makes a fresh private `HOME` in the system temp
  dir, so Claude Code's housekeeping, caches and logs never touch the real
  home ("that looks like a good solution"; "one per *process* is fine";
  "can it be in a tmp directory? then we dont need to worry about
  cleanup"). The login is pointed back at the real `~/.claude` with an
  absolute `CLAUDE_SECURESTORAGE_CONFIG_DIR`, and `CLAUDE_CODE_SHELL_PREFIX`
  gives Bash, hooks and stdio MCP servers the real `HOME`. No cleanup in
  v0: "for v0 we dont need to worry about this". Must work on Linux and
  macOS; Windows "isnt really in scope though, ie its not make/break".
  macOS login: accepted as a known risk for now (28 Sep). Per the code
  (`.claude/tasks/research-macos-keychain.md`), with a private HOME no
  setting shares both the Keychain entry and the refresh lock, and an
  absolute path comes up not logged in. Stephen: "thats acceptable for now
  ... ill test and fix it on my mac, no point trying to fix that here". The
  Mac test is `mvp/claude-code-harness/proofs/macos-keychain.mts` on branch
  `research-macos-keychain`.
- **The shared store:** the agent's own `CLAUDE_CONFIG_DIR` (one per agent,
  reused across its runs, never fresh per run), with the login staying in
  `~/.claude` under one refresh lock: "i think 1" (26 Sep). On 26 Sep that
  was `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`; since the private `HOME`
  (28 Sep, above) it is the absolute path, which is what the code sets. The variable is undocumented,
  and a `/logout` on the isolated side logs Stephen out everywhere. Works on
  Linux (harness smoke run); macOS untested.

### The shape

"having a fallback 'settings' to allow setting anything would allow most of
this right? / we only really need the explicit ones we *require* i think? /
because otherwise we'd be using a resolved value" (26 Sep).

- **Required, named fields:** model, max tokens, thinking type and display,
  effort, system prompt, permission mode.
- **A generic `settings` fallback** for everything else, in Claude Code's own
  settings.json shape, applied as-is (proof 4: `applyFlagSettings` takes
  arbitrary keys, validated only for nesting depth). Per-model values use
  Claude Code's own `modelSettings` (for example
  `{"claude-opus-5-5": {"effortLevel": "high"}}`). Overrides per model or
  family "doesnt need to be v0, but we should consider it to make adding it
  later seamless" (26 Sep).
- **Pinned per conversation:** tools and the system prompt are fixed for a
  conversation's life. "should be "pinned" if possible anyway / in terms
  of, changing these invalidates the entire conversation cache, or rather,
  changes the prefix, so its costly" (26 Sep); proof 4 found both are
  start-only anyway. "whatever they are when the conversation
  starts/resumes/whatever, is fixed, we need no way to update it (without
  killing the process/query/whatever) anyway" (26 Sep). Changing a default
  affects conversations served after it; a running one keeps its values
  until changed itself.

### Each field

- **Model:** required. "i think make it required (for us)" (26 Sep).
- **Max tokens:** required. "lets just make it required" (26 Sep). Passed as
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; the SDK never reports the value actually
  sent, and an undetectable account experiment moved Sonnet 5 from 64k to
  128k (proof 6). Checking a value against a model's cap would need a
  hand-kept table (128k Sonnet 5, Opus 5.5, Fable 5.1; 64k Haiku 4.5;
  proof 6) that can go stale silently, the same failure shape as ambient
  config. Claude Code has no per-model max-tokens setting of its own.
- **Thinking type and display:** required. "our default would/should be
  off, or unset (error) / so we do what bridge does, require it" (26 Sep).
  Bridge's own default, when unset, is off (it omits the API parameter).
  With nothing declared, Claude Code sends display `updates`, which returns
  no summary (proof 1). With `adaptive` and `summarized` declared, Claude
  Code silently substitutes the right shape per model (`enabled` with a
  budget on Haiku 4.5), with no error and no signal if it can't.
- **Effort:** required. "avoid implicit defaults / especially when they
  affect everything ... it should be provided" (26 Sep). An account flag can
  move the default; a declared value outranks it (read from the code).
- **System prompt:** required, and Claude Code's `claude_code` preset (about
  28k chars, the interactive CLI's prompt) is one of the choices: "because
  there is a default/preset, our config should also allow that" (26 Sep).
  None is assumed by omission.
- **System prompt config is two things** (27 Sep): whether the preset
  (Claude Code's full system prompt) is sent, and optional own text, sent
  after the preset or on its own. The shape is
  `{"system": {"preset": true|false, "text": "..."}}`, with `preset`
  required and `text` optional. Stephen: "i think 1 works". Later, if more
  than one preset exists, `preset` can become the preset's name: "we could
  change it to make preset text anyway if there's more than 1 preset". The
  SDK's one-line identity sentence is not part of the config.
- **Permission mode:** required. "mode is a requirement, anything else
  'permissions' is optional" (26 Sep). The mode lives in the same
  `permissions` object as allow and deny rules, so the participant has to
  merge its required mode into whatever `permissions` the fallback carries
  rather than send them independently. The required fields are the
  baseline and the fallback is applied over them, so a fallback that sets
  `permissions.defaultMode` replaces the declared mode: "the required
  settings are required, meaning they must be the baseline / so in that
  case, auto is replaced by plan, why wouldnt it be? else the
  permissions.defaultMode does nothing" (27 Sep). The same holds for any
  required field the fallback also sets. The SDK's typed `permissionMode` accepts `auto`, at start
  and live through `setPermissionMode('auto')` (proof 10).
- **Account connectors off by default** (27 Sep): the participant's
  baseline sets Claude Code's `disableClaudeAiConnectors: true`, and the
  `settings` fallback, applied over the baseline, can turn them back on:
  "i think we disable these by default and allow the settings.json to
  re-enable it". The setting, not the `ENABLE_CLAUDEAI_MCP_SERVERS` env var,
  so a setting can re-enable them. Connectors are the claude.ai ones
  (Claude Docs, Gmail, Google Calendar, Google Drive here), arriving through
  the login (proof 18). This replaces "things that come with my account
  are fine" (25 Sep) for connectors.
- **Allowed to default:** switching model on a flagged request (internal to
  Claude Code, not sent to the API: "i think this is one we can allow claude
  code to default / because its not a standard operation field", 26 Sep), tools and MCP ("there is no need to do anything special with tools/mcp i
  dont think", 26 Sep),
  prompt-cache lifetime (cost only, not behaviour), the advisor tool
  (settable through the fallback as `advisorModel`: "we should allow to
  configure it"), session title (a separate Haiku call that never feeds back
  into the conversation), token-count reminder ("this is just claude code
  behaviour, who cares?"), attribution header, tool-entry details, fast
  mode, temperature, context management, betas, output format (all 26 Sep).

### Bridge's control lines

- **`context`:** works as bridge's does. The participant builds the text into
  the first user message; it arrives verbatim (proof 11).
- **`cwd`:** none. There is no default cwd: every `service` must carry one,
  and without it the participant rejects `invalid`. "what if there is no
  default cwd, i know this almost reverses a prior decision, but if every
  service comes with cwd, its not needed, and without cwd, we just say its
  not serviceable / then there doesnt need to be any implicit cwd (from
  the process) *or* explicit, its a per conversation" (26 Sep).
- **`chdir`:** supported through Claude Code's undocumented `set_cwd`; if a
  version removes it, answered `unsupported`: "we support it, but if it gets
  removed, then you just reply unsupported" (26 Sep). Folder trust: the
  participant always answers `needs_trust` with `trust_accepted: true`:
  "just auto respond with true i think?" (26 Sep). A `chdir` while a query
  runs (`set_cwd` works only when idle): for v0, whatever is easiest ("i
  dont really care / for v0, whatever is easiest", 26 Sep). Rejecting is as
  easy as accepting, since the participant knows a query is running, so it
  is rejected with reason `busy`: "it would be slightly better to reject if
  we know we cannot accept it" (27 Sep). The sender can send it again when
  the query ends.
- **`retry`:** not in v0: "its not needed in v0, until i hit a real issue /
  the bridge retry was for a real issue, because i had to implement it
  myself" (26 Sep). Claude Code's own retry default is accepted until then.
  Known for later (docs, not tested): only `CLAUDE_CODE_MAX_RETRIES`
  (default 10) and `CLAUDE_CODE_RETRY_WATCHDOG` (off: a usage-limit 429
  fails at once since v2.1.239; on: waits out the window) are settable,
  with no delay or total-wait setting. A maximum wait would have to be
  enforced by the participant from `api_retry` messages.
- **`credentials`:** tool credentials, not the Claude login; not needed now:
  "credentials isnt claude credentials, its *tool* credentials, but not
  needed right now" (26 Sep).
- **`tools`:** needed later, to control tool config and which tools are
  enabled; "probably not for v0 though" (26 Sep).
- **`revise`:** not needed: "revise isnt needed" (26 Sep).

## The protocol

- **`service` without a cwd** is rejected `invalid` (agent.md:214: "a
  recognised request whose body doesn't carry what it needs"). This reverses
  the earlier "takes the agent's own default" for this participant (26 Sep).
  Nothing in tower sends `service` today.
- **`service` with a named cwd** that can't be established is rejected
  `invalid_cwd` (agent.md:214).
- **`service` for a conversation that's already served:** the spec's premise
  rules decide it within a world (agent.md:217-226).
- **`service` without an id** is rejected `invalid` (agent.md:214).
- **A `say` while a query runs** is rejected; the flow is cancel, then say
  (conversation.md, Preconditions). "it's by design that queueing isnt supported,
  because i built the nats spec for multiple users" (26 Sep).
- **Cancel** names a query id (conversation.md, Preconditions). What reaches
  `changes` afterwards is whatever Claude Code kept.
- **Where bridge is off the spec, the participant follows the spec,**
  because "the doc wins where code and doc disagree" (CLAUDE.md):
  `instanceId` on change events, `usage` per usage frame, and `detached` on a
  clean exit.

## Shutdown

- **Each Ctrl-C escalates** (24 Sep, confirmed 26 Sep). In Stephen's words:
  first, "if i hit ctrl-c, then it should try to exit *gracefully*, that
  is, stop what its doing, and wait till everything exits / that would
  mean yes, aborting anything in flight";
  second, "still try to shut down, but dont wait"; third, "instant
  termination". What may hold each open: first, "things finishing after the
  abort is called"; second, "open promises, system level reasons"; third,
  "process.exit or whatever, it should exit in almost every circumstance
  unless there's some kernel thing preventing it" (26 Sep).
- **As a concept,** agreed 26 Sep, with "the exact implementation or
  mechanics can change": first = abort, then drain (wait for each Claude
  Code, publish, release, drain NATS); second = tear down (kill Claude Code
  processes, close NATS without draining, stop waiting for acks); third =
  `process.exit`.
- **The first Ctrl-C calls `interrupt()`, then drains** (27 Sep), in place
  of abort. Proof 7: interrupt commits the partial reply and a marker within
  ~50 ms with the store complete. Abort discards the unfinished piece and
  loses up to 9 lines. This follows from "commit as things happen" and the
  partial-reply amendment. Stephen: "do you think losing everything is a
  good idea?"
- **Orphans after a hard kill** (28 Sep): each Claude Code is launched
  through `setpriv --pdeathsig SIGINT` when `setpriv` is available, so a
  SIGKILLed participant's Claude Codes are interrupted within about 2.6 s
  instead of running on unsupervised (proof 21); when it isn't available,
  launched without it, silently: "setpriv is used when available, if not,
  then its not, no point logging it it will be logged every single time".
  Linux only; the SDK's own exit handler already covers normal exits and
  JavaScript crashes.
- **Recovery on every serve, blind** (27 Sep, proof 17): before serving, the participant adds whatever Claude Code's record holds that the store lacks, whatever ended the last run: "they need to prove its resilient". Proven after every press, SIGKILL, crash, a lone Claude Code SIGKILL, abort and a mid-turn reboot. Accepted gap: a reboot after orphans finish loses a resumed conversation's last lines from the SDK's temp copy: "this is likely the edge case im not fussed about".
- **Leftover Claude Codes before serving** (28 Sep, proofs 21 and 25):
  each Claude Code is tagged at spawn (`TOWER_AGENT=<agent>`); before
  serving, the participant finds leftovers of earlier runs by the tag,
  interrupts them, waits for the Claude Codes (not their commands) to exit,
  recovers what they wrote, then serves. One that won't exit is forced
  (SIGTERM, then SIGKILL), following the same escalation as the three
  Ctrl-C levels. Stephen: "my decision is the strategy, the 3 levels of
  exit, not what exactly happens in each ... it should be *obvious*".
- **SIGINT, SIGTERM, SIGHUP and stdin closing all start it** (26 Sep). Bridge
  also exits when stdin closes.
- **Running as a service comes later:** "telling it if it's a service or know
  so it knows how to *interpret* SIGHUP would be something when we look at
  service-fying it" (26 Sep).
- **The participant killed outright** is an edge case, not make or break
  (23 Sep).

## Spec changes owed

In this record's branch, not separate PRs: "i dont want to do these
separately, they can go in this branch" (26 Sep).

- **Done:** `turn.started.maxTokens` optional, with wire and helm accepting a missing value; no conformance
  fixture exercises it yet, and CLAUDE.md says "Fix lands twice: code +
  fixture". agent.md:214 says the agent's own defaults.
- **Done:** `system` named as a `changes.message` role alongside user and
  assistant (26 Sep). The `message` schema lists the roles; the message
  definition and the change table refer to it rather than listing them.
- **Done:** `from` defined by authorship: it says who wrote the message, a
  human, an agent or an orchestrator (29 Sep). A message the harness
  generated (a tool result, a system message, a reminder) has no `from`.
- **Done:** a turn defined as one API round, what was sent to the API and
  what came back, with every message belonging to the one turn it first
  appears in (29 Sep): "a turn is about what goes to the API and what gets
  returned from the API / there is no such thing as a message that isnt part
  of a turn".
- **Done:** a cancelled turn's partial reply is the implementation's declaration, with no recommendation (fixture `v2/scenario-2c.jsonl`, wire test). Earlier: conversation.md (The change stream) said
  a cancelled turn's assistant message never commits; Claude Code keeps it
  and the model sees it (proof 2). "this is a description though, what the
  harness decides to commit is actually up to it, this is a case of me
  overfitting the spec to my harness / so its a temporary amendment or just
  an amendment to the spec in this feature" (26 Sep).
- **Done:** `busy` as a known `chdir` rejection reason beside `unsupported`
  (conversation.md, the `chdir` row under Requests), for a `chdir` while a
  query runs (27 Sep; fixture `agent/scenario-a17.jsonl`, wire test).
- **Owed: the parent belongs to the query, and names a message** (decided
  28 Sep). Today no committed change carries a parent: `message` and
  `query` have none, only `say.precondition.tip` does, so a consumer can't
  tell a sibling from a continuation. Stephen: "the parent id is *implicit*
  / we need to make it *explicit* / tip_moved is for an isolated move, ie
  rewind".
  - **What was decided:** each query carries its parent, the id of the
    message it attaches after. Not a parent on every message: inside a
    query, messages follow in order, as the spec says today. The only query
    change on the wire is its closure, which comes too late to place the
    query's messages as they stream, so the query is announced when it
    starts, carrying `queryId` and `parent`. Putting the parent on the
    query's first message instead was considered and rejected: that is a
    parent on a message, not on the query.
  - **Why not every message** (the road not taken): a parent on every
    message, like Claude Code's `parentUuid`, is only needed for a branch
    inside a query, and nothing observed needs one. Adding it later is an
    extension (every record written with query parents stays valid, and the
    missing per-message parents follow from order); taking it away later is
    not.
  - **The evidence** (branch analysis, 28 Sep: 3,811 transcripts from
    Stephen's CLI sessions and the proof runs; data in
    `/tmp/branch-analysis/`): a single Claude Code never branches inside a
    query in what it sends. Each observed behaviour, and how the query's
    parent expresses it:
    - Esc during thinking, then a new prompt: the cancelled prompt isn't
      committed (the spec's recommendation), so the new query's parent is
      the tip. A harness that did commit it would give two queries with the
      same parent, side by side.
    - `/rewind`, or a resume from an earlier point: the new query's parent
      is the earlier message.
    - Kill, then recovery ("123", then Claude Code's own "No response
      requested."): a straight line in one query; the next prompt opens a
      query whose parent is the synthetic reply.
    - Esc mid-reply: a straight line.
    - A subagent's machine input attaching before its last reply (69 cases,
      cause unresolved): the new query's parent is the message before that
      reply. A parent that names a message can attach anywhere.
    - Parallel tool calls: they look forked in the file (each result hangs
      off its own `tool_use` entry), but the request merges them into one
      message each way, in the order the results were written. Not a
      branch; the committer groups by `message.id` and keeps written order.
    - Two processes writing one session (proof 17b, 8 cases): the only real
      branch inside a query. Stephen: "handled" by the spec, since only one
      instance is attached at a time and on replay the attached one wins,
      "but yes it's a potential issue". Bridge's adopt replays in stream
      order, which is where overlapping writers would be mixed (inferred
      from code, not observed).
  - **Still open:** whether the parent is required (a new conv version) or
    optional (stays conv v2, where an absent parent means "follows the
    tip"), and the exact shape of the query-start change.
- **Owed, if chosen:** a `shutdown` query reason. "i'd rather say its on the
  table, then let the agent who has to implement this \"decide\"" (26 Sep).
  The build brief says so, and the agent reports what it chose and why.

## Frontend work owed

- **Done:** messages with no `from` get a generic "system" label, not "tool",
  in both frontends (27 Sep). Both frontends labelled every message without
  `from` as "tool". Stephen: "we can change this to create *generic* category
  or something to show 'system'". A message with no `from` and no tool result
  gets "system". The label is decided on the message, not its blocks: "it's
  tool result, system reminder is *text* in a tool result / an isolated
  message of *role* system is system / this is what i mean, it's on the
  *message*, not the *content*". The label now lives in `sender_label`
  (`mvp/frontend-leptos/src/concerns/conversation.rs`, called from
  `ui/conversation.rs`) and `senderLabel`
  (`mvp/frontend-svelte/src/lib/core/sender.ts`, called from
  `MessageView.svelte`). `from` says who wrote a message (a human, an agent,
  or an orchestrator); anything the harness generated has none
  (`mvp/docs/tower-ws-spec.md` for the browser, `docs/spec/conversation.md`
  for the wire).

## Open

- **What the invariant means** (28 Sep): conversation correctness, not a byte copy of each request. "*if* you send the *same prompt*, then it should be the same": from tower, the same prompt gives the same request. A query becomes conversation when something non-thinking comes back (a full or partial reply); the prompt and what came back are committed together. A prompt nothing came back for is local state: "thats the very definition of *not* committed, because it's still local"; "whatever is commited is now part of the conversation"; "the transcript is not the same as the conversation, because the conversation is *published* / they are almost the same". Observed live the same day: an Esc during thinking leaves the prompt in the transcript as a dead leaf the next prompt branches around; a kill leaves it, and on restart Claude Code adds its own "No response requested." (model `<synthetic>`) under it. The spec already makes both the implementation's declaration. The third integration attempt (branch `integration-participant-3`) was briefed with R1 restated by Claude as "commit only once the final shape is known", which is not Stephen's; its shape-only failures and its "everything written is on tower" check are measured against that wording, not this one.
- **API response logging** (28 Sep): "we should modify it to log responses then / whether its the full response, or not, i leave to you, we just need a way to enable/disable it when/if i actually start using it". Not through a proxy: "claude code knows theres a proxy and can modify its behaviour / and since its literally just logging, i'd rather not do it in an intrusive way". The route found in the bundle: `ANTHROPIC_LOG=debug` with `--debug-to-stderr` logs every response's status and headers (credentials masked), confirmed on real traffic. Not built. Open: whether the switch defaults on or off.
- **Transient errors** (28 Sep): "i would imagine this is telemetry / its not intrinsic to the conversation". `turn_aborted` says an attempt failed, not what failed (a usage limit, the network, a server error).
- **What tower holds, and when** (the reconcile, `.claude/tasks/reconcile-tower-holding.md`, done): Claude Code's pieces as saved, or the messages as the model received them carrying their pieces, and at what moment each is committed. R1 (commit once known persisted), R2 (exactly what Claude Code builds its next query on), placement is semantic. Proof 24 (`proof-24-next-query.md`) found a rule meeting R1 and R2 on pieces; proofs 16 and 20 built the as-received form. Stephen leaning (28 Sep) to committing a message once its reply is kept: "i 'think' this is okay if its more accurate". This settles the old grain, as-received form and typed-object carrier questions together.
- **The hybrid store, confirmed end to end:** local record first, tower's tip checked before use, tower for a conversation this machine never had, exact against the live next query, alongside the private HOME, the orphan tag and recovery. First run as one thing in the third integration attempt (28 Sep, branch `integration-participant-3`), judged by a check built on the wrong wording (see What the invariant means); a rerun waits on that check.
- **Skills:** the route proven (proofs 22, 26) is the `user` source over the agent's config dir, with the spawn hook linking each declared skill folder into whichever config dir each Claude Code gets, skipping folders that carry `.claude-plugin`, and `reloadSkills()` when the declared set changes; the private HOME keeps the housekeeping it turns on out of the real home. Proposed by Claude, not yet confirmed by Stephen.
- **Later, not v0:** the `tools` line; queueing (v1); showing shells and subagents (v1).

## Evidence

Each proof is on its own branch, not pushed. Most branch off
`claude-code-harness` (commits 9330fdb, 65996d0, 390b3b9, d049330); proof 16
branches off `proof-14-pure-resume`, and proof 17 off `proof-7-stopped`.

| Proof | Question | Branch | Status |
|---|---|---|---|
| 1 | Summarised thinking | `claude-code-harness` (ce55fd8) | done |
| 2 | Transcript entries and messages | `proof-2-entries` | done |
| 3 | Session store as commit signal, shutdown | `proof-3-session-store` | done |
| 4 | What changes on a running Claude Code | `proof-4-live-changes` | done |
| 5 | Subagents and shells | `proof-5-subagents-shells` | done |
| 6 | Max tokens | `proof-6-max-tokens` | done |
| 7 | The participant stopped or killed mid-turn | `proof-7-stopped` | done |
| 8 | Where a resumable conversation can live | `proof-8-resume-store` | done |
| 9 | Resuming from tower's spec | `proof-9-resume-spec` | done |
| 10 | Removing a working directory, permissions | `proof-10-directories-permissions` | done |
| 11 | CLAUDE.md and context | `proof-11-context` | done |
| 12 | Loading skills from a dynamic directory | `proof-12-skills-dir` | done |
| 13 | Resuming after a cwd change, cache | `proof-13-resume-cwd` | done |
| 14 | Whether a resume from tower is pure | `proof-14-pure-resume` | done |
| 15 | Which messages Claude Code writes itself | `proof-15-machine-messages` (37d0176) | done |
| 16 | Publishing as the model received it, and resuming | `proof-16-semantic-form` | running (sent 27 Sep) |
| 17 | Recovering blind, whatever ended the last run | `proof-17-recovery` | running (sent 27 Sep) |
| 18 | Keeping the account's connectors out | `proof-18-connectors` | done |

The harness every proof runs on is isolated: each run gets a config
directory of its own, "isolated" (26 Sep), and credentials may still be read
from `~/.claude`: "login is not config". It sits in the pnpm workspace:
"make it part of the workspace, use pnpm, where it goes im not too
bothered" (26 Sep). On how its launches get past Stephen's auto-mode rule
on changed config directories: "i dont think they need to, if we run into
it, we'll address it" (26 Sep).

## Background

The first attempt (23-25 Sep) ran every proof with Claude Code as one
long-lived `query()` in streaming-input mode, a choice written into a proof
brief and never put to Stephen. Its code was deleted and its findings are
not evidence. Streaming input is now Stephen's decision (26 Sep), for his
own reason: background tasks.

Seven decisions were first recorded as "to confirm": what's published on
`changes` is what the model sees, TypeScript under `mvp/`, pnpm in the
workspace, the `@nats-io` client, Claude Code's own message ids, bridge as
the reference for configuration, and no default `NATS_URL`. Stephen
confirmed them on 26 Sep: "it all looks good to me, whats the "riskiest"
here?" (the riskiest, Claude Code's ids, was answered by proof 2).

Sources are the Claude Code transcripts for this repo: session
`738d957b-abe6-48c1-87d3-94ee92447350` (23-25 Sep 2026) and
`0293e821-f53f-4599-82fc-1429c89bd3a3` (26-27 Sep 2026).
