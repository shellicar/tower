# Project state

Continuation doc for the agent harness redesign. Read this first — it maps the design docs and says where things stand. Technical; for a session picking the work up.

## What this is

A **new tool** — a Claude-powered coding assistant — on a clean, layered architecture. It re-architects and subsumes an existing tool (`claude-sdk-cli`): the agent becomes a standalone, headless process that speaks a **protocol**; apps (TUI, web, Tower) connect as clients over **bridges**; an **orchestration layer** ("the fleet") coordinates many agents. It is *not* a rewrite of the existing tool — it's a new design that absorbs the existing tool's proven capabilities.

Built part-time by one person, new to LLMs this year. Scope discipline is deliberate, not incidental.

## Tower components (the full product)

Tower = the full platform. Its high-level components:

- **Agent** — the standalone unit that does the work (talks to the model, runs tools, holds a conversation). Headless; speaks the protocol.
- **Bridge** — the connection between an app and the agent. Translates protocol to/from the wire.
- **Protocol** — the bridge protocol specifically. The language between apps and agents, carried by bridges. Not the agent↔model interface (that's the model adapter).
- **Model adapter** — talks to the model (Anthropic, etc.). The agent's down-facing interface. Swappable (model-agnostic).
- **Control plane** — command and manage: spawn, kill, lifecycle, routing delivery, sender-side visibility (acks). Uses NATS or similar.
- **Workflow** — the logic deciding what should happen, in what order, routing on verdicts. The orchestration brain (distinct from control-plane orchestration).
- **Routing** — carries messages between agents. Delivered via the control plane.
- **Monitoring** — independent system-wide observation: agent events, node health, connection health, control-plane health. Receiver-side metrics. Independent of the control plane so it can watch the control plane.
- **Operations** — infrastructure health and uptime. Overlaps with monitoring; the exact boundary is Tower-layer design.
- **App** — the human-facing surface (TUI, web, mobile). A client of the agent via a bridge.

Control plane, monitoring, and operations have intentional overlap. For example: "did a message arrive?" — the control plane sees the ack (sender-side), monitoring sees the receipt (receiver-side). Both perspectives are valuable; they cross-verify. The overlap is a feature, not duplication.

## Status

**Design phase complete. No code yet.** Architecture, MVP scope, and the hard conceptual pieces are worked out and documented. Next is settling one remaining design question, then starting the build.

## The design docs (what each holds)

All in `.claude/plans/`:

- **multi-transport-architecture.md** — the capabilities / protocol spec. The protocol (events + requests + identity), the layers, bridges, the AgentModel seam, tools, dynamic capabilities, audit, Tower, initialisation, configuration. The *what* of the agent.
- **code-architecture.md** — how the code is structured. Four views: connectivity (layered stack), components (nouns + edges), workflows (verbs + participants), cross-cutting. Three contracts: protocol, **content vocabulary** (tool-output rendering), model-adapter interface. Config tiers, seams. The *how* of the agent.
- **feature-comparison.md** — MVP / TUI decisions, compared against the existing tool and Claude Code. must / want / deferred / excluded, with a summary at the end.
- **orchestration-layer.md** — the layer above the agent: three concerns (routing/Mailroom, control plane/Tower, workflow-orchestration logic), the fleet vision, the orchestration-term qualifier rule.
- **glossary.md** — overloaded terms that must always be qualified (client, transport, orchestration, agent, SDK).
- **unix-lessons.md** — the Unix primitives the design reuses (fds, pipes-vs-sockets, stderr discipline, fork/exec, failure model, signals, backpressure, files-as-transport).
- **sdk-feature-inventory.md** — feature inventory of the existing codebase (sub-agent pass).

## MVP scope

Deliberately small: a **single agent process, one bridge (stdio), one TUI client, basic tool approvals.**

- **Agent must**: token refresh, spawn-with-config, audit log, tool registry + bundled tools (read/edit/find/grep/exec, PDF/images), approval flow, attachments (protocol side), stdio bridge, standalone-no-embedded-UI.
- **Agent want**: dynamic tools, MCP, skills, runtime model switch.
- **TUI must**: OAuth login, credential handling, multi-line input, editor primitives, command mode, attachments, alt-buffer rendering, text reflow, resize handling, streaming text, approval render/respond.
- **Deferred (designed-for, behind seams)**: multiple clients, multiple bridges, distributed approvals, encrypted credential exchange (network only), reconnection (socket only), session resume/persistence/transfer, the orchestration layer, reactive tools, an AgentModel second implementation.
- **Excluded (deliberate)**: compaction, auto-memory, background bash, plan mode, hooks, vim mode, voice, @-mentions, slash-commands-as-input.

The MVP is a *new shape around proven capabilities* lifted from the existing tool, not new invention — which is what makes it achievable part-time.

## Key decisions / principles

- **Decide only what must be decided now; defer the rest behind clean seams.** The through-line; every deferral has a named seam.
- **The agent is headless** — no embedded UI; the TUI is a separate process over stdio.
- **Audit is the foundation** — comprehensive, conversationId-keyed; the recovery floor, and what makes resume/portability deferrable.
- **Model-agnostic** (model adapter) and **language-agnostic** (protocol as wire spec); polyglot implementations interoperate at the wire.
- **It's a protocol, not a declarative spec** — you implement a harness that speaks it. The declarative part is the scenario/fleet layer (composition of primitives), which is deferred. The pipe dream (declare arbitrary behaviour) is off the table because behaviour is code.
- **Config has two tiers** — bootstrap (bridges/credentials/comms, immutable, containment) and operational (model/tools, after init). The permissions/mutability elaboration is deferred.
- **Tools produce meaning, not presentation** — typed content blocks (`{type, attributes}`), rendered by the client via a shared vocabulary (HTML/browser model). The meaningful thing for a mutating tool is its *effect* (a diff), produced in a preview/intent phase that rides in the approval. PreviewEdit generalised.

## What's next

1. **Settle the content-vocabulary design** — exactly how tools produce typed intent-representations for approval/display. Mostly worked out in code-architecture.md (Contracts); needs finalising.
2. **Begin the MVP build** — project structure (likely split packages), protocol shapes (concrete types; expected to churn), the stdio bridge, the agent core, the TUI as a separate binary.
3. **Deferred: the session design pass** — resume / persistence / transfer. Not blocking (audit floor covers it), but the biggest deferred unknown. Key reframe already done: transfer isn't an agent feature — it's orchestrated respawn + recover-from-audit.

## Internal cleanups (housekeeping, flagged in code-architecture.md)

- Architecture doc says "bridge encapsulates layers 2–4"; code-arch refines transport as injected (`{ readable, writable }`). Reconcile.
- Architecture doc's config section says "all config bootstrap + dynamic"; code-arch refines to bootstrap/operational tiers. Align.

## What gets lost between sessions

The design docs capture decisions and structures. They don't capture the reasoning discipline, the working relationship, or the ways a new session is likely to get this wrong. This section does. **Read this before engaging with the user on any design topic.**

### The reasoning discipline

**The default is "defer."** When in doubt, don't design it. Name the concept, name where it sits, stop. Do NOT fill in gaps, propose mechanisms, or sketch implementations unless explicitly asked. The user's instinct is to leave things open until they're forced closed; a new session's instinct is to close gaps "helpfully." These instincts are opposed.

**"Strip it back" means strip it back.** If you're told to strip, you've over-specified. The correct level is: what is this concept responsible for, and who does it talk to. Not: what interface does it expose, what primitives does it use, what sequence does it follow.

**"Don't design it" means stop.** Not "sketch it lightly." Not "note the considerations." STOP. The user will resume the topic when ready. Continuing after being told to stop is the single most common failure mode.

### The level

The docs describe **capabilities and responsibilities**, not software design. A new session reading `code-architecture.md` might see component names and start writing interfaces or types. That's wrong. The architecture says WHAT the components are and WHO they talk to. The HOW (types, interfaces, code) is downstream, not in scope for these docs, and likely to churn.

When proposing additions or changes, the right grain is: "X is responsible for Y; it communicates with Z around W." Not: "X exposes subscribe/send/history." The first is architecture; the second is implementation. The user explicitly distinguishes these and pushes back on the second.

### MVP means almost-nothing

The MVP default is **nothing is included**. Features are argued IN, not argued out. A new session seeing the feature-comparison doc might think the blank rows are "not yet decided." They're not — blank means "not in MVP, no commitment." The user had to correct this multiple times. The MVP is deliberately tiny. Don't expand it.

### Session/persistence is the deferred dangerous topic

Session design (resume, persistence, transfer, how conversations survive across processes/machines) was explicitly deferred because it has **massive design ramifications** the user doesn't want to commit to yet. The audit is the safety net that makes this deferral safe — but the audit is NOT the designed persistence solution; it's the floor (the guaranteed-to-work baseline; not necessarily pretty).

A new session should NOT dive into session design unless explicitly invited. This is the hottest deferred topic.

### Tower = the full product (recent decision)

Tower was promoted from being specifically the control-plane pillar to being the **full product/platform** name. The older docs (especially the architecture doc's "Tower" section) still frame Tower as the control plane. A new session reading those might think Tower = control plane. It doesn't anymore. Tower = everything. The control-plane concern is one component within Tower.

### Overloaded terms are a live discipline

The glossary lists known overloaded terms (client, transport, orchestration, agent, SDK). But the discipline is broader: **when any word starts being confusing, force a qualifier immediately.** Don't wait for it to be documented. "Which kind of client?" "Which sense of orchestration?" This is how precision is maintained. A new session should do this proactively, not just check the glossary.

### Don't push analogies

Evocative single words (Tower) are good. Systematic themed vocabularies across all components (naming everything from one analogy — casino, aviation, military) are bad. The user rejects these hard. When naming, pick the word that fits THAT thing, from whatever source. Don't import a theme and fill every slot.

### How the user works

- Discusses first, decides second, writes third. Don't produce artifacts without discussion.
- Pushes back hard on imprecision. Uses precise language and expects the same.
- Values "I don't know" over a confident wrong answer.
- Part-time builder, runs a company, new to LLMs this year. Don't propose ambitious timelines or assume full-time.

### The fleet is real, not theoretical

The fleet (automated multi-agent Claude workflow — operator, supervisor, PM, Router) is the user's **actual working process**, done manually today via tmux and scripts. It's not aspirational; it's a manual PoC that's proven the concept works. The architecture is designed to automate what's already happening by hand.

**Evidence of scale**: the user built a dedicated thread-tracking system (the Weaver — `claude-threads` repo) because the volume of concurrent Claude sessions exceeds what human memory can hold. The Weaver's workflows map directly to Tower's components: Birth = control-plane spawn, Inventory/Map = monitoring + observability, Death = lifecycle management, Rehydration = session recovery. The Weaver IS the manual version of Tower's control plane + monitoring. It exists because the problem is real and at volume.

### The docs have an order

1. **project-state.md** (this file) — read first; the index and context.
2. **multi-transport-architecture.md** — the capabilities spec (what).
3. **code-architecture.md** — the structural design (how the parts compose).
4. **feature-comparison.md** — the MVP scope (what's in/out).
5. **orchestration-layer.md** — the layer above (Tower as product, the fleet).
6. **glossary.md** + **unix-lessons.md** — supporting reference.

Reading them out of order (especially jumping to code-architecture before understanding the capabilities in the architecture doc) produces confusion.
