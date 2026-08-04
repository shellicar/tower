# The landscape

Who else is out there, what they built, what they did better than tower, and
what they did not. Recorded so the next session reads this instead of working it
out again.

The two columns are a lens, not a scorecard. Most of what sits under "did not do
better" is a tradeoff someone made on purpose, usually buying simplicity or
reach with something tower chose to spend. A private inbox needs no retention
policy. A boolean is implementable by every runtime. Bash needs no install. When
their choice is defensible on its own terms, that is said, because the useful
question is what each one paid for and whether tower wants the same bargain.

Surveyed 3 August 2026, and it will go stale. Depth varies and the difference
matters: firstmate, Open Agent Spec, and the Synadia protocol were cloned and
read; herdr's socket API was read from its published docs; pi-web was read from
its own description only. Claims that are theirs rather than checked are marked
as theirs.

The sources are on disk, and these are the remotes to re-clone them from
elsewhere. All are checked out as `~/repos/<owner>/<repo>`.

| Local | Remote |
|---|---|
| `~/repos/synadia-ai/synadia-agent-sdk-docs` | `https://github.com/synadia-ai/synadia-agent-sdk-docs.git` |
| `~/repos/herdrdev/herdr` | `https://github.com/herdrdev/herdr.git` |
| `~/repos/kunchenguid/firstmate` | `https://github.com/kunchenguid/firstmate.git` |
| `~/repos/jmfederico/pi-web` | `https://github.com/jmfederico/pi-web.git` |
| `~/repos/oracle/agent-spec` | `https://github.com/oracle/agent-spec.git` |
| `~/repos/open-workflow-specification/specification` | `https://github.com/open-workflow-specification/specification.git` |

Two naming traps. `ogulcancelik/herdr` redirects to `herdrdev/herdr`, and
`motionharvest/herdr` is a different repository with no stars. There are also two
unrelated projects called pi-web, both web interfaces for the Pi coding agent:
the npm package `pi-web` is `ravshansbox/pi-web` and serves port 8192, while the
one described below is `@jmfederico/pi-web` on port 8504.

The Cursor and Copilot SDKs have no public source. `@cursor/sdk` points at
`cursor/cursor`, an issue tracker with no code, and `@github/copilot` points at
`github/copilot-cli`, an installer. What is written about them here comes from
their own announcements.

## Synadia Agent Protocol

The closest thing to tower that anyone has built, and by some distance. Synadia
are the NATS company, and this is a NATS-native protocol for identifying,
discovering, and talking to agents. One document, 877 lines, RFC-style with
numbered sections and MUST/SHOULD language. Version 0.3 draft. Reference SDKs
live separately at `synadia-ai/synadia-agents`.

The shape: every agent instance occupies `agents.{verb}.{agent}.{owner}.{name}`,
where verb is one of `prompt`, `hb`, `status`, `attachments`. Agents register as
NATS micro services. A prompt gets a streamed response of typed `{type, data}`
chunks terminated by a zero-byte message. An agent can pause mid-stream to ask
the caller a question. Heartbeats give liveness.

### What they did better

**Capability declared at registration.** The prompt endpoint declares
`max_payload` and `attachments_ok` in its registration metadata, and callers
"MUST enforce locally". Only two fields, and tower solves the size half
differently by externalising heavy values into refs rather than declaring a limit
and rejecting. But the shape is right: the endpoint says what it accepts, and the
caller checks before sending instead of discovering by failure.

**Acknowledge before working.** An agent must emit `{type:"status",data:"ack"}`
as the first message on the reply subject, "before any `response`/`query` chunk
and before any latency-inducing work". The caller knows it was heard before
anything slow starts. Tower's `accepted` on `say` is the same idea; the explicit
"before any latency-inducing work" clause is the part worth copying, because it
is the bit an implementer gets wrong.

**Owner is in the identity.** `{agent}.{owner}.{name}` puts multi-tenancy in the
subject from the start. Tower's conversation id is opaque, which is fine for a
fleet with one operator and would not be for a shared one.

**Verb before identity in the subject.** `agents.{verb}.{agent}.{owner}.{name}`
means the routing axis sorts first, so `agents.hb.*.*.*` is every heartbeat on
the system. Tower reaches the same place from a different layout, since
`approval.v1.*.lifecycle` is every ask fleet-wide, so this is a parallel choice
rather than a better one. Worth knowing it was made independently.

### What they did not do better

**The decision construct is a string, and it is private.** Section 7, mid-stream
queries, is their approval concern. An agent "MAY pause its response stream to
ask the caller a question - a permission prompt, a clarification, a menu
selection". The query carries an `id`, a `reply_subject`, and a `prompt` string.
The caller publishes one reply to a fresh `_INBOX` subject. That is
point-to-point and ephemeral: nobody else can see the question, nothing is
retained, a late joiner cannot discover what is outstanding, and there is no
record of who answered. Their own words: "No acknowledgment is defined."

Tower's approval concern does more. The raise is an event on a discoverable
subject, so `approval.v1.*.lifecycle` finds every outstanding ask fleet-wide. The
answer is an RPC with real replies, so `already_settled` and `not_found` are
honest outcomes and first valid answer wins. The settlement carries `by`, so
every other watcher's view clears and shows whose decision it was. The per-ask
pulse means a watcher can tell pending from pending-whose-holder-died.

What they bought for that is real, though. An `_INBOX` needs no stream, no
retention policy, no outstanding-set reconstruction, and no per-ask pulse. For
one caller talking to one agent, which is the shape their protocol is written
for, it is the right size. Tower spends all of that machinery to make an ask
visible and answerable by anyone in the fleet, which only pays when there is a
fleet and someone other than the caller might answer. The difference is scope
before it is quality.

**A permission prompt can silently approve itself.** Section 7.3: on timeout the
agent may "proceed with a harness-defined default and continue emitting chunks.
In case (b), the caller receives no signal." For a clarification that is
tolerable. For the deletion prompt in their own example it is not. Tower's
position, that a dead holder answers nothing and `not_found` is honest, is the
better one.

**There is no conversation record.** The prompt endpoint is a request that
returns a stream. There is no committed change stream, nothing that persists what
was said, no replay. Tower's conv concern is a record; theirs is an RPC.

**Versioning is out of band, and it has already cost them.** The protocol version
lives in `metadata.protocol_version` as MAJOR.MINOR, with "Different MAJOR: no
interoperability guarantee". Their own version table is the argument against it:
0.3 is "Not wire-compatible with 0.2 - the prompt subject changed", and 0.1 to
0.2 broke as well. Three versions, two wire breaks, and no way to run old and new
side by side. Tower puts the version in the subject per concern, so the trees are
disjoint and a pre-v2 tower runs beside a v2 one untouched. That is exactly the
cost tower paid a subject token to avoid, and here is the evidence it is a real
cost.

**Nothing about storage or replay.** No JetStream, no retention, no late joiner
reconstructing anything.

**Discovery by scatter-gather, and a race they then have to work around.**
`$SRV.INFO.agents` enumerates by broadcasting a request and collecting replies,
so a caller never knows when it has them all and just times out. Section 8.5
exists because of it: subscribe to the heartbeat wildcard *before* the first
ping, or miss an agent that registers between the two. The race is manufactured
by choosing request/reply for discovery. Tower has no enumeration step to race
against, because liveness is a fold over the stream and a late joiner replays.
Using the micro-services framework also welds the agent concern to NATS, which is
the coupling `nats.md` is a separate document to prevent.

**The liveness promise is weaker than tower's.** Their heartbeat carries
`interval_s` and recommends 30 seconds, with values under a second discouraged.
Recommended, not enforced. Tower's `pulse` carries `intervalS` as a promise, "you
will hear from me again within `intervalS` seconds", bounded in the schema at 600
with the bound being validity rather than a cap, so an over-long promise makes
the event invalid whole instead of being silently clamped. Tower also mandates no
cadence at all, and defines what a missing interval means: an instance that never
declares one is permanently open to takeover, deliberately. Their version leaves
both of those undefined.

### What to take

The ack-before-latency clause, and the multi-tenant identity if tower ever serves
more than one operator. Not the discovery mechanism.

## herdr

A terminal multiplexer built for agents (herdr.dev). Panes, tabs, workspaces,
sessions that survive a closed terminal, attach over SSH. The same shape as tmux.
What it adds is knowing an agent is running in a pane, and tracking whether that
agent is working, blocked, idle, or done.

The easy assumption is that it works this out by reading the screen. It does not,
or not primarily. Its socket API has `pane.report_agent(pane_id, source, agent,
state, message)`, and the agent declares its own state. The docs are explicit
that the state carries weight: "state is semantic. It affects waits,
notifications, and rollups." Screen detection is the fallback for agents that
report nothing.

### What they did better

**Lifecycle authority and display are separate calls.** `pane.report_metadata`
exists alongside `pane.report_agent` and the docs say it has no lifecycle
authority. Reporting that changes what the system believes is a different thing
from reporting that changes what a user sees, and separating them means a
cosmetic integration can never move state.

**A blocking primitive in the API.** `agent.wait --until
{idle|working|blocked|done}` lets a script or another agent wait on a state
rather than poll for it.

**The client itself.** As a terminal client it is further along than anything
tower will build soon, and it is persistent and reachable over SSH.

### What they did not do better

One machine: it is a Unix socket at `~/.local/share/herdr/herdr.sock`. Live only,
so anything nobody was listening for is gone. Four states plus display metadata,
against the conversation concern's turns, tools, deltas, usage, and the whole
approval exchange. And state attaches to a pane, which ties identity to the
multiplexer, where tower attaches it to a conversation that can be hosted
anywhere.

Each of those is what it costs to be a terminal tool with nothing to install.
There is no broker to run, no stream to configure, and pane identity is free
because it already has the panes. Tower requires NATS before it does anything at
all, and buys with that the things a socket cannot reach.

### What to take

Nothing structural. It could be a good client and a good source of declared
state. A herdr-to-NATS bridge is the obvious shape if it is ever wanted, and it
would be an additive surface, not a substitution.

## firstmate

A directory of bash scripts you drop into a repo. One agent, the "first mate",
takes your instructions and dispatches work to other agents, the "crew". Each
crewmate gets its own git worktree and its own pane. You talk to one agent and it
manages the rest. 100 shell scripts in `bin/`, with backends for tmux, herdr, and
zellij.

This is the closest anyone has shipped to tower's orchestration idea, as opposed
to its protocol idea.

### What they did better

**One normalised event shape and one policy table.** `bin/fm-transition-lib.sh`
normalises every backend's event stream into a single record before any policy
runs, and owns one table mapping a state to the action a consumer must take.
Their own comment: "a backend contributes only a wire->record normalizer and a
stream reader; the shape and the policy are shared", and "Adding or changing a
status's action is a one-line edit here, and it changes every backend at once."
That is the multi-transport architecture, reached independently.

**Supervision that costs no tokens.** Crewmates append `done:`, `blocked:`, or
`failed:` lines to a status file, and a Claude Stop hook re-arms the watcher.
Watching a fleet without paying a model to watch it is a real result.

**Config a branch cannot subvert.** `.no-mistakes.yaml` is "honored only from the
default-branch copy of this file", because "a pushed branch cannot turn this
off". A config an agent can edit mid-run is not a config.

**Definition of done as a checked value.** A ship task requires `--mode`, one of
`no-mistakes`, `direct-PR`, or `local-only`. The mode is written into the brief
machine-readably, and relaunching with a mode that disagrees is refused.

**Not every task produces a diff.** A "ship" task delivers a PR or a merge; a
"scout" task delivers a report. Roadmap principle 5, confirmed by someone else
hitting it.

### What they did not do better

The process is bash heredocs. `fm-brief.sh` generates several hundred lines of
prose instructions through shell `case` statements and string templates. The
workflow language is real and it works, but it is spread across command-line
flags, three config formats (`.tasks.toml` for the backlog, `.no-mistakes.yaml`
for gates, `data/projects.md` for project posture), and branching shell. There is
no single document describing what an agent is and how it runs, so there is
nothing to hand to someone else and nothing another implementation could carry.

They built the runtime for a workflow engine and never took the language out of
it. That is the gap, and it is also a warning about sequence: the runtime works
well enough that pulling the language out never becomes urgent.

## Open Agent Spec

Oracle's declarative format for describing agents and agent workflows
(openagentspec.dev). Read from the repository at version 26.2.0.dev7. Their
technical report is in the clone at
`docs/pyagentspec/agentspec_technical_report.pdf`, and is on arXiv as 2510.04173;
neither was read.

It is a real specification, not a library with a spec-shaped README. A prose
language specification of about 3,400 lines, and a JSON Schema artifact committed
once per release, five so far, so versions can be diffed. Two SDKs in the same
repository, Python and TypeScript. Adapters for LangGraph, AutoGen, CrewAI, and
OpenAI Agents, plus a reference runtime called WayFlow shipped separately.

Two runnable things. An Agent is conversational. A Flow is a graph of nodes:
start, end, agent, tool, llm, api, branching, catch-exception, subflow, map,
parallel-map, parallel-flow, input-message, output-message. Edges come in two
kinds, `ControlFlowEdge` and `DataFlowEdge`.

The serialized form is a flat graph of named components with references:

```yaml
$referenced_components:
  oci_genai_llm:
    id: "93b6d1d1"
    type: "OciGenAiLLM"
    model_id: "command-r-08-2024"
  agent:
    type: "Agent"
    llm: [{ $ref: oci_genai_llm }]
agentspec_version: 25.4.1
```

### What they did better

**A configuration's minimum version is computed, not declared.** Every component
carries a range, `min_agentspec_version` and `max_agentspec_version`, both
`init=False, exclude=True` so an author cannot set them and they never serialize.
`model_post_init` computes them from the configuration. The floor moves on values
rather than types: an Agent with `human_in_the_loop=True` stays on the old floor,
because `True` is what the old version already meant, and only setting it `False`
requires 25.4.2.

**And the constraint is attributable.** The tree walk returns a tuple of the
version and the component that forced it, so the error names the culprit:

```
Invalid agentspec_version: component agentspec_version=25.4.1
but the minimum allowed version is 25.4.2
(lower bounded by component 'my agent')
```

Tower already legislates this instinct one level down, in the `#[source]` chain
rules and the test pinning that a rendered chain names its cause. This is the
same idea applied to version constraints. The strongest transfer is to
conformance: computing the version an implementation actually requires from the
fixtures it passes, rather than letting it declare one that can drift from the
evidence.

**Downgrade works.** `_versioned_model_fields_to_exclude(version)` drops fields
that did not exist in the target, so exporting to an older version emits a valid
older document instead of failing. Export defaults to the lowest version that
works.

**Control flow and data flow are separate edge sets** over one node graph. What
runs next and what feeds what are different questions, kept independently
inspectable.

**Authentication is a specified component.** `AuthConfig` and `OAuthConfig` with
discovery, PKCE, and scope policy. Not needed yet. It is needed the moment a
definition written by one person runs against a protected service for another,
which is what distribution means.

### What they did not do better

**Human decisions are three booleans and a string.**
`Agent.human_in_the_loop` is a `bool` deciding whether the agent may ask at all.
`Tool.requires_confirmation` is a `bool`. In a Flow, `InputMessageNode` is the
only way to ask a person anything and is validated to produce exactly one output
of type string. `BranchingNode` then routes by exact string match against a
`Dict[str, str]`.

Their tracing events are richer than their language. `HumanInTheLoopRequest` and
`HumanInTheLoopResponse` both carry `content: Dict[str, Any]`, and
`HumanInTheLoop` appears nowhere outside the tracing package. The structure is
present in what an observer can watch and absent from what an author can write.

Their portability goal is probably what holds it there. A definition has to run
on LangGraph, AutoGen, and CrewAI, and a construct none of those has is a
construct no adapter can carry. Reaching many runtimes costs you the vocabulary
none of them share. Tower has the opposite constraint and therefore the opposite
freedom: one wire, its own agents, and nothing to translate into.

**The definition names its provider and its model.** `OciGenAiLLM` with a
`model_id` is part of the agent, not supplied by a runtime. Running the same
definition on a different provider means editing it. Their portability is across
frameworks, not across providers, and those are different claims. Configs exist
for OpenAI, OpenAI-compatible, Gemini, Ollama, vLLM, and OCI GenAI. There is no
Anthropic.

The other side of it: their definition is complete. Hand someone the file and it
runs the same way it ran for you, because nothing about which model answers is
left to the environment. A provider-neutral definition is by construction an
incomplete one, and behaviour then varies with whatever adapter picks it up. That
is reproducibility against portability, and wanting the second means owning the
first as a problem rather than pretending it went away.

**Compatibility is a prose obligation.** "It's the responsibility of the
maintainers of Agent Spec Runtimes, SDKs, and Adapters to keep up to date with
the latest changes in the Agent Spec language specification, and to report the
compatibility of their artifacts with the different Agent Spec specification
versions." No fixtures, nothing a machine can check. Their versioning rules also
promise a one-year deprecation cycle and then say "any version update, including
PATCH ones, could contain breaking changes", and the two do not reconcile.

**It is growing fast**, from 140 components at 25.4.1 to 241 at 26.2.0, which
reads as absorbing surface rather than holding a small core. Files get large: a
plain agent is around a hundred lines, and one tutorial configuration is 41KB of
JSON, because nothing nests and every component carries an `id`, a `name`, and
the key it is referenced by.

## pi-web

A web interface for Pi Coding Agent sessions running on a remote machine
(pi-web.dev). Global npm install, per-user service, serves 127.0.0.1:8504. Shows
transcript history, shell activity, token usage and cost, and lets you redirect
an agent while it runs. Finds git worktrees itself.

Their argument, in their words: "Local development made sense when humans drove
every keystroke. Agentic development works better when the environment is
persistent, remote, and always available."

The one thing worth keeping is that cost and token usage belong on the main
surface rather than in a debug view. The conversation concern already carries
usage per frame, so this costs nothing. Otherwise it reads one agent's
transcripts rather than consuming a contract other tools could implement, and it
is tied to Pi.

## Others in the same area

Noted, not investigated:

- **CNCF Serverless Workflow**, now
  `open-workflow-specification/specification`, a governed JSON/YAML workflow DSL
  that predates the agent wave. If a general workflow language is ever wanted,
  borrowing a governed one beats inventing one.
- **The durable-execution argument**, that agent workflow engines are
  rediscovering what Temporal already does with signals and durable state. Worth
  reading before building any of it.

## Where all of them stop

None of them treat a human decision as structured input to routing.

Take a code review as the example. An agent reviews a PR and produces findings.
A person then goes through them and says, per finding, whether to keep it, and if
kept, how it should be fixed. Each kept finding is then handed to a different
agent. The middle step is a typed answer from a person, with one answer per item,
and the answers decide where the work goes next.

Every one of them handles a human in the loop as a yes/no gate or one line of
text. Agent Spec went furthest and still stopped: two booleans, one node
returning exactly one string, routing by exact string match. Synadia's is a
prompt string answered by a text string on a private inbox. herdr models states
of a pane. firstmate blocks and waits for the captain. None of them model an
answer with a shape, whose content is what routes the next step.

Two of them show the same asymmetry from the inside. Agent Spec's tracing carries
`Dict[str, Any]` in both directions while its language cannot express that.
Tower's ask is already an open discriminated union and its verdict is a bool:

```ts
approvalRequest = { type: 'answer', ts, from, approved: z.boolean() }
settled         = { type: 'settled', ts, approved: z.boolean(), by: sender }
```

The structure turns up as soon as anyone needs to watch the exchange, and it is
missing from the part an author writes. Closing it means the verdict being
discriminated the way the ask already is, which breaks the concern and so is an
approval v2. Per-concern versioning handles that, and v1 and v2 would coexist.

Nothing here says to go and do it. The point is that the gap is one field wide,
tower's substrate already supports it, and five serious projects converged on the
same boolean without closing it.

## The agent definition, and its relationship to tower

Recorded because it changes what tower should avoid doing, not because anything
is being started.

The idea is three layers. A definition says what an agent is: its instructions,
its skills, the tools it may use, and how it runs. A runtime executes that, in
whatever language. A model adapter translates for a particular provider. Any
runtime with any adapter, and the definition is the thing you share.

**There are three specs in that, not two.** The comparison worth making is OCI,
where containers split into an image spec (what the thing is), a runtime spec
(how to run it), and a distribution spec (how to move it between people). The
third answers "how do I share a managed agent with someone", and it is the one
nobody has built. firstmate ships a git clone. Agent Spec ships a YAML file and
versions the language it is written in, which is further than anyone else gets,
but there is still no addressing, no registry, and no way for one definition to
depend on another and pin it.

Distribution also depends on conformance, and this is where tower is ahead rather
than behind. You can only usefully hand someone a definition if they can check
their runtime carries it. Agent Spec asks maintainers to report compatibility in
prose. Synadia has a twelve-point implementation checklist and no fixtures.
`conformance.md` plus `scenarios.md` is a test run.

**The dependency runs one way. Tower depends on the agent definition; the
definition must not depend on tower.** If running a shared agent requires a NATS
broker, nobody runs it, and the reason for having a definition disappears. A
runtime implementing it should work as one process on one machine with no broker,
with tower attaching as an optional observer.

Most of that seam is already there. `nats.md` is separate from the concern specs,
so the meaning of a conversation is already written apart from how it travels. It
does leak: subject names and examples like `conv.v2.conv-abc.deltas` sit inside
the concern documents. Nothing needs doing about that now. The point is that when
the definition needs to stand on its own it is a rearrangement of documents that
already exist, not a redesign.

**Two different things are called an API.** Cursor's SDK (`@cursor/sdk`, public
beta 29 April 2026) gives you, in their words, "the same agent runtime, harness,
and models that power the Cursor desktop app, CLI, and web app". The Copilot SDK
(public preview April 2026) similarly "exposes the same agent runtime that powers
Copilot's cloud agent and CLI". Those are whole agents. Point a definition at one
and its harness owns the tool loop, not ours, and the approval concern has
nowhere to live because the permission model belongs to them. GitHub Models API
(`POST /inference/chat/completions`) is the other kind: inference, nothing else.
Only the second is a model adapter target. The line is not the vendor. It is
whether you are given inference or given an agent.

**What varies between model APIs**, as the axes only, because the details change
and are easily looked up: the shape of a tool call and its result; the rules for
pairing results back to calls; how reasoning content is represented and whether
it must be returned unchanged; whether caching is declared or automatic; where
the system prompt goes; what `tool_choice` means. Most an adapter absorbs
silently. Two are judged different, and this is judgment rather than research:
parallel tool use and native skill support are present or absent rather than
translatable, so a definition should be able to require them and be refused by an
adapter that lacks them.

## Deliberately not decided

**Whether a conversation can move between model adapters.** Content blocks in
`conversation.md` are the model's own, described there as "opaque typed blocks".
That is what lets provider-specific reasoning content round-trip, and it is the
right call. It also means a conversation recorded through one adapter may not be
resumable through another. Whether that is true, and whether it should be, is
open. Writing down "conversations are bound to their adapter" would be quick, and
quick is not the same as cheap: implementers would build against it, and undoing
it later costs far more than writing it saves. It stays undecided, and this
paragraph exists so nobody assumes it either way.

**Whether any of the workflow language happens, and when.** The order is to build
the concrete routing first, as a process beside bridge, learn from the cases it
actually has to handle, and take the language out afterwards. That is the right
order. It is also exactly where firstmate stopped.

**The one cheap thing that keeps the option open.** Have that router publish
every routing decision it makes, including which rule fired, even while the rules
are three `if` statements. Then the first version of any workflow language gets
derived from a record of real routing rather than designed in the abstract. It
costs one publish call, and it is the same "record now, analyse later" that made
stage 1 worth shipping.
