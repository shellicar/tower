# Code architecture

Several **views** of the same system, each answering a different question. No single view homes every concept; together they cover the whole. Completeness test: every concept from the architecture doc lands somewhere here.

- **Connectivity** — how data gets in and out (the layered stack).
- **Components** — what the parts are and who talks to whom (the nouns).
- **Workflows** — what happens, by which parts (the verbs).
- **Cross-cutting** — concerns that thread through everything.

Plus the **contracts** (protocol, content vocabulary, model-adapter interface), **configuration**, and the **seams** where deferred things plug in.

---

## View: Connectivity (layered)

The agent is the hub, with an adapter stack on each side: **bridges** face up to apps, the **model adapter** faces down to the model. Both are the same shape — a translation layer over a transport — pointing opposite ways.

```
        apps  (TUI · Tower · webapp · script)
          ▲
          │  L1  Application  — protocol (events + requests + identity)
          │  L2  Bridge       — encode / frame / handshake / credentials
          │  L3  Transport    — bytes over fds / sockets (injected)
          ▼
 ┌───────────────────────────────────────────────┐
 │  AGENT  (see Components)                        │
 └───────────────────────────────────────────────┘
          ▲
          │  Model adapter  — request building · streaming · auth
          │  HTTPS
          ▼
        model
```

Each layer abstracts the one below; the further out (toward the app), the more abstract — an app talks pure protocol and never sees the wire. The further in, the more concrete.

- **L1 Application** — the protocol. App logic on the left, the agent's public interface on the right.
- **L2 Bridge** — encoding (JSON), framing, the handshake (run *over* an established bridge), credentials. Left: bridge client; right: bridge.
- **L3 Transport** — a readable + writable stream, *injected* into the bridge as `{ readable, writable }`, not owned by it. Two fds for stdio, one duplex fd for a socket; collapsed above the construction point.

The model side mirrors it: the loop builds a request (application), the **model adapter** turns it into an API call and streams the response back (the down-facing equivalent of a bridge), over HTTPS.

### Two kinds of traffic (events vs requests)

The protocol carries two kinds, routed differently:

- **Events** — broadcast. Things that happened. No destination; the bridge fans them out to every attached client. Can't be rejected. `text_delta`, `turn_ended`, `cancelled`.
- **Requests** — addressed. A request carries sender identity; its response routes back to that sender. Rejectable against state. `user_input`, `approval`, `requestCancel`.

So `cancel` / `requestCancel` is a *request* (you're asking; it can be refused); `cancelled` is an *event* (it happened; react only). Sender identity on a request is the return address for its response; events have no sender in that sense.

> **Transport is injected, not owned.** The architecture doc says "the bridge encapsulates layers 2–4." Refinement: transport (L3) is handed to the bridge, separate and swappable. The architecture doc should be updated to match.

---

## View: Components (the nouns)

What each part is responsible for, and who it talks to. Grain rule: **a component is a distinct responsibility, usually with its own state, that other components talk to.**

- **Agent** — the entry point apps talk to; runs the turn cycle.
- **AgentModel** — owns the conversation/state and defines how it evolves: builds a request from it, integrates a response into it, performs state operations (compact). The seam for different conversation shapes (workspace, forkable).
- **Bridge** — moves messages between an app and the agent over a wire. **Bridge client** is the app-side end.
- **Orchestrator** (in-agent) — adds context to incoming messages before the agent acts (per-turn injection). Distinct from workflow orchestration (a Tower-layer concern; see orchestration-layer doc).
- **Tool registry** — the *catalog*: what tools exist, resolve one by name. Mutable at runtime (dynamic capabilities).
- **Tool execution** — the *runtime*: run a tool, manage its lifecycle (receive input → preview/intent → execute → result), emit lifecycle events. First-class, *separate from the registry* — this is what keeps the loop clean.
- **Approval coordinator** — tracks whether a tool may run.
- **Audit** — records what happened.
- **Model adapter** — talks to the model (request building, streaming, auth).
- **Config** — holds configuration state; app-managed, handed to the agent, read by components.
- **App** — TUI / Tower / webapp: takes input or orchestrates, renders or consumes.

**Edges — who communicates with whom, around what:**

- App ↔ Agent — the conversation (messages in, events out), through a bridge.
- Agent ↔ AgentModel — building requests, integrating responses (loop drives, model shapes state).
- Agent ↔ Model adapter ↔ Model — completions (request out, response back).
- Orchestrator ↔ Agent — incoming messages (inject context before acting).
- Agent ↔ Tool registry — resolve a tool.
- Agent ↔ Tool execution — run a tool, receive its lifecycle events.
- AgentModel ↔ Tool registry — which tools fit the model (model-scoped).
- Agent ↔ Approval coordinator — whether a tool may run.
- Audit ↔ Agent — events (records them).
- Config → components — read at startup / runtime.

**Not components** (placed so nothing's dropped):

- **Protocol** — the contract on the App↔Agent edge, not a part.
- **Content vocabulary** — the contract on the tool-output edge (see Contracts).
- **Cancellation** — a workflow, not a part (see Workflows).
- **History, dynamic capabilities, sessions** — responsibilities of existing components (Agent, Tool registry, AgentModel).

---

## View: Workflows (the verbs)

A workflow isn't a component; it's carried out by a set of them. Trace the thread — name the parties, not a sequence.

**In v1:**

- **A turn** — the spine. App, Bridge, Agent, Orchestrator, AgentModel, Model adapter, Tool registry, Tool execution, Approval coordinator, Audit. Almost everything; the others hang off it.
- **Tool approval** — Agent, Approval coordinator, Tool execution (produces the intent-representation), App (renders it, returns the decision). Around: whether a tool may run, *and* showing the user what it means.
- **Cancellation** — Agent, Model adapter, Tool execution, Approval coordinator, Audit. Around: stopping in-flight work.
- **Init / handshake** — Config (bootstrap), Bridge, Agent, App. Around: bringing the session up.
- **Attachment** — App (captures), Bridge, Agent, AgentModel (folds into request), Model adapter. Around: non-text input.

**Deferred (participants named, not built):**

- **Resume** — Audit (read), AgentModel (reconstruct), Agent.
- **Dynamic capability change** — sender (App / Tower), Agent, Tool registry.
- **Distributed approval** — Agent, Approval coordinator, multiple Apps + Bridges, `approval_settled`.

---

## Contracts

Three contracts, each a shared language on an edge that lets two sides interoperate without knowing each other.

### Protocol (App ↔ Agent)

Events + requests + sender identity. The language apps and the agent communicate in. Detailed in the architecture doc.

### Content vocabulary (tool output → renderer)

How a renderer knows what to show for a tool use or result, *without knowing the tool*. The HTML/browser model:

- A tool emits **typed content blocks** — a semantic type plus structured attributes: `{ type: "file_edit", file: "/path", diff: "..." }`.
- The **renderer** (TUI) has a renderer per *type*. It keys off the type, not the tool. It renders `file_edit` whether the tool was EditFile, an MCP edit tool, or one written next year.
- Unknown type → graceful generic fallback, like an unknown HTML tag.

The split: the **tool** decides *what to present* (it's the only party that knows what its fields mean); the **renderer** decides *how*. Neither knows the other; both know the vocabulary — exactly how a server and a browser written by strangers produce a working page.

Two consequences:

- **The meaningful thing is often the effect, not the input.** For EditFile, a patch spec isn't human-judgeable; the resulting diff is. So a mutating tool has a **preview/intent phase** that produces its effect as content (a `diff`) *without applying it*, and an **execute phase** that performs it. PreviewEdit/EditFile is this, generalised — the split exists *because* the meaningful representation requires computing the effect separately from doing it.
- **The intent-representation rides in the approval.** The tool approval event carries not just "tool T, input I" but the tool's typed intent-representation — what it means. The input is for the model; the meaning-representation is for whoever approves. The TUI renders the representation; it never needs to know what a tool *means*.

### Model-adapter interface (Agent ↔ Model)

How the agent talks to a model without importing a provider. Swap the adapter (Anthropic, OpenAI, local), keep the agent. The model-agnostic seam.

---

## Cross-cutting

Not layers or parts — they thread through.

- **Audit** — taps the event stream, writes to a sink (`AuditSink`: file now, SQLite/remote later). Comprehensive, conversationId-keyed. The recovery floor.
- **Cancellation** — enters at L1 (`requestCancel`) or as an OS signal; propagates into the model adapter (abort), tool execution (stop), approval coordinator (settle). SIGTERM → graceful close + audit flush; SIGINT → cancel turn. The agent handles both protocol and signals, because an orchestrator killing a container sends signals.
- **Logging** — to stderr (fd 2) or a file, **never stdout**. fd 1 is protocol-only; a stray write corrupts the stream.

---

## Configuration

Two tiers:

- **Bootstrap** — what the agent needs to *start communicating*: which bridges, credentials, comms. From outside at spawn (a file/env). It *defines the bridges*, so it precedes any bridge and any handshake. Immutable for the process lifetime — containment: a compromised agent can't open a channel to an attacker.
- **Operational** — what the agent *runs with*: model, tools. Delivered after init, not necessarily on the same channel. Runtime-mutability (dynamic tools, model switch) is a deferred want.

> Deferred, not designed: the config permissions/mutability model (immutable / write-once / write-many, per-client authority), and which channel operational config arrives on. The split is the seam; the elaboration is later.

---

## Why this shape

- **The agent is testable in isolation** — depends only on the protocol (up) and the model-adapter interface (down). Fake the bridge, record the model, the agent runs unchanged.
- **Adapters are swappable** — new transport = new L3; new wire = new L2; new model = new adapter. None touch the agent or each other.
- **The app is shielded** — writes to L1, never learns the transport. Tower writes the same code whether the agent is local or in a container in another region.
- **It's Unix-shaped** — bridge = byte streams over fds; spawning = fork/exec; recovery = respawn; cancellation = signals. (See the unix-lessons doc.) Where we invent — protocol semantics, credential exchange, the content vocabulary — is where Unix has no answer.

---

## Seams (deferred, behind clean boundaries)

- **L2 reconnection** — sockets only; stdio dies with the parent. Not v1.
- **L2 credential exchange (encrypted)** — only when credentials cross a network L3. Stdio injects out-of-band. Not v1.
- **Multiple bridges / clients per bridge** — the agent emits to all; the bridge fans out to all. Designed-for; proving it is a POC. Not v1.
- **AgentModel** — one model today; the abstraction slots into the AgentModel component.
- **Reactive tools** — long-lived subscriptions as tool effects (OpenFile, WatchAgent); the seam is Tool execution's lifecycle.
- **Session recovery** — `reconstruct(audit for id) → state`; a stub in v1, the audit floor makes it deferrable.
- **Config permissions model** — the bootstrap/operational split is the seam.
