# About the conversation record

Tower's conversation record has been asked to serve several potential goals
at once, and Claude Code's arrival on the bus showed they don't all fit
together. This document lays out each potential goal: where it came from,
what was discovered about it, and what was worked out. Nothing in it is
decided. What was worked out is marked as Stephen's view, his leaning, a
position recorded in the epic's design record (ideas, not yet concrete), the
document's own reading, or open.

The centre of it is the second goal, resuming from the record. It became a
goal without being chosen: for the first two harnesses it cost nothing, the
spec was written around that, and only Claude Code, the first harness for
which it isn't free, made it a requirement anyone had to meet. Under
inspection it is probably not really a goal of the project.

The potential goals, and in brief what was worked out about each:

1. **One place to see and drive many agents, with different harnesses for
   different jobs.** The backdrop; it explains why there are several
   harnesses at all.
2. **The record as what a harness resumes from.** Treated as a hard
   requirement, it made integrating Claude Code very difficult. Stephen
   doesn't think it is one; it becomes a capability a harness may offer.
3. **The record as exactly what the model was sent.** The messages array
   turned out to depend on the model. His position is "at least what the
   model sees".
4. **Moving conversations between harnesses.** It worked for two harnesses
   built on each other. His view is that it isn't a goal.
5. **An externalised, queryable record.** His leaning is typed content, since
   a generic marking doesn't help a UI present it.
6. **Low friction to participate, against adapting the spec to every
   harness.** One of the considerations in tension, not the goal. Open.

## 1. One place to see and drive many agents

**Where it came from.** Tower is "the central management plane for a fleet of
Claude sessions" (`README.md:3`), making them "visible, addressable, and
eventually orchestrated, over NATS" (`README.md:7`). The Claude Code
participant's purpose is a seam between interface and harness: Claude Code is
the harness, tower the interface, the bus the seam, so Claude Code's features
come without being rebuilt (`docs/participant/purpose.md:5-9`). Its wider aim
is one broker for every machine at home and all sessions in one UI
(`purpose.md:31-33`). Stephen on 29 Sep, in the pre-split design record:

> "it's being able to separate the ui/interface from the harness, but still
> *get* claude code's features / not thta tower's ui is amazing / but it means
> that i can then focus on the presentation rather than the harness tooling"
> (`48cd6c3:docs/design/claude-code-participant.md:29-32`)

**What was worked out (Stephen's view, 7 Oct).** The fleet is many agents:
many sessions or instances across machines and containers. Several harnesses
exist for orchestration, because different jobs suit different models, not
so that one conversation can move between them.

> "fleet is just the term of many agents, ie many sessions or instances across
> machines, containers, what have you / the reason for different harnesses is
> orchestration / you might want gemini to do X, claude opus to do Y, claude
> haiku to do Z" (Stephen, 7 Oct)

## 2. The record as what a harness resumes from

### How it became a goal

For bridge and claude-sdk-cli, resuming from the stream costs nothing. The
record each publishes is the messages array it sends, and so is what it would
resume from. Bridge's adopt is a replay: it reads `conv.v2.{id}.changes.>`
from the capture stream (`replay_conversation`,
`mvp/crates/bridge/src/main.rs:255-286`, about thirty lines) and folds each
message into its list (`fold_one`, `apply_revisions`).

The spec was written with that property true of its harnesses. The
conversation is "the state the agent holds, keys its audit by, and returns to
on resume" (`docs/spec/conversation.md:13-14`); "The stream is the truth;
everything else is intermediate state" (`core.md:85`). Then it built on the
property: `service` is one verb for spawn, resume and takeover, in which the
servicer "reads the conversation's record and reacts" (`agent.md:223`),
adopting when there is history (`agent.md:233`), and "Failover and migration
are the same operation" (`agent.md:129`).

This document's reading is that resuming from the stream was never chosen as
a goal in its own right. The finding behind that reading is an absence, not a
proof: the spec and tower's top-level documents (`docs/spec/`,
`docs/roadmap.md`, `docs/glossary.md`, `docs/design/landscape.md`,
`mvp/docs/tower-v1-design.md`, `README.md`) state it only as the premise
above, and the planning corpus lists "session resume/persistence/transfer"
among things deliberately deferred (`docs/planning/project-state.md:51`,
`:101`). The places that do name resuming from the bus as a goal are the
Claude Code participant's own documents (`docs/participant/purpose.md:31-33`,
`resume.md:11-14`), written while integrating it.

Claude Code is the first harness for which the property isn't free. Its
stored form isn't its sent form: it keeps typed entries (prompts, reply
pieces, tool results, `attachment` entries whose `rendered` blocks are the
reminder text, compaction boundaries, bookkeeping) and composes each request
from them at send time. And its sent form differs by model (section 3), so it
is not even consistent with itself: one conversation is a different messages
array under different models.

Keeping the property meant making Claude Code resume from the stream, and
that is when it hardened into a goal. The epic's design record holds the
position: on 26 Sep, after proof 14 showed that a resume from tower's
messages restores the history but not the context Claude Code adds, and that
carrying the typed `attachment` entries makes the two resumes match, Stephen
questioned why an impure resume would be acceptable: "how is this a choice? /
why would i accept this?"
(`48cd6c3:docs/design/claude-code-participant.md:184-188`). That record was
deleted in 77c2fb9 when it was split into `docs/participant/*.md`; the split
files keep the typed attachments only as something a resume would need
(`docs/participant/resume.md:57-63`). Stephen's view on 7 Oct of this and the
record's other positions is that they are ideas, not concrete:

> "they are just ideas, nothing is concrete yet / think about *why* they were
> said, ie what was the reason, if any. is it stated?" (Stephen, 7 Oct)

### What was discovered

As a hard requirement, it made integrating Claude Code very difficult.

> "resume from stream as a hard requirement made integrating claude code
> incredibly difficult" (Stephen, 7 Oct)

The evidence is what it takes to get from the record back to a resume:

- **Content alone restores the history but not the behaviour.** Proof 14
  resumed from tower's messages; the history replayed identically, but Claude
  Code then re-sent the session context and attribution and re-announced
  environment, model, date and MCP, deciding that from typed `attachment`
  entries tower did not hold. Carrying six attachment types removed the
  difference. The cost of accepting it was inferred, not measured, at about
  1,400 tokens per resume, accumulating. Proof 16 later found two request
  fields still differed, so the match was not byte-identical. The
  comparison was on one seed
  (`docs/participant-findings/proof-14-pure-resume.md:18-30`, `:38`).
- **No resume through the session store can be identical.** The resume
  prototype (branch `proof/resume-from-published`, evidence in
  `mvp/apps/claude-code-participant/proof/out/r4/`) found six of seven shapes
  sent the same request as a local resume once four values were normalised
  away, and the `/compact` shape did not
  (`docs/participant-findings/resume-prototype.md:34-37`; its limits,
  including a system prompt that flipped between two texts, at `:66-68`). The
  four include a temporary config dir the SDK creates with a random name and
  Claude Code renders into the request; no SDK option sets it
  (`resume-prototype.md:57-65`). Getting the six to match took a long list of
  fields beyond what is published, among them `message.id`, `requestId`,
  `message.model` and every non-message entry (`resume-prototype.md:45-49`).
- **Compaction.** After a compaction the model is sent the summary and the
  messages the compaction preserved; Claude Code's list of preserved messages
  can name entries that were never handed to the store
  (`docs/participant/publishing.md:164-167`). This document's reading is that
  a record a resume could rebuild this from needs a marker where the model's
  context restarts and that list.
- **Claude Code's own record does not last forever.** It deletes local
  transcripts after `cleanupPeriodDays`, 30 days by default (Agent SDK
  0.3.285, `sdk.d.ts:6663`), and sweeps them independently of any session
  store (`sdk.d.ts:6455-6456`). The participant sets no value itself; a
  `claudeSettings` control line could set one
  (`docs/participant/configuration.md:39-42`).

The aim of a resume changed along the way. It started as a record lossless
enough to resume the same harness, then became the same behaviour, accepting
that some values differ. Stephen's reason:

> "not just a disply rule, it needs to not be lossy / ie you publish the data
> / and you can *resume* from the data (with the same harness)"; then "that
> one is a bit tougher, since we found out that claude code has a lot of
> temporary filenames that it doesnt expose, but thats because im not parsing
> the transcript file, so it might be impossible to get the same exact data,
> in that some values might be different, but it should be the goal in terms
> of behaviour" (Stephen, 7 Oct)

The epic's later positions moved away from the goal, each with its stated
reason (old record line numbers, then current homes):

- **29 Sep: what is committed follows Claude Code** (lines 214-225; now
  `docs/participant/running.md:41-46`). Which entry kinds reach tower was left
  unsettled, with a preference against tower holding everything Claude Code
  keeps: "i dont want a "here's where to put all your shit" / in that case i'd
  prefer to just drop it when resuming from tower, it can remain *internal*".
  The gap of a host dying with no transcript left was accepted: "this is for
  the 99% of cases". Proof 16 and the reconcile were set aside on this
  position (`docs/participant-findings/proof-16-semantic-form.md:33-34`).
- **29 Sep: resuming from tower on another machine is out of v0** (lines
  52-58, "Resuming from tower **on another machine**" at line 54; now
  `docs/participant/scope.md:51-52`, `running.md:78-84`). A conversation
  resumes from Claude Code's own local record; what is published only has to
  render correctly in tower.
- **1 Oct: Claude Code is the source of state** (lines 226-228; now
  `running.md:92-94`). The participant publishes what Claude Code knows, and a
  say's precondition is checked against the tip in Claude Code's own record.

### What difference it makes

This is the document's reading of what is at stake. With a resume from the
stream, a conversation doesn't depend on one machine: it survives the host
dying, a container being thrown away, or Claude Code's 30-day transcript
cleanup; failover and migration go through `service`; and there is one
source of truth. Without it, for that harness, a conversation lives as long
as the harness's own store on its machine, and the stream is an account of
the conversation rather than the conversation.

### What was worked out

Under inspection, Stephen's view (7 Oct) is that it is probably not really a
goal of the project, and not a hard requirement.

> "probably not really a goal of the project"; "is it a real hard requirement
> or not? / i dont think so" (Stephen, 7 Oct)

Tower's request is `service`, not "resume from the stream". A resume from the
stream becomes optional: a capability a harness may offer, worth having as a
fallback if its own record dies, depending on how often that happens and
whether losing what the stream doesn't carry is acceptable then.

> "tower doesnt say 'resume from stream', it says service"; "being able to
> resume from the conversation if the transcript died could be / but the
> question is, how often would this happen, and if it did, would it be
> acceptable to lose some data?"; "okay so it's purely optional, it shouldn't
> be required, that alleviates a headache" (Stephen, 7 Oct)

**Open.** The spec's wording reads as if a servicer resumes from the record:
the conversation is what the agent "returns to on resume"
(`conversation.md:14`), and the servicer "reads the conversation's record and
reacts" (`agent.md:223`). Whether that is a requirement or a description of
bridge is open. So is how strict "the same" is for a resume a harness offers
(`resume.md:36-39`).

## 3. The record as exactly what the model was sent

**Where it came from.** A turn is "one API round: what was sent to the API
and what came back" (`conversation.md:26`): the record was built to represent
the messages array. That fitted the first two harnesses without the question
being considered.

> "i never really considered that when i designed it, just something that can
> represent the messages array" (Stephen, 7 Oct)

The epic's record carried the same goal. Its rule is that everything the
model sees must be published (`docs/participant/purpose.md:37-39`); that is
the record's rule, not a decision of Stephen's. Its 27 Sep position is that
where a reminder sits is semantic: publishing Claude Code's entries in the
order it writes them, where that differs from where the model received a
reminder, "records a conversation that never happened" (old record, lines
178-183; now `docs/participant/publishing.md:35-40`).

**What was discovered.** What the model was sent depends on the model. On the
unmerged `proof-16-semantic-form` branch,
`mvp/claude-code-harness/proofs/semantic/by-fold.mts` records fold rules read
from Claude Code 2.1.282. Eleven attachment types fold into the user message
whatever the model (R4, line 17). On Sonnet 5, Opus 5.5 and Fable 5.1 the
other reminders go to a buffer that becomes one `system` message after the
user message, at most one per request (R7, R8, lines 20-21); Haiku 4.5 takes
no `system` messages, so they fold into the user message or the last tool
result (R10, R13, R15, lines 23-27). Of the models that take a `system`
message, only Sonnet 5 keeps each `<system-reminder>` wrapper (R14, line 26).
The per-model table (lines 57-61) comes from observed runs. Task notices are
also wrapped in a frame at send time that no stored entry holds; that and the
rest of the request-building notes were read from 2.1.285
(`docs/participant-findings/what-the-model-sees.md`, "The model sees", "How
the request is built"). So one Claude Code conversation is several different
messages arrays, depending on the model, and none of them is what Claude Code
stores.

The spec already leaves this to the harness: "The request is a *rendering* of
the reachable state": what the builder ships, and any transformation at
presentation time, is between the agent and its model
(`conversation.md:655-657`), listed among implementation details that are
deliberately not contract.

**What was worked out (Stephen's position, 7 Oct).** Said while discussing
what the conversation is: it holds at least what the model sees.

> "if the conversation is what's send to the model, then it has to contain
> what the model sees at least" (Stephen, 7 Oct)

And tower itself doesn't need to follow each harness's rules about what its
model sees; it only needs to know whether to show something to the person.

> "tower doesn't need to follow the harnesses rules, it just needs to know
> whether it shows it to the user or not" (Stephen, 7 Oct)

## 4. Moving conversations between harnesses

**Where it came from.** Bridge can adopt a conversation claude-sdk-cli
started, tools aside, by the replay described in section 2. That made moving
conversations between harnesses look within reach.

**What was discovered.** It worked because the two were built on each other:
the record each keeps is the messages array it sends. It isn't why there are
several harnesses; that is orchestration (section 1). Claude Code behaves
very differently. A neighbouring question is already left open in tower's
design documents, not the spec: `docs/design/landscape.md:504-512` notes that
because content blocks are the model's own, "a conversation recorded through
one adapter may not be resumable through another", and leaves whether that
is true, and whether it should be, open. That paragraph is about model
adapters, not harnesses.

**What was worked out (Stephen's view, 7 Oct).** Moving conversations between
harnesses isn't a goal. Supporting it for Claude Code isn't required, but he
thinks it should work, for a first-class Claude Code experience.

> "my cli (claude-sdk-cli) and headless harness (bridge) worked, because they
> were both based on each other / so other than tools, you can adopt a
> conversation in bridge from the cli / so thats why it was 'on the menu' /
> claude code behaves very differently / we dont *have* to support it / but
> to have the first class claude code experience, i think it should work"
> (Stephen, 7 Oct)

## 5. An externalised, queryable record

**Where it came from.** If a harness keeps its own store as working state,
the published record can become presentation and an externalised account of
what happened. One reason to keep that account is that it can feed a
database or an index and become queryable.

> "if its purpose changes, in that its presentation, and the harness can use
> its internal storage, then thats probably fine / note that one reason is to
> externalise what goes on, so it can feed into a DB or index storage, for
> example, ie it becomes queryable" (Stephen, 7 Oct)

**What was discovered.** Plain chat is not the hard part; the "extras" are.
The epic catalogued 21 kinds of message beyond plain chat (reminders,
hand-backs, task notices, interrupt markers, compaction, turn-finished
lines, API errors, alerts) and two designs for them
(`docs/participant-findings/extras-design.md`; `publishing.md:121-136`),
prototyped as `proto/extras-generic` and `proto/extras-typed`, then
`proto/extras-generic-2` and `proto/extras-typed-2` (with Leptos ports built
on `-leptos` twins and merged back).

- **generic-2** marks only who sees a message: `audience` (`{model, user}`),
  `userContent`, `at` and `scope` on `changes.message`
  (`proto/extras-generic-2:docs/spec/conversation.md`, "Who a message is
  for").
- **typed-2** is generic-2's envelope plus `kind` and `fields`, with declared
  kinds and reminders named after Claude Code's attachment types
  (`proto/extras-typed-2:docs/spec/conversation.md`, "Extra messages";
  `mvp/apps/claude-code-participant/src/ConversationKinds.ts`,
  `classifyAttachment`).

This document's reading of the prototype code, set against Stephen's
positions here, is that neither matches them. typed-2 states a type twice,
`kind` and an `audience` the kind implies, as its own TODO notes
(`ConversationKinds.ts:26`); its reminder kinds are one harness's internals;
both keep person-only entries inside `changes.message`; typed-2 publishes a
compaction boundary as a bare `system` message that reads as model-visible
(`classifySystem`), where generic-2 marks it person-only; both drop `isMeta`
user entries the model does see (typed-2 `classifyUser`; generic-2
`ConversationEntries.ts:239-241`), and neither has a case for `!` bash
entries or local-command output, which the model also sees
(`what-the-model-sees.md`, "The model sees"). Nothing records Stephen's
reaction to either prototype.

**What was worked out (Stephen's leaning, 7 Oct).** Typed, not generic. A
generic marking says only who sees something, which tells a UI whether to
draw it but not how; a typed one says what the thing is, which a UI needs to
present it. No typed design is specified; typed-2 is one attempt.

> "it comes down to generic or typed, and i think it has to be typed / generic
> would be 'user/model visible', etc / while typed would be semantic / ie
> generic doesnt help tower (or any other UI) present it" (Stephen, 7 Oct)

Further leanings and ideas from the same day:

- **Person-only entries on their own subject.** Entries the person sees but
  the model doesn't (a turn-finished line, an alert) would live on their own
  subject under `changes.`, its name open, ordered by the harness's own
  timestamps, which he judges far easier than resuming from the stream.
  Claude Code stamps each entry with its own time; the record of that also
  notes that the pieces of one API message spread a median 2.2 s (max 234 s)
  and can be out of file order (`what-the-model-sees.md:71-73`). Equal
  timestamps he judges not worth handling yet. The Agent Client Protocol's
  `notice`, at Preview, has the same shape: "visible to the user without
  becoming conversation history" (agentclientprotocol/agent-client-protocol
  2797d33, `docs/rfds/session-notices.mdx:11-13`).

  > "it does mean that it needs to live on a stream/subject, but i dont think
  > its nearly as bad as the resume from stream"; "it would be
  > changes.<something>"; "notifications or alerts or something, i dont know
  > yet"; "claude code already has its own timestamps / the edge case right
  > now isnt worth worrying about" (Stephen, 7 Oct)

- **Native harness data on its own subject or event** (an idea, not a
  decision). A harness's native data, for Claude Code its typed entries,
  could go on a subject or event of its own rather than in the conversation's
  messages.

  > "it could be a separate subject or event, like a custom event" (Stephen,
  > 7 Oct)

- **The spec changes where it has a gap.** A missing parent link is something
  to add; the spec itself says per-message parents would be an extension that
  leaves every existing record valid (`conversation.md:57-61`). On how the
  record would mark where compaction restarts the model's context, he
  suggested, as a question, a null parent.

  > "stop thinking the spec is frozen, its not"; "you'd probably have null
  > parent to indicate?" (Stephen, 7 Oct)

## 6. Low friction to participate, against adapting the spec

**Where it came from.** The spec already keeps the bar to taking part low.
Producers may only add, and consumers skip what they don't know
(`nats.md:122-129`), so a harness can carry more than the spec names. An
unsupported operation is answered `rejected: unsupported`, because
"compliance is answering, not implementing" (`conformance.md:66-67`,
`conversation.md:773`). `from` is provenance: a harness-generated message has
none (`conversation.md:187`), and a servicer "echoes what the sender sent and
never authors it" (`conversation.md:450-456`). Stephen put the tension as a
question:

> "basically, does the spec try to adapt and support everything? / or does it
> try to make participating as easy/frictionless as possible?" (Stephen,
> 7 Oct)

**What was discovered.** Other harnesses store non-plain content in widely
different ways, and most keep a model-facing form apart from a UI-facing
one. Sources were read on 8 Oct 2026 at the commit named.

| Pattern | Harness | Where it shows |
|---|---|---|
| Tags inside the message text | Claude Code | `<system-reminder>` in the model's text (anthropics/claude-code `CHANGELOG.md`, e.g. background task notifications "sent to the model inside `<system-reminder>` tags") |
| | Roo Code | `<environment_details>` appended to the user message (RooCodeInc/Roo-Code b867ec9, `src/core/environment/getEnvironmentDetails.ts:265`, `src/core/task/Task.ts:2587`) |
| | Cline | `<task>` and `<environment_details>` up to v3.89.2 (`apps/vscode/src/core/task/index.ts:1081`, `:3765`); at faf05ef it wraps input as `<user_input mode=…>` (`sdk/packages/shared/src/prompt/format.ts:9`) |
| A kind or flag beside the text | Codex | `content_item_kinds` on a message, each "a stable `<feature>.<name>` classification" (openai/codex 529cd6b, `codex-rs/context-fragments/src/fragment.rs:47`, `:67`) |
| | OpenCode (v1 schema) | `synthetic` on a text part (anomalyco/opencode a697115, `packages/schema/src/v1/session.ts:106`) |
| | Cline | `metadata.kind`, e.g. `compaction`, `completion_reminder` (faf05ef, `sdk/packages/core/src/session/user-run-messages.ts:17`, `:138`) |
| A distinct stored type | OpenCode's newer session-message schema | `Shell`, `Synthetic` and `Compaction` message types (`packages/schema/src/session-message.ts:53-71`, `:191-212`); the v1 schema already had a compaction part |
| | Zed | `Message::Compaction(CompactionInfo)` (zed-industries/zed cb73ee1, `crates/agent/src/thread.rs:204-209`) |
| | Codex | `RolloutItem::Compacted`, carrying a `replacement_history` (`codex-rs/history/src/lib.rs:212-228`, `:287`) |

Separate model-facing and UI-facing forms: Cline and Roo keep
`api_conversation_history.json` beside `ui_messages.json` (Cline
`apps/vscode/src/core/storage/disk.ts:18-20`; Roo
`src/shared/globalFileNames.ts:2-3`); a Codex rollout holds both the response
items and the event messages in one file (`RolloutItem`, above); Gemini CLI
records `displayContent` beside `content` when the two differ
(google-gemini/gemini-cli 44d764e,
`packages/core/src/services/chatRecordingTypes.ts:43-48`,
`packages/core/src/core/geminiChat.ts:555-566`); and ACP's `notice` stays out
of history (section 5).

The rest of this section is the document's reading, not something measured
or something Stephen said. The difficulty of joining depends on how far a
harness's own record is from what its model saw:

- **Its record is the messages array** (bridge, claude-sdk-cli). Easy: the
  record is the request.
- **Model text plus flags beside it** (Codex, Cline, OpenCode's v1 schema).
  Small to moderate: the text is there; compaction is the main thing to
  carry.
- **Composed at send time from typed entries** (Claude Code, OpenCode's newer
  schema, Zed). Moderate for a fallback resume, large for a faithful one,
  because the composition has to be undone and, for Claude Code at least,
  differs by model.

Three levels of taking part fall out of that: **presentation** (publish what
the model saw), **resumable** (also enough for a fallback resume, with some
loss) and **faithful** (also the harness's native data). Under add-only and
"compliance is answering", the higher two can be optional. On this reading,
making resume from the stream optional (section 2) lowers the friction of
taking part, since a harness that only presents what its model saw still
conforms; and a typed vocabulary (section 5) is where the pressure to adapt
to everything comes back, because each declared kind is one more thing every
harness's content has to map onto, and typed-2 already reached for one
harness's internal names.

Put together, the potential goals ask four things of one record (this
document's framing, not Stephen's list):

1. **Harness-neutral:** any harness can write it and any presenter read it.
2. **Exactly what each model saw:** the original design aim. Stephen's 7 Oct
   position is narrower: at least what the model sees (section 3).
3. **Cheap to join.**
4. **A lossless resume source.**

For bridge and claude-sdk-cli all four hold, because their stored and sent
forms are the same. For Claude Code, recording what the model saw means a
per-model rendering, which is not what Claude Code resumes from; recording
what it resumes from means its typed entries, which are neither neutral nor
what the model saw; and a neutral vocabulary rich enough to resume every such
harness losslessly grows with every harness's internals, which is the
opposite of cheap to join. Each position gives up one of the four.

**Open.** Low friction is one of the considerations in tension, not the goal,
and how it weighs against the others is open.

> "of course its open / the point is to evaluate the things that are
> contending or cause tension … thats *one* thing, it doesnt mean frinctionless
> participation is the *goal*" (Stephen, 7 Oct)

## What remains open

- Whether the spec's wording on resume and `service` describes a requirement
  or bridge (section 2).
- How strict "the same" is for a resume a harness offers (section 2).
- The typed design itself; nothing is specified (section 5).
- The name of the person-only subject, and whether native harness data gets
  a subject or event of its own (section 5).
- How compaction's restart is marked, for example by the null parent he
  asked about (section 5).
- How low friction to participate weighs against adapting the spec to every
  harness (section 6).
- Whether any of the epic's recorded positions becomes concrete (sections 2
  and 3).

It needs more thought and discussion before any of it narrows.
