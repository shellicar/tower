# The lookout

The daemon that watches conversations and decides what reaches a handler.

A lookout watches, judges whether what it sees is worth calling, and calls the
bridge. It never sets course. And it verifies before it shouts, because calling
a cloud a sail is how a lookout loses its job.

This document is the design record, not a build plan. It exists because every
limit below is a limit by choice rather than by limitation, and a chosen limit
that is not written down with its reason gets read as an accident and helpfully
removed.

## Why it is not the router

[`orchestration-layer.md`](../planning/orchestration-layer.md) defines routing as
the Mailroom: "It carries messages but decides *nothing* about what they mean or
when to send them." The lookout's entire job is deciding what matters and when to
speak, so it is definitionally not routing.

Nor is it the Router role in `~/repos/shellicar/skills/roles/router`, whose
mandate is also decision-free: create a session, destroy one, deliver a mission,
detect completion. The lookout is a third thing. It watches, judges salience, and
reports. It never decides what happens next.

## Where it sits

Of the three concerns above the agent, the lookout is not one of them cleanly,
and for a first version that is accepted rather than solved. It reads the bus
(routing), it holds the reporting lines (control plane), and it decides
what is worth surfacing (orchestration logic). The concern boundary it must not
cross is the last one: it decides what is worth *saying*, never what should
*happen*.

## The six limits

Each is a deliberate constraint, with the reason it is held. firstmate holds
versions of 1, 2, 3 and 6, but only 3 and 6 are forced on it by tmux: with no
addressing, "up" cannot be a message and a payload cannot travel. It holds 1 and
2 as written rules, the same as here. Either way a choice needs its argument
recorded, or it gets read as an accident and helpfully removed.

**1. The human has one interlocutor.** A worker never addresses the human, and
every upward path terminates at its parent. This is an attention limit, not a
transport limit. Let workers address the human and you are back to juggling
terminals, which is the problem the whole design exists to solve.

**2. A node sees only its direct reports.** A handler knows nothing of its
workers' workers. This is a context limit. If one node tracked the whole tree,
its context would hold every worker in the fleet, and a full handler is a stupid
handler.

**3. Outcomes return to the sender.** If A spawns B, B's outcome goes to A, always.
A is the only node that knows why B exists, so routing B's outcome to C means C
receiving an answer to a question it never asked. The consequence worth having:
every node can answer "what am I waiting on?" from its own state alone, which is
what makes each one independently restartable. Allow outcomes to route sideways
and no node can reconcile by itself, so a global view becomes mandatory.

The bus makes the temptation real, because a correlation id means reply-to *could*
name a third party. It should not. The case that tempts you, "what if A is gone by
then", is answered by A's state being durable: the outcome goes to a new A,
because the thing that owns the wait is the role, not the process.

**4. The lookout establishes facts; the handler renders verdicts.** The lookout
may check whether a branch was pushed, a PR opened, a check green. It may not
decide whether the work is acceptable. Facts are cheap, deterministic, and
verifiable; verdicts are judgment, and judgment belongs to an agent.

**5. The lookout knows nothing about the workflow.** It must not know what a
mission is, what a phase is, or what any particular kind of work means. The test:
a completely new kind of work should be addable without touching the lookout. If
it needs a new branch, the workflow has leaked into the engine.

**6. Pointers travel, payloads stay put.** A report, a PR, a branch is left on
shared ground and referenced. Findings are not relayed up a chain. This is what
keeps the tree shallow: a three-level relay of content is three chances to lose or
distort it, and the artefact is already durable where it sits.

## What the lookout never does

- It has **no API and no write path of its own**. No control subject, no adopt
  request, nothing to register with the lookout. It reads the reporting lines, which
  the spawn tool owns, and it reads the bus. It writes only into a handler.
- It does not spawn, brief, merge, or tear down. Those are handler actions.
- It does not render a verdict, per limit 4.
- It does not carry workflow knowledge, per limit 5.

## The shape

Six things:

1. **Subscribe** to conversation change events, filtered to the conversations in
   the reporting lines.
2. **Read the reporting lines**: which conversation is a worker, and whose. Written
   by the spawn tool, never by the lookout.
3. **A clock**, because the case that matters most produces no event at all.
4. **A filter**: does this need the handler?
5. **A verifier**: before relaying a claimed outcome, check the artefact.
6. **A sender**: say into the handler's conversation.

## Decided mechanics

**A reporting line is declared, never inferred.** It is not a transport fact. No
message, spawn, or attach establishes it, because every one of those is an operation
anyone can perform against anything. Watching traffic cannot recover it either: a
parent asking a worker a question and a worker reporting to its parent are the same
shape on the wire, so an inferred graph gets edges backwards. It is the org chart,
and you find that out by looking it up rather than by watching the corridors.

So the owner states it, and the statement is not a manual step. **One tool does
spawn, register and send**, because a step a handler has to remember separately is a
step that gets skipped or mistyped. The handler decides to commission a worker and
calls one thing; the reporting line exists because that call is what creates the
relationship.

**Spawn and service are different verbs.** `service` is generic lifecycle: spawn,
resume, or unconditional takeover, callable by anyone against any conversation. So
its caller is whoever wanted the conversation attached, which says nothing about who
owns the work, and a parent field on it would record the last party to attach.
Spawn is the verb that says "this worker is reporting to me", and only a parent ever
says it.

That separation buys a property worth having: **a takeover does not move a line.**
Because `service` never touches the registry, another session attaching to a worker
does not make it theirs, and a bridge restart that re-serves the whole fleet leaves
every reporting line intact.

A line records direction of reporting and nothing else: worker conversation, owning
conversation. Not the contract, not the worktree, which belong to the spawn. It
confers no authority, the same way reporting to a manager rather than a peer says
where a report goes and not who may command whom.

**Keep the live registry and the historical log separate, and do not let one look
like the other.** firstmate already keeps them apart: `state/<id>.meta` is the
per-worker registry, `state/<id>.status` is the append-only event log, and
`bin/fm-crew-state.sh`'s own header says "This helper never infers the current
state from a tail of the log." So this is convergent evidence, not a cautionary
tale.

The lesson is the second clause. Two stores is necessary and not sufficient:
firstmate has both and *still* has to say the log is not current-state truth in
three separate places in its always-loaded prompt (`AGENTS.md` lines 89, 123 and
367), because the log is readable, sits right next to the question, and answers it
plausibly. Separation does not stop a reader folding the log into an answer. It
only makes doing so wrong.

So that lesson is structural here rather than advisory, in three places:

- **Classification reads the shape of the stream, never the content of a message.**
  Whether a query closed is a *subject*; how long a worker has been silent is a
  *timestamp*. Neither requires reading what anybody said. So the readable thing
  that looks like state is never consulted for state, which is the whole lesson
  expressed as a data dependency rather than as a warning.
- **That is one testable invariant:** the lookout never parses a message body. A
  test asserting it is the durable form of this paragraph, and the paragraph exists
  only to say why the test is there.
- **The decision record catches a violation after the fact.** Every routing
  decision publishes which rule fired, so an answer derived from the wrong source
  shows up in the record instead of having to be inferred from behaviour.

**Use a durable consumer.** That is the wake queue, already built. firstmate
hand-rolled the same thing as a file, for the same reason: a missed event must
survive a restart.

**A cold start replays, bounded by the registry.** The declared lines give the graph,
but not the state: whether a query is open and when a worker last spoke come only from
history. So on startup, read the bucket, then replay each listed worker's own
`conv.v2.<worker>.changes.>` to rebuild those two facts, then tick, then tail from the
durable consumer's cursor.

Bounded by the registry is the point. Without declared lines the replay would have to
cover every conversation on the broker to discover who is a worker at all, over a
stream retained indefinitely, and a time window would be the only way to cap it. With
them it is one read per live worker, and there is no window to get wrong.

Replay must not relay: it is rebuilding state, not reporting news, or a restart
re-announces every historical close. Tick once after it, and anything genuinely stale
surfaces immediately. That single tick is the recovery path, and it is what would have
found the worker that had been dead for a day.

**Ack only after the relay succeeds.** firstmate does the same with a file:
actionable wakes are "written to a durable local queue (`state/.wake-queue`)
before detector state advances" (`docs/architecture.md`). Here it is ack
semantics. Ack first and a crash between ack and say loses the event silently.

**Retry a rejected say.** A stale tip means someone spoke first. Re-read the tip
and re-send with backoff. While a handler is busy, events pile up unacked, which
is exactly right and costs nothing.

**Sessions message down. Workers report up by marking, not by sending.** The tip
precondition rejects a say when the tip has moved, and the tip moves with the
recipient's *own* output, so a sender racing a live turn cannot win until that turn
ends. Two writers on one conversation is the problem, and it gets worse once the
lookout is also writing into handlers.

firstmate has no such problem, by construction rather than by care: a worker never
sends anything to firstmate. It appends one line, `echo "{state}: {note}" >>
state/<id>.status`, and a watcher delivers it. Its brief is blunt that chat is not a
channel: "the main firstmate does not read your chat, so a chat-only reply is lost."
One writer per direction, so nothing ever races anything.

The lookout collects those marks and delivers one batched digest per handler, not one
wake per mark. Same reason firstmate batches: N wakes for N notes is how a supervisor
drowns the worker it is supervising.

This is also what keeps the lookout free of a model. firstmate's classifier is one
regex over verbs the worker chose itself, `done:|needs-decision:|blocked:|failed:`,
and a four-line `case`. The judgment happens where the judgment lives, in the worker,
and the daemon only recognises a token. Ask a daemon to infer intent from prose and it
needs a model, and then every wake costs tokens and can be wrong in ways nobody can
enumerate.

**Still open: where the mark lives.** If it is message content, the lookout must parse
prose, which breaks the invariant above. firstmate escapes that because its status file
is a different artefact from its chat, so the verb is structural. The equivalent here
is a report on its own subject, which is a wire question rather than a daemon one.
Until it is settled, structure alone gives the four states but can never say *what*
happened: that a worker finished, never that it finished with a PR or a blocker.

Note what this buys over the tmux era: firstmate decides whether it is safe to
speak by capturing the pane, finding the composer row, and deleting every dim or
dark-truecolor run so the harness's own grey placeholder can be told apart from
characters a human actually typed. A precondition on the tip replaces that
heuristic with a correctness property.

## Classification

Waking on every query close is not enough, and a live fleet showed why. Four worker
conversations, read off the wire on 5 August:

| `changes.query` | last message | real state |
|---|---|---|
| `completed`, 8m ago | recent | working normally |
| **none** | recent | working, first turn |
| `completed`, 3h ago | 3h ago | turn done, work unfinished |
| **none** | **23h ago** | **dead mid-turn** |

The last one had opened an `Exec` running `sleep 420` and a build poll. The
`tool_result` never arrived and the query never closed, because the process went away
mid-call and a crash publishes nothing. It had been silently finished-and-not-
reporting for a day, and the human found it, not the machinery.

So two facts classify all four, and neither is a message body: whether a query is
still open, and how long the conversation has been silent.

| open query | last activity | state |
|---|---|---|
| yes | recent | working. Leave it. |
| yes | old | **dead mid-turn.** Needs re-servicing. |
| no | recent | finished a turn. Relay it. |
| no | old | idle, waiting on someone. |

A query is open when a `queryId` has been seen on a message with no matching
`changes.query`. That pairing is exact and needs no content, which is what keeps the
invariant above intact.

**Hence the clock.** The fourth state produces no event *ever*, so no subscription
can reach it: absence of events is the signal, and absence has no event. This is why
firstmate polls every fifteen seconds despite having push events available, and it is
the state that costs most, because a worker that died mid-turn is holding unpushed
work.

Beyond those four, the absorb rules cannot be designed before the noise has been
seen. firstmate's are large because they accreted from experience, and their code
comments still name the overnight failure that taught them one of the rules.

When the rules do arrive, the vocabulary is already proven. firstmate's
`bin/fm-transition-lib.sh` is 103 lines and holds two things: one normalised
record that every backend's events are folded into before any policy runs, and
one table mapping a state to an action. Four actions:

- **actionable**: wake now.
- **absorb**: do not wake, *but clear this worker's escalation dedupe marker* so
  the next real edge fires again. This is a third thing beyond wake and ignore,
  and it is only obviously necessary once an escalation has silently failed to
  re-fire.
- **defer**: do nothing on the fast path, and leave it to the debounced machinery
  that already covers it.
- **fallback**: unrecognised, so fall back to polling. Never act on an ambiguous
  read.

Their assignment is the expensive part, and it inverts the obvious guess:
`blocked` is the *only* immediately-actionable state, meaning specifically that
the agent is waiting on a human. `idle` and `done` are **defer**, because they
blip transiently between tool calls, and fast-pathing them is, in their words, "a
false-positive firehose". The arm leaves completion to "the existing
status/turn-end completion semantics and the poll backstop": the reason is
transience and the debounce, not verifiability.

That assignment is about *rendered agent status*, and it does not transfer
wholesale. A query close on this bus is a real semantic boundary, not a
transient, so it is safe to act on. Agent telemetry is the signal that carries
the firehose risk, and the same caution applies to it.

**Publish every decision, including which rule fired.** Already the plan in
[`landscape.md`](landscape.md), and the four action tokens give it a shape:

```
{ event, matched, action: actionable|absorb|defer|fallback, rule }
```

Which means the first version of any workflow language gets derived from a record
that already discriminates, rather than from prose that has to be parsed later.

## What to take from firstmate

Cloned at `~/repos/kunchenguid/firstmate`. The survey is in
[`landscape.md`](landscape.md#firstmate); these are the specific artefacts, so
nobody re-reads 42,541 lines of bash across 109 files to find them.

- `bin/fm-transition-lib.sh`: the normalised record and the four-action table
  above. The single most useful file in the repo.
- `bin/fm-classify-lib.sh`: the status verbs, and one distinction worth copying
  exactly. `paused:` means a bounded external wait that will clear by itself;
  `blocked:` means the supervisor must act. They get completely different
  treatment, one resurfacing on a slow cadence and one waking immediately.
- `AGENTS.md:123` for the rule, `bin/fm-crew-state.sh` for the mechanism. The rule
  is "A `state/<id>.status` line is a wake event, not current-state truth", and
  crew-state.sh is what you call instead: its own header says "This helper never
  infers the current state from a tail of the log." Worth carrying as a sentence,
  because a worker's self-report is unreliable in both directions, claiming done
  when checks are red and dying silently without saying anything. The report is a
  doorbell and never a verdict.
- `bin/fm-brief.sh:421`: the generated ship brief tells the worker to check
  `pwd -P` and `git rev-parse --show-toplevel` before it starts and to stop with a
  blocked status if it landed in the primary checkout. Ship briefs only; the scout
  branch carries no isolation check. `bin/fm-spawn.sh` holds a separate
  spawner-side assertion that refuses to launch at all. Two commands on the worker
  side, and it kills a catastrophic class of error.
- `AGENTS.md:340`: "A teardown refusal for uncommitted or unlanded work is a
  stop-and-investigate result, never an obstacle to bypass." The rule lives in the
  contract, not in `bin/fm-teardown.sh`, which only says it refuses. Adopt as a
  rule long before automating teardown.
- `AGENTS.md` section 9: the escalation list. Work ready for review, finished
  findings, gate findings that require a decision under the configured authority, a
  real blocker after the playbook is exhausted, anything destructive, irreversible
  or security-sensitive, and a needed credential. Six items, already shaped, and it
  is what a mature classifier eventually encodes.
- The ship/scout split, and the clause that matters: a report may recommend
  implementation but does not authorise it.

Leave behind: the always-loaded contract (`AGENTS.md` is 61,576 bytes, roughly
20,500 tokens by firstmate's own estimator), the second-level home architecture,
everything about tmux, and above all the vocabulary translation table at
`AGENTS.md:416-426`. That table is a symptom. A single interlocutor becomes a
translation bottleneck, because everything the fleet learns must be re-rendered
for the human by exactly one node, and eleven rewrite rules plus a ban on relaying
worker reports verbatim is what that costs in prompt real estate. How much of a
handler's context then goes on re-rendering is measured nowhere, so expect the job
rather than a number. Limit 1 is still right.

## Deliberately not decided

**Depth.** firstmate caps its tree at three levels: `AGENTS.md:69` and
`docs/configuration.md:218` both state that secondmates do not spawn secondmates.
The reason given there is that the secondmate harness setting is the primary's own
and is not inherited, and the middle level's stated purpose is domain routing,
with per-scope project clones. That a middle tier is also how a handler sheds
context when it has too many direct reports is my reading, not theirs. Either way
it buys nothing at trial scale. Design for it, do not build it.

**Whether the verdict shape becomes approval v2.** [`landscape.md`](landscape.md)
records that nobody models an answer with a shape whose content routes the next
step, and lists firstmate as blocking and waiting for the captain. That undersells
it. firstmate has the richest version of the five, built in prose, and it lives in
`AGENTS.md` section 7 at lines 321 to 323: an ask-user finding returns as
`needs-decision`, the answer must name "the decision key, step, action, affected
finding IDs, instructions where needed, and exact response command", and a
matching `resolved` event is required. Two skills sit around that rather than
carrying it: `.agents/skills/ask-user-authority/` owns who may answer, and
`.agents/skills/decision-hold-lifecycle/` owns the backlog lifecycle. The keyed
open-and-resolved semantics are `bin/fm-classify-lib.sh`.

That is per-item, keyed, and correlated, which is the shape said to be missing.
When approval v2 is taken up, there is a working implementation of the semantics
to mine rather than an abstract design to invent. Nothing here says to go and do
it.

**Whether the handler is long-lived or re-served per wake.** Every wake is a turn
in a handler's conversation, so the handler's context is the real budget.
firstmate has no choice, because a terminal session is long-lived, and it pays for
that with a knowledge-sweep skill and a startup memory budget pinned at 7,500
tokens. Conversations here are addressable and re-servable, so a wake could serve
a *fresh* handler that reads durable state and acts, which solves the problem
rather than managing it. Untested, and it changes what limit 2 costs.
