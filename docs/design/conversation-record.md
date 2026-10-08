# About the conversation record

What tower's conversation record is for, and why that question got harder once
Claude Code joined the bus. This document explains the ground: what the spec
says today, what the Claude Code participant epic worked out, why no single
answer satisfies everything that was wanted, and where Stephen leans. It
decides nothing, and nothing in it is decided yet: the epic's recorded
positions are ideas, each given here with its stated reason; Stephen's
leanings and open questions are marked as such.

## What the record was built to be

The spec's premise is that the conversation is the agent's state. It is "the
state the agent holds, keys its audit by, and returns to on resume"
(`docs/spec/conversation.md:13-14`), and a turn is "one API round: what was
sent to the API and what came back" (`conversation.md:26`). Read together,
these describe a record shaped like the messages array a harness sends to the
model, kept durably on the bus, from which any servicer can pick the
conversation up again. Core states the same thing as a system principle: "The
stream is the truth; everything else is intermediate state" (`core.md:85`).

That shape fitted the first two harnesses without the question being
considered. Stephen built the record to represent the messages array;
whether that array is a stable thing to record was never asked at the time:

> "i never really considered that when i designed it, just something that can
> represent the messages array" (Stephen, 7 Oct)

For claude-sdk-cli and bridge, the assumption holds, because the two were
built on each other: the record each keeps is the messages array it sends.
That is why bridge can adopt a conversation the CLI started, tools aside, and
why adopting looks cheap. Bridge's adopt is a replay: it reads
`conv.v2.{id}.changes.>` from the capture stream and folds each message into
its list (`replay_conversation`, `mvp/crates/bridge/src/main.rs:255-288`, about
thirty-five lines). Nothing has to be translated, because nothing was
transformed on the way in.

> "my cli (claude-sdk-cli) and headless harness (bridge) worked, because they
> were both based on each other / so other than tools, you can adopt a
> conversation in bridge from the cli / so thats why it was 'on the menu'"
> (Stephen, 7 Oct)

Cross-harness adoption was never the reason for having several harnesses. The
fleet is many agents, many sessions or instances across machines and
containers, and several harnesses exist because different jobs suit
different models, not because one conversation is expected to move between
them. Adoption seemed within reach because the two harnesses were built on
each other. Claude Code behaves very differently. Supporting adoption of a
conversation from the record for Claude Code isn't required, but Stephen
thinks it should work, for a first-class Claude Code experience.

> "fleet is just the term of many agents, ie many sessions or instances across
> machines, containers, what have you / the reason for different harnesses is
> orchestration / you might want gemini to do X, claude opus to do Y, claude
> haiku to do Z"; "claude code behaves very differently / we dont *have* to
> support it / but to have the first class claude code experience, i think it
> should work" (Stephen, 7 Oct)

## What the spec defines, and what it leaves open

Several rules bear on the record's content without settling it.

- **What reaches the model is the harness's business.** "The request is a
  *rendering* of the reachable state": what the builder ships, and any
  transformation at presentation time, is between the agent and its model
  (`conversation.md:655-657`). The spec lists this among implementation
  details that are deliberately not contract.
- **`from` is provenance, never invented.** A message the harness generated (a
  tool result, a system message, a reminder) has no `from`
  (`conversation.md:187`); a servicer "echoes what the sender sent and never
  authors it" (`conversation.md:450-456`).
- **Tolerance and add-only.** Producers may only add types, optional fields
  and enum values; consumers skip what they don't know (`nats.md:122-129`).
  This is what lets a harness carry more than the spec names without breaking
  anyone.
- **Compliance is answering, not implementing.** An unsupported operation is
  answered `rejected: unsupported` (`conformance.md:66-67`,
  `conversation.md:773`). A harness need not do everything the spec can
  express, only reply honestly.
- **`service` is one verb for spawn, resume and takeover.** The servicer
  "reads the conversation's record and reacts" (`agent.md:223`); with no
  standing attachment it spawns fresh if there is no history and adopts if
  there is (`agent.md:233`). "Failover and migration are the same operation"
  (`agent.md:129`).
- **Moving between adapters is deliberately undecided.** `landscape.md:504-512`
  notes that because content blocks are the model's own, "a conversation
  recorded through one adapter may not be resumable through another", and
  leaves whether that is true, and whether it should be, open. That paragraph
  is about model adapters (providers), not harnesses; it is a neighbouring
  question, not this one, but it shows the spec already declined to promise
  portability.

Two of these pull against each other once the harness is not bridge. The
premise and `service` both describe the record as what a servicer resumes
from. The rendering rule says what the model actually receives is the
harness's own affair. For bridge the two coincide. For a harness that builds
its request from something other than the record, they come apart, and the
rest of this document is about that gap.

## What the epic worked out, and how its reasons moved

The Claude Code participant's positions between 26 Sep and 1 Oct are recorded
in the pre-split design record (`48cd6c3:docs/design/claude-code-participant.md`,
deleted in 77c2fb9 when it was split into `docs/participant/*.md`; the split
files restate them without the dated quotations). The record words them as
decisions, but none is concrete yet. Stephen's view of them on 7 Oct is that
they are ideas, and what matters is the reason each was given, if one was:

> "they are just ideas, nothing is concrete yet / think about *why* they were
> said, ie what was the reason, if any. is it stated?" (Stephen, 7 Oct)

Read in order, the stated reasons shift from treating the record as the
resume source to treating Claude Code's own record as the state.

- **26 Sep: tower carries the typed attachment entries.** Proof 14 had shown a
  resume from tower restores the history but not the context Claude Code adds;
  carrying the typed `attachment` entries Claude Code decides from made the two
  resumes match. Stephen refused to treat the impure resume as an acceptable
  option: "how is this a choice? / why would i accept this?" (old record,
  lines 184-188). The current split keeps the typed attachments only as
  something a resume would need (`docs/participant/resume.md:57-63`), not as a
  position.
- **27 Sep: where a reminder sits is semantic.** Publishing Claude Code's
  entries in the order it writes them, where that differs from where the model
  received a reminder, "records a conversation that never happened" (old
  record, lines 178-183; now `docs/participant/publishing.md:35-40`). This
  still assumes the record should be what the model saw, exactly.
- **29 Sep: what is committed follows Claude Code.** Whatever Claude Code keeps
  in its record is committed, as it keeps it (old record, lines 214-225; now
  `docs/participant/running.md:41-46`). Which entry kinds reach tower was left
  unsettled, with a preference against tower becoming a store for everything
  Claude Code holds: "i dont want a "here's where to put all your shit" / in
  that case i'd prefer to just drop it when resuming from tower, it can remain
  *internal*". The known gap, a host dying with no transcript left, was
  accepted: "this is for the 99% of cases". Proof 16 and the reconcile were set
  aside on this position (`docs/participant-findings/proof-16-semantic-form.md:33-34`).
- **29 Sep: resuming from tower is out of v0.** A conversation resumes from
  Claude Code's own local record; what is published only has to render
  correctly in tower (old record, lines 52-58; now
  `docs/participant/scope.md:51-52`, `running.md:78-84`).
- **1 Oct: Claude Code is the source of state.** The participant publishes
  what Claude Code knows, and a say's precondition is checked against the tip
  in Claude Code's own record (old record, lines 226-228; now
  `running.md:92-94`).

The early positions only make sense if the published record is what a resume
reads. The later ones only make sense if Claude Code keeps its own record and
the published one is an account of it. The epic's documents still carry both:
the record's own publish rule says everything the model sees must be published, partly so a
resume from the bus stays possible (`docs/participant/purpose.md:37-65`), while
`resume.md:11-14` keeps "the same conversation" as the goal and adds that it
"may have to be relaxed to achieve something workable".

## Why it is not easy

Claude Code does not keep a messages array. It keeps typed entries (prompts,
reply pieces, tool results, `attachment` entries whose `rendered` blocks are
the reminder text, compaction boundaries, bookkeeping) and composes each
request from them at send time
(`docs/participant-findings/what-the-model-sees.md`, "How the request is
built"). What the composition produces depends on the model. On the
`proof-16-semantic-form` branch, `mvp/claude-code-harness/proofs/semantic/by-fold.mts`
records the fold rules read from Claude Code 2.1.282: Sonnet 5, Opus 5.5 and
Fable 5.1 take reminders as separate `system` messages, while Haiku 4.5 does
not and gets them folded into the user message or the last tool result (rules
R10, R13, R15, lines 23-27); among the models that take `system` messages,
only Sonnet 5 keeps the `<system-reminder>` wrapper (R14, line 26; the
per-model table at lines 57-61). Task notices are wrapped in a frame at send
time that no stored entry holds (`what-the-model-sees.md`, "The model sees").

So the same Claude Code conversation is several different messages arrays,
depending on which model it was sent to, and none of them is what Claude Code
stores. That breaks the assumption the record was built on, and Stephen's
position follows from it: whatever else the record is, if it claims to be what
was sent to the model, it has to hold at least what the model saw.

> "if the conversation is what's send to the model, then it has to contain
> what the model sees at least" (Stephen, 7 Oct)

The proofs show how far the gap goes in the other direction, from the record
back to a resume:

- **Content alone restores the history but not the behaviour.** Proof 14
  resumed from tower's messages and the history replayed identically, but
  Claude Code then re-announced its session context, environment, model, date
  and MCP instructions, because it decides that from the typed attachment
  entries tower did not hold. Carrying six attachment types removed the
  difference. The cost of accepting it was inferred, not measured, at about
  1,400 tokens per resume, accumulating
  (`docs/participant-findings/proof-14-pure-resume.md:18-30`). Proof 16 later
  found two request fields still differed, so the match was not
  byte-identical (`proof-14-pure-resume.md:26-28`).
- **No resume through the session store can be identical.** The resume
  prototype (branch `proof/resume-from-published`, evidence in
  `mvp/apps/claude-code-participant/proof/out/r4/`) found six of seven shapes
  sent the same request as a local resume once four values were normalised
  away, and the `/compact` shape did not
  (`docs/participant-findings/resume-prototype.md:34-37`; its limits, including
  a system prompt that flipped between two texts, at `:66-68`). The four
  include a temporary config dir the SDK creates with a random name and
  Claude Code renders into the request; no SDK option sets it
  (`resume-prototype.md:57-65`). Getting
  the six to match took a long list of fields beyond what is published, among
  them `message.id`, `requestId`, `message.model` and every non-message entry
  (`resume-prototype.md:45-49`).
- **Compaction needs more than a summary.** After a compaction the model is
  sent the summary and the messages the compaction preserved, not what came
  before. A record that lets a reader or a resume reconstruct that needs a
  marker where the model's context restarts and the list of preserved
  messages; Claude Code's list can name entries that were never handed to the
  store (`docs/participant/publishing.md:164-167`).
- **Claude Code's own record does not last forever.** It deletes local
  transcripts after `cleanupPeriodDays`, 30 days by default (Agent SDK 0.3.285,
  `sdk.d.ts:6661`), and sweeps them independently of any session store
  (`sdk.d.ts:6455-6456`). The participant sets no value, so the default
  applies. This is the case where a resume from the bus would matter.

This is why the aim changed shape. The first aim was a record lossless enough
to resume the same harness. Once exact data was shown to be out of reach (the
temp dir alone guarantees that), the aim became the same behaviour, with some
values, such as Claude Code's unexposed temp paths, allowed to differ.

> "not just a disply rule, it needs to not be lossy … you can *resume* from
> the data (with the same harness)"; "it might be impossible to get the same
> exact data … but it should be the goal in terms of behaviour" (Stephen,
> 7 Oct)

## Why resuming from the stream became optional

The spec never asks a harness to resume from the stream. Tower sends
`service`, and the premise for `service` says what to do (adopt, take over,
spawn) without saying where the servicer's state comes from
(`agent.md:223-236`). A harness that resumes from its own store and publishes
faithfully is answering `service` correctly. Seen this way, a resume from the
bus is a fallback a harness may offer, worth having if its own record dies,
and its value depends on how often that happens and whether losing what the
bus doesn't carry is acceptable then.

> "being able to resume from the conversation if the transcript died could be
> / but the question is, how often would this happen, and if it did, would it
> be acceptable to lose some data?"; "tower doesnt say 'resume from stream', it
> says service"; "okay so it's purely optional, it shouldn't be required, that
> alleviates a headache" (Stephen, 7 Oct)

There is still a tension with the spec's own words: the premise says the
conversation is what the agent "returns to on resume" (`conversation.md:14`)
and `service` says the servicer "reads the conversation's record"
(`agent.md:223`). Whether those sentences describe a requirement or bridge's
way of doing it is not written down anywhere.

If resume is optional, the record can change purpose: the harness keeps its
own store as working state, and the published record becomes presentation and
an externalised account of what happened. That still earns its keep, because
an external record can feed a database or an index and make conversations
queryable across the fleet.

> "if its purpose changes, in that its presentation, and the harness can use
> its internal storage, then thats probably fine / note that one reason is to
> externalise what goes on, so it can feed into a DB or index storage, for
> example, ie it becomes queryable" (Stephen, 7 Oct)

Where a harness's native data (for Claude Code, its typed entries) would go
is a separate question. One idea Stephen raised, not a decision, is that it
could go on a subject or event of its own rather than in the conversation's
messages.

> "it could be a separate subject or event, like a custom event" (Stephen,
> 7 Oct)

## What other harnesses do

Tower is not alone in having this problem, and the other harnesses show it
has no settled answer. No two of them store non-plain content (reminders,
environment notes, compaction) the same way. They fall into three patterns,
and most keep a model-facing form apart from a UI-facing one. Sources were
read on 8 Oct 2026 at the commit named.

| Pattern | Harness | Where it shows |
|---|---|---|
| Tags inside the message text | Claude Code | `<system-reminder>` in the model's text (anthropics/claude-code `CHANGELOG.md`, e.g. background task notifications "sent to the model inside `<system-reminder>` tags") |
| | Roo Code | `<environment_details>` appended to the user message (RooCodeInc/Roo-Code b867ec9, `src/core/environment/getEnvironmentDetails.ts:265`, `src/core/task/Task.ts:2587`) |
| | Cline | `<task>` and `<environment_details>` up to v3.89.2 (`apps/vscode/src/core/task/index.ts:1081`, `:3765`); at faf05ef it wraps input as `<user_input mode=…>` (`sdk/packages/shared/src/prompt/format.ts:9`) |
| A kind or flag beside the text | Codex | `content_item_kinds` on a message, each "a stable `<feature>.<name>` classification" (openai/codex 529cd6b, `codex-rs/context-fragments/src/fragment.rs:47`, `:67`) |
| | OpenCode v1 | `synthetic` on a text part (anomalyco/opencode a697115, `packages/schema/src/v1/session.ts:106`) |
| | Cline | `metadata.kind`, e.g. `compaction`, `completion_reminder` (faf05ef, `sdk/packages/core/src/session/user-run-messages.ts:17`, `:138`) |
| A distinct stored type | OpenCode v2 | `Shell`, `Synthetic` and `Compaction` message types (`packages/schema/src/session-message.ts:53-71`, `:191-212`); v1 already had a compaction part |
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
`packages/core/src/core/geminiChat.ts:555-566`); and the Agent Client
Protocol's `notice`, at Preview, is "visible to the user without becoming
conversation history" (agentclientprotocol/agent-client-protocol 2797d33,
`docs/rfds/session-notices.mdx:11-13`). That last one is the same shape as
Stephen's person-only subject below.

What this says about difficulty is a matter of distance: how far a harness's
own record is from what its model saw. The grading below is this document's
reading of the table, not something measured.

- **Its record is the messages array** (bridge, claude-sdk-cli). Easy: the
  record is the request, and bridge's adopt is the replay shown above.
- **Model text plus flags beside it** (Codex, Cline, OpenCode v1). Small to
  moderate: the model's text is already there; compaction is the main thing
  to carry.
- **Composed at send time from typed entries** (Claude Code, OpenCode v2,
  Zed). Moderate for a fallback resume, large for a faithful one, because the
  composition has to be undone and, for Claude Code at least, it differs by
  model.

Three levels of taking part fall out of that. **Presentation:** publish what
the model saw, which is all the spec needs to require. **Resumable:** also
enough to resume as a fallback, with some loss. **Faithful:** also the
harness's native data, so a resume behaves as if nothing happened. Under the
existing rules (add-only, compliance is answering) the higher two can be
optional, so participation stays cheap. That is an inference from the spec,
not something it states.

## The two extras prototypes

The epic catalogued 21 kinds of "extra" message beyond plain chat (reminders,
hand-backs, task notices, interrupt markers, compaction, turn-finished lines,
API errors, alerts) and two designs for carrying them
(`docs/participant-findings/extras-design.md`; `publishing.md:121-136`). Each
was prototyped twice: `proto/extras-generic` and `proto/extras-typed`, then
`proto/extras-generic-2` and `proto/extras-typed-2`, whose Leptos ports were
built on `-leptos` twins and merged back.

- **generic-2** marks only who sees a message. It adds `audience`
  (`{model, user}`), `userContent` (different words for the person), `at` (the
  harness's own time) and `scope` (from here on, the model is no longer sent
  what came before, except the listed ids) to `changes.message`
  (`proto/extras-generic-2:docs/spec/conversation.md`, "Who a message is
  for").
- **typed-2** is generic-2's envelope plus `kind` and `fields`, with a table of
  declared kinds, and reminders named after Claude Code's attachment types
  (`proto/extras-typed-2:docs/spec/conversation.md`, "Extra messages";
  `mvp/apps/claude-code-participant/src/ConversationKinds.ts`,
  `classifyAttachment`).

Measured against the positions in the next section, neither fits:

- typed-2 states a message's type twice, as `kind` and as an `audience` the
  kind already implies; its own TODO says so, against the rule that a type is
  stated once (`ConversationKinds.ts:26`).
- typed-2's reminder kinds are Claude Code's attachment names, so part of its
  vocabulary is one harness's internals.
- Both keep user-only entries (the turn-finished line, API errors) inside the
  conversation, as `changes.message`.
- In typed-2 a compaction boundary is published as a bare `system` message
  with no `audience`, which reads as model-visible (`classifySystem`);
  generic-2 marks it shown to the person only.
- Both drop `isMeta` user entries, which the model does see (typed-2
  `ConversationKinds.ts`, `classifyUser`; generic-2
  `ConversationEntries.ts:239-241`), and neither has a case for `!` bash
  entries or local-command output, both of which the model sees
  (`what-the-model-sees.md`, "The model sees").

Nothing records Stephen's reaction to either prototype.

## Generic or typed

Stephen's leaning is typed, not generic. A generic marking says only who sees
something; that tells a UI whether to draw it, not how. A typed one says what
the thing is (a compaction, a task finishing, a turn's duration), and that is
what any presenter needs in order to present it. No typed design is specified.
typed-2 is one attempt at the idea, and the problems above are where it
doesn't match his leaning.

> "it comes down to generic or typed, and i think it has to be typed / generic
> would be 'user/model visible', etc / while typed would be semantic / ie
> generic doesnt help tower (or any other UI) present it" (Stephen, 7 Oct)

Two further positions narrow what tower itself has to know. Tower does not
need to follow each harness's rules about what its model sees; it only needs
to know whether to show something to the person.

> "tower doesn't need to follow the harnesses rules, it just needs to know
> whether it shows it to the user or not" (Stephen, 7 Oct)

And entries the person sees but the model doesn't (a turn-finished line, an
alert) would live on their own subject, ordered by the harness's own
timestamps, which he judges far easier than resuming from the stream. The
subject sits under `changes.`; its name is open. Claude Code already stamps
each entry with its own time (`what-the-model-sees.md`, "Time"); equal
timestamps are an edge case not worth handling yet.

> "it does mean that it needs to live on a stream/subject, but i dont think
> its nearly as bad as the resume from stream"; "notifications or alerts or
> something, i dont know yet"; "claude code already has its own timestamps /
> the edge case right now isnt worth worrying about" (Stephen, 7 Oct)

The spec is not frozen for any of this. A gap such as a missing parent link is
something to add; the spec itself says per-message parents would be an
extension that leaves every existing record valid (`conversation.md:57-61`).
A null parent could mark where compaction restarts the model's context.

> "stop thinking the spec is frozen, its not"; "you'd probably have null
> parent to indicate?" (Stephen, 7 Oct)

## Why something has to give

Four things were wanted of one record:

1. **Harness-neutral:** any harness can write it and any presenter read it.
2. **Exactly what each model saw:** the messages array, as sent. This was the
   original design aim. Stephen's 7 Oct position is narrower: the record holds
   at least what the model sees (see "Why it is not easy").
3. **Cheap to join:** a new harness takes part with little work.
4. **A lossless resume source,** including for a harness that composes its
   request at send time.

For bridge and claude-sdk-cli all four hold at once, because their stored form
and their sent form are the same thing. For Claude Code they can't. Recording
exactly what the model saw means recording a per-model rendering, which is
not what Claude Code resumes from. Recording what Claude Code resumes from
means its typed entries, which are neither harness-neutral nor what the model
saw. A neutral vocabulary rich enough to resume every composing harness
losslessly has to grow with every harness's internals, which is the opposite
of cheap to join. Each position gives up one of the four.

Underneath is a choice about what the spec is for. It can try to adapt to
every harness's content, a large vocabulary always catching up, or it can make
taking part as easy as possible for a new harness, at the cost of shared
meaning. Making resume-from-stream optional was a step toward the second: a
harness that only presents what its model saw still conforms.

> "basically, does the spec try to adapt and support everything? / or does it
> try to make participating as easy/frictionless as possible?" (Stephen,
> 7 Oct)

## Where it stands

**Recorded in the epic's design record (positions, not yet concrete):**
Claude Code is the source of state; what is committed follows Claude Code;
resuming from tower is out of v0; where a reminder sits is semantic. The
record's own rule is that everything the model sees must be published
(`purpose.md:37-39`); it is the record's rule, not a decision of Stephen's.

**Stephen's leaning** (7 Oct, recorded only here): resume from the stream is
optional, never required; the record can become presentation and an
externalised, queryable account; content is typed, not generic; person-only
entries go on their own subject under `changes.`, ordered by the harness's
timestamps; the spec changes where it has a gap. As an idea only: native
harness data could go on its own subject or event.

**Open:** the typed design itself; the name of the person-only subject; how
compaction's restart is marked; whether the spec's premise and `service` text
describe a requirement to resume from the record; how strict "the same" is
for a resume that is offered (`resume.md:36-39`); and, underneath, whether the
spec leans toward supporting everything or toward cheap participation. It
needs more thought and discussion before it narrows.
