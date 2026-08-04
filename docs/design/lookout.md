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
(routing), it holds a registry of live workers (control plane), and it decides
what is worth surfacing (orchestration logic). The concern boundary it must not
cross is the last one: it decides what is worth *saying*, never what should
*happen*.

## The six limits

Each is a deliberate constraint, with the reason it is held. None is forced by
the transport. firstmate holds the first three because tmux left it no choice,
which is why it never had to justify them; here they are choices, and a choice
needs its argument recorded.

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

- It has **no API**. No control subject, no adopt request. The handler mints a
  worker's conversation id, so the handler already knows every field of the
  registry entry and writes it itself. The lookout only subscribes and reads.
- It does not spawn, brief, merge, or tear down. Those are handler actions.
- It does not render a verdict, per limit 4.
- It does not carry workflow knowledge, per limit 5.

## The shape

Five things:

1. **Subscribe** to conversation change events and agent telemetry, filtered to
   the conversations in the registry.
2. **A registry** of live workers: worker conversation, its handler, its worktree.
   The lookout's only persistent state.
3. **A filter**: does this need the handler?
4. **A verifier**: before relaying a claimed outcome, check the artefact.
5. **A sender**: say into the handler's conversation.

## Decided mechanics

**The registry is a NATS KV bucket, and the lookout watches it.** A registry has
deletes, so it is a table and not a log; an append-only file would mean folding
tombstones on read to answer "what is live now". Watching the bucket means
registry changes arrive as events, like everything else, instead of the lookout
stat-ing a file. Move to sqlite only if questions across entries are wanted
(everything older than N, grouped by handler), because KV is a keyed store and
not a query engine.

**Keep the live registry and the historical log separate.** One store answers
"what is live", another records what was spawned and what it produced. firstmate
fused them: its status file is append-only, so current state has to be
reconstructed from it, so it needed a whole script to do the reconstruction, and
then its always-loaded prompt has to keep reminding the agent not to trust the log
it can plainly see. Two artefacts and that reminder becomes unnecessary.

**Use a durable consumer.** That is the wake queue, already built. firstmate
hand-rolled the same thing as a file, for the same reason: a missed event must
survive a restart.

**Ack only after the relay succeeds.** firstmate learned this as "queue before
detector state advances"; here it is ack semantics. Ack first and a crash between
ack and say loses the event silently.

**Retry a rejected say.** A stale tip means someone spoke first. Re-read the tip
and re-send with backoff. While a handler is busy, events pile up unacked, which
is exactly right and costs nothing.

Note what this buys over the tmux era: firstmate decides whether it is safe to
speak by capturing the pane, finding the composer row, and deleting every dim or
dark-truecolor run so the harness's own grey placeholder can be told apart from
characters a human actually typed. A precondition on the tip replaces that
heuristic with a correctness property.

## Classification

Version one wakes the handler on every query close and classifies nothing. The
absorb rules cannot be designed before the noise has been seen; firstmate's are
large because they accreted from experience, and their code comments still name
the overnight failure that taught them one of the rules.

When the rules do arrive, the vocabulary is already proven. firstmate's
`bin/fm-transition-lib.sh` is 103 lines and holds two things: one normalised
record that every backend's events are folded into before any policy runs, and
one table mapping a state to an action. Four actions:

- **actionable**: wake now.
- **absorb**: do not wake, *but clear this worker's escalation dedupe marker* so
  the next real edge fires again. This is a third thing beyond wake and ignore,
  and it is only obviously necessary once an escalation has silently failed to
  re-fire.
- **defer**: do nothing on the fast path, leave it to the slower verified path.
- **fallback**: unrecognised, so fall back to polling. Never act on an ambiguous
  read.

Their assignment is the expensive part, and it inverts the obvious guess:
`blocked` is the *only* immediately-actionable state, meaning specifically that
the agent is waiting on a human. `idle` and `done` are **defer**, because they
blip transiently between tool calls, and fast-pathing them is, in their words, "a
false-positive firehose". Completion is deliberately handled by the slower path
where it can be verified.

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
nobody re-reads 7,000 lines of bash to find them.

- `bin/fm-transition-lib.sh`: the normalised record and the four-action table
  above. The single most useful file in the repo.
- `bin/fm-classify-lib.sh`: the status verbs, and one distinction worth copying
  exactly. `paused:` means a bounded external wait that will clear by itself;
  `blocked:` means the supervisor must act. They get completely different
  treatment, one resurfacing on a slow cadence and one waking immediately.
- `bin/fm-crew-state.sh` and `AGENTS.md`: "a status line is a wake event, not
  current-state truth." Worth carrying as a sentence. A worker's self-report is
  unreliable in both directions, claiming done when checks are red and dying
  silently without saying anything, so the report is a doorbell and never a
  verdict.
- `bin/fm-spawn.sh`: the worker verifies `pwd -P` and `git rev-parse
  --show-toplevel` before it starts, and stops if it landed in the primary
  checkout. Two commands, and it kills a catastrophic class of error.
- `bin/fm-teardown.sh`: a refusal to tear down unlanded work is a
  stop-and-investigate result, never an obstacle to bypass. Adopt as a rule long
  before automating teardown.
- `AGENTS.md` section 9: the escalation list. Work ready for review, finished
  findings, a decision needed, a real blocker after the playbook is exhausted,
  anything destructive or irreversible, a needed credential. Six items, already
  shaped, and it is what a mature classifier eventually encodes.
- The ship/scout split, and the clause that matters: a report may recommend
  implementation but does not authorise it.

Leave behind: the always-loaded 60K contract, the second-level home architecture,
everything about tmux, and above all the vocabulary translation table in section
9. That table is a symptom. A single interlocutor becomes a translation
bottleneck, because everything the fleet learns must be re-rendered for the human
by exactly one node, and their handler's context goes mostly on re-rendering
rather than on supervising. Limit 1 is still right. Its cost should be expected.

## Deliberately not decided

**Depth.** firstmate caps its tree at three levels, which is tmux pragmatism, but
the purpose of its middle level is real: it is how a handler sheds context when it
has too many direct reports. Depth is a context-management tool, not a hierarchy.
At trial scale it buys nothing. Design for it, do not build it.

**Whether the verdict shape becomes approval v2.** [`landscape.md`](landscape.md)
records that nobody models an answer with a shape whose content routes the next
step, and lists firstmate as blocking and waiting for the captain. That undersells
it. firstmate has the richest version of the five, built in prose: an ask-user
finding returns as `needs-decision`, and the answer must name the decision key,
step, action, affected finding IDs, instructions where needed, and the exact
response command, then require a matching `resolved` event. Two skills carry it,
`.agents/skills/ask-user-authority/` and
`.agents/skills/decision-hold-lifecycle/`, the second giving every unresolved
decision a mandatory backlog lifecycle with keyed open-and-resolved semantics.

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
