# Multi-transport agent architecture

## Context

The SDK and CLI are tangled. The agent loop only runs as a TUI because `main.ts` wires SDK components directly to `AppLayout`. Per-turn injection, cancellation state, and the streaming-to-display path are scattered across `main.ts` and the CLI surface. Adding a second presentation — headless JSON, web, message bus — means rebuilding the wiring each time.

The TUI also shouldn't be the centre of gravity. The harness needs to support orchestration as a first-class concern: who sent a message, who is receiving events, how multiple agents coordinate. These primitives matter even for simple orchestration patterns — a script that glues two sessions together still needs to know whether a message came from a user or from another session. The current architecture is shaped backwards: it optimises for the consumer that matters least and gives the rest no surface to attach to.

The fix is to name the boundary that currently doesn't exist: the line between "what the agent does" and "how it talks to whoever's listening." Once that line has a shape — a typed, serialisable, bidirectional protocol — every presentation becomes a transport implementation against the same surface. The TUI stops being special. One agent talking to another (mediated by an orchestrator) is the same shape as a human talking to an agent. The protocol is the only surface.

This document is about capabilities and boundaries — what the agent must be able to do, and how its parts relate. The interfaces, types, and field names shown throughout are illustrative; the architecture locks in shape, not implementation.

## Goals

- One Agent abstraction with a stable, serialisable, bidirectional protocol
- Headless-by-default agent process; the TUI is a separate process if anyone wants one
- Headless modes (stdio, socket, message bus) for scripting, swarms, and orchestration
- Per-turn context injection has a home that isn't `buildRequestParams`
- The architecture preserves a seam for multiple agent models (append-only conversation today; workspace, forkable, others later)
- Orchestration primitives — sender identity, message events, agent-to-agent channels — are first-class; any orchestrator built on the protocol uses them, whether a service, a script, or a message bus
- No functional regression from the current TUI

## Non-goals

- Tower itself: this doc describes what the agent app must expose for Tower to work; it doesn't design Tower
- Multi-tenant server (one process serving N unrelated users with isolated sessions)
- Authentication on remote transports
- Persistence beyond the current file-based session model
- Building the multi-model abstraction now — we draw the line, we don't pour the concrete

The doc considers transports we may never build (Kafka, AMQP) and models we may never write because including them forces the boundaries to be drawn in the right places. If the design works for a message bus carrying workspace-model agent events, it works for stdio carrying conversation-model events.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Clients                                                │
│  TUI process | Web client | stdio script | NATS         │
│  consumer | spawned agent | observer ...                │
└────────────┬────────────────────────────────────────────┘
             │  wire protocol (JSON over the chosen transport)
┌────────────┴────────────────────────────────────────────┐
│  Bridge                                                 │
│  stdio bridge | Unix socket bridge | WebSocket bridge   │
│  | NATS bridge | ...                                    │
└────────────┬────────────────────────────────────────────┘
             │  Agent interface (subscribe / send / history / close)
┌────────────┴────────────────────────────────────────────┐
│  Agent                                                  │
│  Orchestrator + AgentModel (state + tools + loop) +     │
│  ApprovalCoordinator + internal channel                 │
└─────────────────────┬───────────────────────────────────┘
                      │  IMessageStreamer
┌─────────────────────┴───────────────────────────────────┐
│  Model adapter                                          │
│  AnthropicClient (HTTP+auth) | StreamProcessor          │
│  | buildRequestParams                                   │
└─────────────────────────────────────────────────────────┘
```

Four layers. The Agent interface is the only boundary that crosses presentation/agent. Everything below it is the same regardless of which client is talking; everything above it is the same regardless of which agent is responding. There is no "in-process presentation" category — every client talks to the agent through a bridge.

Orchestrators (like Tower, or simpler scripts gluing sessions together) sit *above* this diagram: they run as clients (typically via a message bus like NATS, or stdio for simpler cases) and use their own knowledge of how work flows between agents. The agent app provides primitives; orchestration is built on top.

## Three terms

A typical interactive run has two processes: an **agent process** holding the conversation and running the loop, and a **TUI process** rendering it. They're connected by a **bridge**: the agent writes JSON events to its stdout and reads JSON messages from its stdin; the TUI does the inverse.

Three terms emerge:

**The protocol** is what's logically exchanged — typed events (`text_delta`, `turn_ended`, `approval_request`, …) and messages (`user_input`, `approval`, `cancel`) with their semantics (sender identity, approval round-trips, subscription contracts). The protocol doesn't say how the bytes move, only what gets exchanged and what it means.

**The Agent interface** is the in-process expression of the protocol — a JS object with `subscribe()`, `send()`, `history()`, `close()`. Inside the agent process, this is how the agent is reached. One Agent interface per Agent object.

**A bridge** translates between the Agent interface and a wire. It calls `agent.subscribe()` to serialise events outward and decodes inbound bytes into `agent.send()` calls. Each bridge has two properties: a wire format (how events/messages are encoded) and a resource it claims while running (the FDs, path, port, or subjects it holds exclusively).

The Agent interface and the bridges both live inside the agent process. Clients live outside.

### How they relate

```
[Client]  ←wire bytes→  [Bridge]  ←Agent interface→  [Agent]
```

Outbound: an event passes from the Agent interface to every attached bridge; each bridge serialises it to its wire format; each client decodes. Inbound: a client sends bytes; the bridge decodes them and calls `agent.send()`.

### Examples

**TUI parent, agent child, stdio bridge.** TUI binary spawns the agent as a child with piped stdio. The TUI process owns its own real stdin/stdout for the keyboard and screen. The agent's stdin/stdout are pipes to the parent. Agent runs a stdio bridge; TUI runs the matching client side. This is the normal interactive shape.

**Agent with Unix socket bridge, TUI connects.** Agent runs unattended, exposes a Unix socket. TUI process opens the socket, sends messages, reads events. The TUI's stdin/stdout serve its UI; the agent claims neither.

**Agent with stdio + NATS bridges.** Two bridges side by side. Stdio bridge claims stdin/stdout — one client there (a parent or a debugger script). NATS bridge claims a subject pair — Tower attaches there.

**Agent with NATS bridge only.** Headless. Spawned by Tower, Tower-watched, no human attached.

### Coexistence

Bridges coexist in one agent process iff they claim different resources:

| Bridge | Resource it claims | Coexists with |
|--------|--------------------|----------------|
| Stdio bridge | stdin + stdout | everything except another stdio bridge |
| Unix socket bridge | a file path | everything with a different path |
| TCP / WS / SSE bridge | a host:port | everything with a different port |
| NATS bridge | a subject pair | everything with different subjects |
| Worker IPC bridge | a MessagePort | everything with a different port |

At most one stdio bridge per agent process — there's only one stdin/stdout. Everything else can stack freely as long as no two bridges fight for the same path/port/subject.

## Layers

Terminology in this doc spans four layers, roughly OSI-style. The bridge encapsulates the middle layers; the agent lives at the top; the wire is at the bottom.

```
L1: Protocol     ← AgentEvent, AgentMessage; subscribe/send/history; semantics
L2: Encoding     ← how protocol values become bytes (JSON, MessagePack, …)
L3: Framing      ← how bytes are delimited and addressed
L4: Transport    ← how bytes physically move
```

### Layer definitions

**L1: Protocol** — the application semantics. Types (`AgentEvent`, `AgentMessage`), contracts (subscribe, send, history, close), identity (`from: AgentIdentity`), approval round-trips. What's exchanged and what it means. Doesn't care how bytes move.

**L2: Encoding** — how protocol values become bytes. JSON is our default. Could be MessagePack, Protocol Buffers, anything else. Different bridges can use different encodings.

**L3: Framing/messaging** — how individual messages are delimited and addressed. This is where bridge shapes diverge most:
- **JSON lines** — newline-delimited (one message per line)
- **Length-prefixed** — length header followed by payload
- **WebSocket frames** — WS binary/text frame format
- **NATS subjects** — broker-routed, subject-addressed; each message has a subject + payload
- **HTTP request/response** — request body in, response body out
- **SSE events** — server-pushed `event:` and `data:` lines

**L4: Transport** — the physical movement of bytes. TCP, Unix domain sockets, OS pipes (stdio). Many "named" transports (NATS, WebSocket, HTTP) are L3+L4 stacks running on top of TCP.

### Worked examples

**Stdio bridge** (TUI parent ↔ agent child):
- L4: OS pipe between parent and child processes
- L3: JSON lines — each event/message is one line ending in `\n`
- L2: JSON
- L1: Agent protocol

Flow: agent calls `write(stdout, JSON.stringify(event) + '\n')`. Parent reads `stdin`, splits on newlines, parses each line as JSON. Inbound mirrors this.

**NATS bridge** (agent ↔ Tower via broker):
- L4: TCP to NATS broker (separate process)
- L3: NATS pub/sub — agent publishes events to subject `agent.{id}.events`; subscribes to `agent.{id}.messages`. Tower does the inverse.
- L2: JSON in the message body
- L1: Agent protocol

Flow: agent publishes events to the broker on `agent.{id}.events`; Tower subscribes to that subject. Tower publishes messages to `agent.{id}.messages`; agent's bridge subscribes. The broker routes between them.

**WebSocket bridge** (agent ↔ browser):
- L4: TCP (after HTTP upgrade handshake)
- L3: WebSocket frames
- L2: JSON in frame payload (text frames)
- L1: Agent protocol

Flow: browser connects to agent's HTTP server, upgrades to WS. Each event becomes a WS text frame containing JSON. Same for messages.

### Terminology across layers

"Client" means different things at different layers. The doc uses **bridge client** as its primary term; here's how the layer-specific senses relate:

| Term | Layer | Meaning |
|------|-------|---------|
| **Bridge client** | L1 (this doc's term) | Something outside the agent process that consumes the bridge's protocol — subscribes to events, publishes messages. |
| **Transport client** | L4 | Something that initiates a transport connection. For TCP/Unix sockets, whichever side calls `connect()`. For OS pipes, neither side (inherited via spawn). |
| **NATS client** | L4 | Anything connecting to a NATS broker, regardless of role. Both the agent's bridge and Tower are NATS clients of the broker. |
| **HTTP/WS client** | L3+L4 | A specific kind of transport client following the HTTP or WebSocket handshake. |
| **Subscriber** | L3 (pub/sub) | Whoever subscribes to a subject/topic. In NATS, the agent's bridge subscribes for inbound messages; the bridge client subscribes for outbound events. Both sides are subscribers (of different subjects). |
| **Publisher** | L3 (pub/sub) | Mirror of subscriber. Both sides publish (to different subjects). |

The "client" terminology at one layer says nothing about "client" at another:

- **WebSocket** aligns them: the browser is a transport client (initiates TCP) AND a bridge client (consumes protocol).
- **NATS** doesn't: both sides are transport clients of the broker; both are subscribers and publishers at L3; the "bridge client" distinction lives entirely at L1.
- **Stdio** has no transport client/server at all (pipe is inherited via spawn); the bridge client is whoever's on the other end of the pipe.

## Clients

A client consumes a bridge: reads events off the wire and sends messages back. Different clients serve different roles, but they all see the same protocol.

### TUI

A binary that renders the agent's events to a terminal — alt-buffer ANSI, raw-mode keyboard. Takes user keystrokes, gathers them into `user_input` messages, sends them. Reads `text_delta`, `thinking_delta`, `tool_use`, etc. from the event stream and paints them.

Typically uses one of two bridges:
- **Stdio**, when the TUI binary spawns the agent as a child process and pipes their stdio together. The TUI process owns its real stdin/stdout for the UI; the agent's stdin/stdout are pipes to the parent.
- **Unix socket**, when the agent is a separate long-lived process the TUI attaches to.

The TUI is a client like any other from the agent's perspective. It calls `agent.history()` over the wire to catch up at startup. No privileged in-process access. The protocol is the only surface — no in-process shortcut to bypass it.

What this costs: one extra process for interactive use, one more binary to ship.

What it buys:
- The TUI can be written in any language, evolved separately, replaced
- The agent's complexity stays inside the agent
- New presentations don't require touching the agent
- The protocol gets pressure-tested by the most demanding client

### Webapp

An HTML/JS frontend running in a browser. Connects to a bridge over a network protocol — typically **WebSocket** (bidirectional, low-latency) or **HTTP + SSE** (one-way events from the server, POST for messages back).

The webapp presents events as DOM updates: streaming text, tool calls, approval prompts as modals, etc. User actions become messages. Multiple users can connect to the same agent simultaneously, giving a paired-session or dashboard shape.

The webapp doesn't run any agent code — it's a pure protocol consumer. The same agent process can serve a TUI client over stdio and a web client over WS at the same time.

### Tower

The orchestrator service. Connects to spawned agents over **NATS** subjects.

Tower is a client like any other from the agent's perspective — it subscribes to events and sends messages with `from: { kind: 'orchestrator', serviceId: 'tower' }`. What makes Tower different is what it does with the protocol: it tracks missions, roles, and phases; it routes messages between agents; it composes envelopes; it decides when to spawn or kill agents.

Tower can be the only client of an agent (a fully autonomous run), or it can coexist with a TUI or webapp watching the same agent (a human follows along while Tower orchestrates).

### Others

- **Stdio script** — a shell program that pipes JSON in and out for scripting and tests
- **Observer / logger** — subscribes only, records events for replay or audit
- **Debugger / inspector** — connects during development to read state without sending messages

These are clients in the same sense as TUI, webapp, and Tower. They differ in what bridge they use and what they do with the events; they're identical in their relationship to the agent.

## The Agent interface

```ts
interface Agent {
  /**
   * Create an independent subscription. Each subscription has its own queue;
   * events fan out to all active subscriptions in arrival order.
   */
  subscribe(): AgentSubscription;

  /**
   * Deliver a control message. Messages from any subscription are processed
   * in arrival order. Approval responses are routed by requestId; the first
   * valid response wins, subsequent responses for the same id are dropped.
   */
  send(message: AgentMessage): void;

  /**
   * Snapshot of model state. Used by new clients to catch up before they
   * start consuming live events. The shape depends on which model is loaded.
   */
  history(): Promise<HistorySnapshot>;

  /** Stop accepting messages; finish in-flight work; release resources. */
  close(): Promise<void>;
}

interface AgentSubscription {
  events: AsyncIterable<AgentEvent>;
  unsubscribe(): void;
}

// Base events. Every agent model emits these.
type BaseAgentEvent =
  | { type: 'turn_started'; queryId: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'approval_request'; requestId: string; name: string; input: unknown }
  | { type: 'approval_settled'; requestId: string; approved: boolean; by: AgentIdentity }
  | { type: 'usage'; tokens: TokenUsage; costUsd: number; contextWindow: number }
  | { type: 'turn_ended'; stopReason: 'end_turn' | 'cancelled' | 'error' | string }
  | { type: 'error'; message: string };

// Model-specific events extend the base via a discriminator.
type AgentEvent = BaseAgentEvent | { type: string; [key: string]: unknown };

// Every inbound message carries sender identity. The receiving agent can
// branch on `from.kind` to know whether it's talking to a human, another
// agent (relayed through an orchestrator), or an orchestrator itself.
type AgentMessage =
  | { type: 'user_input'; from: AgentIdentity; text: string; attachments?: Attachment[] }
  | { type: 'approval'; from: AgentIdentity; requestId: string; approved: boolean; reason?: string }
  | { type: 'cancel'; from: AgentIdentity };

type AgentIdentity =
  | { kind: 'human'; userId?: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'orchestrator'; serviceId: string };
```

Three shape decisions worth naming:

**`subscribe()` returns a per-consumer iterator instead of exposing one shared iterator on `agent.events`.** Async iterators are consumed by one reader; fan-out requires per-subscriber queues. The existing `ControlChannel<T>` already does per-subscriber queues with FIFO pumps — promote it from "implementation detail of the SDK" to "the agent's outbound primitive."

**Sender identity is first-class.** Every inbound message carries `from`. A cast can tell at a glance whether it's a human typing, another agent (relayed through an orchestrator), or an orchestrator itself. This replaces text-based provenance markers like `[Message from the Router, not the SC.]` with a typed field. Application-level metadata about *who* an agent is (role, mission, phase) belongs to whatever orchestrator attached it; the protocol only knows opaque identities.

**`approval_settled` is a real event.** When two clients show the same approval request and one of them responds, the other needs to know to clear its UI. Without `approval_settled` a paired or orchestrated session has stuck prompts.

**Events are base + model-specific extensions.** The base events describe what the LLM did (text, thinking, usage). Model-specific events describe what the agent's state did (tool_use, workspace_changed). Bridges forward everything; clients handle what they understand.

## Per-client responses

The protocol distinguishes two outbound shapes:

- **Broadcast events** — state changes that fan out to every subscribed client (`text_delta`, `turn_started`, `approval_request`, and the rest of `AgentEvent`)
- **Per-client responses** — replies to specific inbound messages, routed only to the sender

Every inbound message receives a response. The response indicates whether the message was accepted, rejected, queued, or otherwise handled. The specific shape — fields, field names, error semantics — is an implementation concern. The architectural requirement is that responses exist as a category distinct from broadcast events, and that bridges route them to the originating sender rather than fanning them out.

This matters because actions and observations are different. A broadcast event is something everyone should know. An action's response is something only the actor needs — and only they can correlate it with the action they took.

### Related considerations (discussion, not locked design)

The shape of responses and how clients use them surface design questions that are implementation territory:

- **State-aware acceptance.** Clients might anchor their messages against the agent's current state (for example, "I'm responding to message X" or "queue this during query Y"), with the agent validating and rejecting on mismatch. An optimistic-concurrency pattern.
- **Operation composition.** Primitives like `cancel` and `user_input` can be sequenced by clients (e.g. cancel-then-send for interrupt-and-replace). Concurrent compositions from different clients can race; responses make races detectable, but resolution is client policy.
- **Atomic multi-operation commands.** Clients might compose primitives into one atomic command as a UX convenience.

None of these is locked in by the architecture. They're sketched here because they emerged from the discussion that produced this section; the implementation decides what responses look like and how clients use them.

## Worked example: one exchange end-to-end

To anchor the abstract description, here's one full exchange traced through every layer.

**Setup.** A TUI binary has spawned the agent as a child process with piped stdio. The user types "What's 2+2?" and hits enter.

**Step 1: TUI gathers input.** The TUI process owns its parent stdin/stdout for the terminal UI. It reads keypresses, builds a string, and on enter constructs an `AgentMessage`:

```ts
{ type: 'user_input',
  from: { kind: 'human', userId: 'stephen' },
  text: "What's 2+2?" }
```

**Step 2: TUI serialises and writes.** The TUI's stdio client encodes the message as JSON and writes one line to the agent's stdin:

```
{"type":"user_input","from":{"kind":"human","userId":"stephen"},"text":"What's 2+2?"}\n
```

L4: OS pipe carries the bytes. L3: newline framing delimits the message. L2: JSON encoding. L1: the `AgentMessage` type.

**Step 3: Agent decodes and accepts.** The agent's stdio bridge reads `stdin`, splits on newlines, parses each line as JSON, and calls `agent.send(message)`. The Agent interface receives the call; the in-agent Orchestrator runs its `TurnInjector`s; the model's loop begins.

**Step 4: Model runs; agent emits events.** As the model streams its response, the agent publishes events through its subscription channel to every attached bridge. With only the stdio bridge attached, it's the sole consumer. Each event gets encoded and written to `stdout` as a JSON line:

```
{"type":"turn_started","queryId":"q-7f3a"}\n
{"type":"text_delta","text":"4"}\n
{"type":"usage","tokens":{"input":15,"output":1},"costUsd":0.00004,"contextWindow":200000}\n
{"type":"turn_ended","stopReason":"end_turn"}\n
```

Same layer stack as inbound: pipe (L4), newline framing (L3), JSON (L2), `AgentEvent` types (L1).

**Step 5: TUI decodes and renders.** The TUI reads its child's stdout, splits on newlines, parses each line as an `AgentEvent`, and updates display state. `text_delta` appends "4" to the assistant's message in `ConversationState`; `usage` updates a token counter; `turn_ended` re-enables the input field.

**What this shows.** The agent never sees the terminal. The TUI never calls into the agent directly. Everything passed between them goes through the protocol — typed events out, typed messages in, JSON on a pipe in between. Any other bridge (Unix socket, NATS, WebSocket) would have the same flow with different framing and transport; the L1 layer is identical regardless.

## Layer responsibilities

### Agent

Owns:
- An `AgentModel` instance that holds the state shape, the request builder, the response integrator, and the tools (see seam section)
- `ApprovalCoordinator` (the pending-approval state — model-agnostic)
- `Orchestrator` (per-turn context preparation — see below)
- The internal `ControlChannel` used between the model's loop and the public interface
- The single `AbortController` representing "the current operation"

Does not own:
- The screen, stdin, any TCP/Unix port, any subject on a bus
- Any disk path other than what `Session` and `AuditSink` are configured with
- Any opinion about how `user_input` was gathered
- Missions, roles, phases, or any other Tower-level concept

### Orchestrator (per-turn injection, in-agent)

Between "a `user_input` arrives" and "the model's loop runs," there's a per-turn preparation step:

```ts
interface TurnInjector {
  prepare(input: UserInput, context: SessionContext): Promise<UserInput>;
}
```

Example injector kinds: surfacing local repository state, injecting content from instruction files, anything else a deployment needs. The specific mechanics (what field of the request they touch, when within a query they fire, what they do with caching) are implementation choices. The architectural point is that per-turn input augmentation has a home, and it's the same for every agent model.

This is different from Tower's orchestration (next section). The Orchestrator here is in-process, per-turn, context-injection. Tower is out-of-process, cross-agent, mission-orchestration. Different concerns, similar word.

### Bridge

A bridge translates between the in-process Agent interface and an external wire protocol. A bridge:
1. Calls `agent.subscribe()` to get an event iterator
2. Serialises each event onto its protocol (JSON over stdio, framed JSON over a socket, WS frames, SSE, NATS subject)
3. Reads inbound bytes from its protocol, parses them as `AgentMessage`, calls `agent.send()`
4. Handles `agent.history()` calls as request/reply on the protocol if the protocol supports it

A bridge is a thin object. The stdio version is ~30 lines.

## The AgentModel seam

The current code bakes in the Anthropic conversation model. State is `BetaMessageParam[]`. Requests are built by `buildRequestParams(messages)`. The loop in `QueryRunner` knows how to integrate tool_use/tool_result blocks. Tools are defined as "input → output, where output becomes a tool_result block."

A different agent model breaks every one of those:

A **workspace model** has state `{ workspace: OpenSubscriptions, conversation: Messages }`. The request includes the workspace as ephemeral context (post-cache), not as conversation history. A tool like `OpenFile` doesn't produce a `tool_result` — it opens a subscription, and the model sees current file contents every turn until it closes the subscription.

A **forkable model** has state as a tree with a current-branch pointer. Integration adds to the active branch.

Each model also has its own state-management vocabulary. Anthropic conversation has `compact` (summarise old messages, drop them, keep the summary). A workspace model would have `open`/`close` for managing what's watched. A forkable model would have `fork`, `switch`, `prune`. These are model-specific operations, just like model-specific events and tools. The protocol doesn't enumerate them.

The current SDK can't do these. The boundary that would let it do these isn't drawn yet.

### The line to draw now

We don't build the AgentModel abstraction now. We draw the line so it can be built later without a rewrite. Three concrete things:

1. **The Agent class doesn't directly own `Conversation`.** It owns a model object that happens, today, to contain a Conversation. The Agent never calls `conversation.push`; it calls `model.integrate(response)`.

2. **`buildRequestParams` is not a top-level SDK function.** It's part of `AnthropicConversationModel`. Today it's the only request builder, but it lives where it belongs: inside the model that defines what "a request" means.

3. **The loop in QueryRunner is written against abstract operations.** Not "append assistant message to conversation, run tools, append tool_result blocks" but "ask the model to integrate the response, ask the model for the next request, check if the model says we're done."

If we get those three things right, adding a second model later is writing the second model class. If we don't, adding a second model is a rewrite of the SDK's core loop.

### The abstraction we'd build later

```ts
interface AgentModel<State> {
  initialState(input: UserInput, session: Session): State;
  buildRequest(state: State): RequestParams;
  integrate(state: State, response: ModelResponse): IntegrationResult<State>;
  applyToolEffect(state: State, call: ToolCall, effect: ToolEffect): State;
  isTerminal(response: ModelResponse): boolean;
  snapshot(state: State): HistorySnapshot;
  
  tools: ToolRegistry<State>;
}
```

Each model owns the shape of its state, how it builds requests, how it integrates responses, how it applies tool effects, when it terminates, and what `history()` returns. The Agent's loop is generic over the model's state type.

## Tools, model-aware

Tools belong to a model. A tool defines its effect; the model knows how to apply effects of that type.

### Today's tools: one-shot, output-as-input

```ts
type ToolHandler<I, O> = (input: I) => Promise<{ textContent: O; attachments?: Block[] }>;
```

Invoke the handler with input, get an output. The Anthropic model wraps the output in a `tool_result` block. After the call, the relationship is over.

Works for tools whose effect is captured by their return value: ReadFile, Grep, Exec.

### Reactive tools: ongoing subscriptions

The Workspace model and Tower-integration both need tools whose effect persists.

`OpenFile` doesn't return contents once — it opens a subscription, model sees current contents every turn until it closes the subscription. If someone else edits the file, the model sees the update on the next turn.

`WatchAgent` returns a subscription to another agent's event stream (useful when one process or orchestrator needs to observe another agent's work). The model sees the watched agent's progress; reacts when it completes.

The shape:

```ts
interface ReactiveTool<I, S> {
  open(input: I, ctx: ToolContext): ToolSubscription<S>;
}

interface ToolSubscription<S> {
  current(): S;
  changes: AsyncIterable<S>;
  close(): void;
}
```

### Tools are model-scoped

`OpenFile` doesn't mean anything to an append-only Anthropic model — it has no place to put a long-lived subscription. `WatchAgent` doesn't mean much without an orchestrator providing other agents to watch. Some tools work across models (Exec, Grep — naturally one-shot). Others are model-specific.

For the SDK today: build the one-shot abstraction with the line drawn for reactive. Tool definitions include an effect type, even if today every effect is "produce a content block." The Anthropic model interprets that as "wrap in tool_result." A future Workspace or Tower-aware model will interpret other effect types accordingly.

### Tool state and durability

Tool state has two kinds:

- **Process-bound caches** — coordination state internal to a process lifetime. Transient; lost on restart; the conversation continues unaffected.
- **Session-bound state** — state the conversation references and that should survive across redeploys. Open files (whose contents the model expects to keep seeing), pending patches (which the model expects to still be able to apply), and similar.

Today's `RefStore` and `PreviewEdit` are implemented as process-bound but are conceptually session-bound — the conversation references them, so losing them across a redeploy breaks continuity. Durable backing storage (SQLite, an external KV, anything portable) is one way to lift them into the session-bound category. The SDK provides the abstraction (a storage interface tools can be constructed with); the deployment provides the implementation (in-memory for ephemeral sessions; SQLite for portable ones).

## Dynamic capabilities

Tools, MCP servers, and skills are configurable at runtime. The agent has a default capability set declared at startup; the protocol carries additions and removals.

The mechanics fit the existing protocol: inbound messages enable or disable capabilities; outbound events confirm or report errors. Who sends them is the standard mix — a TUI user via slash command, Tower for spawned agents, the agent itself via a meta-tool.

A capability covers anything that changes what the agent can do: adding tools, registering MCP servers (whose tools become available once loaded), enabling skills (which bring instructions and tool restrictions). Different in source, same at the protocol level.

## Multi-client coordination

Multiple clients can connect to one agent at the same time. They all see the same events and can all send messages.

Use cases:
- **Paired session.** Two TUIs connect over a Unix socket. Two humans drive one conversation.
- **Observer.** A logging client subscribes but never sends.
- **Dashboard alongside CLI.** Engineer runs the TUI; team member opens a web view of the same agent.
- **Orchestrator watching a spawned agent.** An orchestrator (a service, script, or other tool) subscribes to a spawned agent's events on one bridge; a human is concurrently a client via another bridge.

### Conflict resolution

- **Approval conflict.** First valid `approval` for a `requestId` wins. ApprovalCoordinator drops duplicates silently. `approval_settled` tells the losers (including the identity of who responded — useful when Tower auto-approves vs human approves).
- **Concurrent `user_input`.** If two clients send input while no turn is running, the model decides (Anthropic merges consecutive user messages). If a turn is running, second input rejects with an `error` event.
- **Cancel during another client's action.** Cancel is global. All clients see `turn_ended` with `stopReason: 'cancelled'`.

## History snapshots

A client attaching mid-conversation needs to catch up. Two-step protocol:

1. Call `agent.history()` to get the snapshot of model state up to now
2. Call `agent.subscribe()` and start consuming the live event stream

The shape of `HistorySnapshot` depends on the model:

```ts
type HistorySnapshot =
  | { kind: 'anthropic-conversation'; messages: BetaMessageParam[] }
  | { kind: 'workspace'; messages: BetaMessageParam[]; workspace: OpenSubscriptionState[] }
  | { kind: string; [key: string]: unknown };  // extension point
```

For the first version, the agent buffers the current turn's events; on `turn_ended` the buffer clears. That handles "client attaches mid-conversation" but not "mid-turn." Transport-layer replay (JetStream rewind, SSE Last-Event-ID) composes with `history()` rather than replacing it.

## Concrete bridges

| Bridge | Peers | Notes |
|-----------|-------|-------|
| Stdio bridge | 1 | JSON lines both directions; standard for spawn-and-pipe |
| Unix socket bridge | N | JSON framed; local IPC; the natural transport for TUI ↔ agent locally |
| TCP socket bridge | N | Same as Unix; remote-capable |
| WebSocket bridge | N | Browser-friendly; works through HTTP infra |
| HTTP + SSE bridge | N | GET /events (SSE), POST /messages |
| NATS / JetStream bridge | N (via bus) | Decoupled; bus handles delivery, durability, replay; natural fit for distributed orchestrators |
| Redis pub/sub bridge | N (via bus) | Similar to NATS, less durable |
| Kafka bridge | N (via bus) | High-throughput, persistent |
| MQTT bridge | N (via bus) | Lightweight, common in IoT contexts |
| Worker thread IPC | 1 | In-process, separate JS realm |

None of these are in-process presentations. Every one is a bridge between an agent process and a wire protocol. NATS is called out because message buses fit distributed orchestration well — orchestrators can run anywhere with bus access, and agents speak to them through the NATS bridge.

The bus's job is delivery. The Agent's job is the agent loop. The bridge translates between them. Nothing in the Agent interface changes to support message buses — they're a transport class, not a special case.

Bridges are bidirectional by default — events flow out, messages flow in. For logging or observability use cases where there's no inbound traffic, a variant of any bridge can close off the inbound side: events flow out, no messages flow in. Not a separate mode — just a configuration of the bridge that drops the inbound channel.

## Tower: structured orchestration above the protocol

The protocol gets the agent talking to clients. Tower is what makes multi-agent missions work. It sits above the protocol — knows about missions, phases, roles, supervisor flows, all the things the agent app stays innocent of. This section documents what the agent app must provide so Tower can build on top.

### Division of labor

| Concern | Owner | Notes |
|---------|-------|-------|
| Agent loop, conversation, tools, approval | Agent app | What the SDK does today |
| Wire protocol (subscribe/send/history) | Agent app | Stable, transport-agnostic |
| Sender identity on messages | Agent app | Lets recipients know who sent |
| Reactive tool primitives | Agent app | Subscriptions as tool effects |
| Bridges to transports | Agent app | One per protocol (stdio, NATS, ...) |
| Mission model (phases, roles, chains) | Tower | First-class concept |
| Session/role registry | Tower | Which agent is operator-for-X |
| Spawning, lifecycle | Tower | Agent process management |
| Envelope composition | Tower | Templates filled from mission state |
| Inter-session routing | Tower | "deliver to operator for mission X" |
| Planning decisions | Claude (PM) | Which mission, when to advance, verdicts |

The agent app stays a generic conversation runner. Tower turns N runners into a mission.

### How Claude talks to other sessions

The core requirement: PM-Claude can communicate with other sessions, even if proxied by tools. Here's the path:

1. PM-Claude calls a Tower-API tool (`StartMission`, `NextPhase`, `RunSupervisor`, `SendDispatch`, etc.)
2. The tool publishes a request to Tower via the NATS bridge
3. Tower receives the request, consults its mission model, decides what to do — spawn an agent, recast an existing one, deliver context, etc.
4. Tower composes the envelope from its state (no Claude-authored envelope text), attaches whatever the target needs to know
5. Tower delivers the envelope to the target session via the protocol, with `from: { kind: 'orchestrator', serviceId: 'tower' }`
6. The target cast receives a `user_input` and acts on it
7. The target's events flow back to Tower via NATS
8. Tower forwards relevant events to PM-Claude's subscription (the one returned by the original tool call)

PM-Claude never directly calls another agent's `send()`. Tower mediates. But the communication channel exists end-to-end — PM-Claude can deliver context, watch the work, and react to completion.

### The orchestration API surface

PM-Claude's tools for talking to Tower are coarse-grained operations on Tower's mission model:

- `StartMission(missionId)` — Tower spawns the first cast, delivers initial context
- `NextPhase()` — Tower advances the mission: kills or recasts current cast, spawns the next with appropriate context (operator brief → supervisor, supervisor verdict → next operator, etc.)
- `RunSupervisor()` — Tower launches the supervisor against the current operator's output
- `Recast(reason)` — Tower re-prompts the current cast with reason text
- (and others as the mission model grows)

Each is a reactive tool: returns a subscription to the affected sessions' event streams. PM-Claude watches the events to know when work completes and what verdicts landed.

The agent app doesn't ship these tools. They live with Tower (or Tower's client library) because the Tower-API knowledge belongs there. The agent app ships the primitives that make them possible.

### What the agent app provides for Tower

For Tower to work, the agent app needs:

1. **Sender identity in messages.** A cast can tell that `user_input` came from Tower rather than a human, by looking at `from.kind === 'orchestrator'`. Replaces the current text-based provenance markers.

2. **Reactive tool primitives.** Tools whose effect is a long-lived subscription, not a one-shot result. Same primitive shape works for `OpenFile` (workspace model) and `WatchOperator` (Tower-integration). The SDK provides the substrate; Tower provides the specific tools.

3. **A NATS bridge.** Standard implementation of the bridge contract over NATS subjects. Tower runs on the bus; the bridge translates.

4. **Stable history snapshots.** A Tower-spawned agent that gets re-attached (e.g. after a recast or Tower restart) needs to read history. The `history()` API works the same as for any client.

5. **Cancellation that reaches tool handlers.** Tower can cancel an agent mid-turn (mission aborted, supervisor verdict blocks further work). The signal needs to reach tool handlers — current ones ignore it; new ones can honour it.

That's it. The agent app doesn't model missions, roles, or phases. It provides the surfaces Tower builds on. Tower could be replaced by a different orchestrator with different mission semantics, and the agent app wouldn't notice.

### The Router pattern, rehomed

Today's Router-as-Claude pattern (the `claude-fleet` Router role) collapses Tower into a Claude role because Tower doesn't exist yet. The Router is Claude with mechanical constraints: faithful delivery, no content decisions, just spawn/route/observe. The constraints are mechanical, so an LLM isn't required — only the absence of Tower makes the LLM necessary.

Once Tower exists, the Router responsibilities redistribute:

- **Pane lifecycle** (create/destroy) → Tower spawns/kills agent processes
- **Envelope composition** (template filling) → Tower fills templates from mission state, prepends provenance via sender identity
- **Inter-session delivery** (paste-and-submit in tmux) → Tower routes via the bus
- **State observation** (capture-pane + classify) → Tower subscribes to events directly, exposes structured state queries
- **Planning** (which role, when to advance, verdict interpretation) → stays with PM-Claude

The Router role doesn't survive the transition. PM-Claude is left with the actual decisions. The mechanical work becomes Tower software.

### Tower-less deployment

Tower is an add-on, not a dependency. For deployments without it — single-agent interactive sessions, scripting, testing — the agent runs the same way. No Tower means no Tower-API tools, no spawned agents, no mission model. The agent just talks to its one client (TUI, stdio, whatever). The protocol works either way.

## Session and configuration

`Session` becomes an interface:

```ts
interface Session {
  id: string;
  load(): Promise<unknown>;  // model-specific
  save(snapshot: unknown): Promise<void>;
}
```

`FileSession` is today's implementation. `MemorySession` is for tests. A future `DatabaseSession` for a real server. The Agent doesn't know which is wired. The saved shape depends on the model.

Configuration is constructed by the caller. The Agent takes a `DurableConfig` and an `AgentModel` instance. The entry point chooses how to load config and which model to instantiate.

The snapshot's scope is everything that contributes to future behaviour — not just the conversation. The conversation itself may carry enough to re-establish some state on replay (e.g. an `OpenFile` tool_use staying in history can drive re-opening on resume); other state needs explicit capture in the snapshot. Whether subscriptions and tool state are recovered implicitly from the conversation, explicitly via the snapshot, or via a hybrid is implementation-dependent.

This is the seam for session portability — an agent can be redeployed from its last durable checkpoint, with in-flight work lost cleanly (clients see `turn_ended` with a stopReason indicating restart) and the session resumes from the snapshot. Small recoverable sessions: lose a process, redeploy, start from the snapshot. The architecture supports it; whether deployments exercise it is their choice.

## Initialisation

The agent doesn't auto-discover its configuration or context. No "load `~/.claude/`" convention, no walk-up-the-directory-tree. The agent is given everything it needs at startup, explicitly: configuration, baseline context (system prompts, instruction files), capability set.

Three layers:

1. **Build-time defaults** — baked into the binary; the agent can start standalone.
2. **Startup config** — provided at spawn (CLI args, env vars, config file path, initial message on the bridge). Carries configuration, baseline context, and which capabilities to load.
3. **Runtime updates** — adjustments via the protocol after startup, including dynamic capability changes.

The agent is designed to run in ephemeral environments: a container started for one job, a VM brought up by an orchestrator, anywhere a deployment chooses. Conventions that assume a developer's home directory don't fit. A CLI binary that wraps the agent for human use might still load from user directories and pass the result as startup config; the agent itself doesn't know or care.

An `agent_ready` event signals the agent is alive and has accepted its initial config. Bridges and clients wait for it before sending work.

## Audit

The agent writes its event stream to an `AuditSink`. `FileAuditSink` writes JSONL per session, the current implementation. `MemoryAuditSink` is for tests. A future `DatabaseAuditSink` could record to a backend.

Because the agent owns all state mutations end-to-end, audit can record at operation granularity, not just the event stream. Conversation additions, edits, and removals can each be captured as distinct audit entries. Privacy choices apply per operation: a removal might be recorded as a removal without recording the content. This is a property of the harness owning state; a split architecture where presentation and harness shared state could only audit partial views.

This is different from Tower-style observability. Tower (and other subscribed observers) consume the live event stream via the protocol. The sink is internal to the harness, durable by design, and not dependent on a consumer being attached. The two coexist: a deployment can have both a database audit sink and a connected Tower watching events live.

## Cancellation

One AbortController, owned by the Agent's currently-running query (or null when idle). `agent.send({ type: 'cancel' })` aborts it. The signal threads through to:

- The in-flight HTTP request (already works)
- The tool handler (new: tool handlers gain an optional `signal: AbortSignal` parameter)
- The approval coordinator (new: pending approvals settle with `approved: false, reason: 'cancelled'`)
- Reactive tool subscriptions (when the agent shuts down or the model closes them)

The three places that hold cancel state today collapse to one object's lifetime. Every client sees the same `turn_ended` event regardless of who triggered the cancel.

## What carries over

- `AnthropicClient`, `StreamProcessor`, `buildRequestParams` (moves inside the model), auth — unchanged in substance
- `Conversation`, `ApprovalCoordinator` — unchanged, but Conversation becomes an internal of AnthropicConversationModel
- `ControlChannel<T>` — promoted from "implementation detail" to "the agent's outbound primitive"
- The renderers (`renderConversation`, etc.) — move with the TUI to its own binary
- State objects (`ConversationState`, `EditorState`, etc.) — move with the TUI
- All current tools — they become "Anthropic-model tools" but their definitions don't change
- `AuditWriter`, `ConfigLoader` — unchanged

## What changes

- `main.ts` splits dramatically: the agent binary's main constructs an Agent and a bridge; the TUI binary's main connects to the bridge and runs the TUI
- `AppLayout` moves to the TUI binary; loses the agent-side mutation surface entirely
- `AgentMessageHandler` becomes the TUI client's event handler
- `runAgent` / `runTurn` move into the in-agent Orchestrator
- `systemReminder` becomes a `TurnInjector`, not a parameter on five interfaces
- Tool handler signature gains `(input, { signal }): Promise<Output>`
- The Agent no longer holds a `Conversation` directly; it holds a model object that contains it
- `buildRequestParams` is no longer a top-level SDK export; it's part of `AnthropicConversationModel`
- `AgentMessage` gains a `from: AgentIdentity` field

## Migration shape

Not a rewrite. A series of extractions:

1. Define the wire protocol — `AgentEvent`, `AgentMessage` (with sender identity), the JSON schema
2. Build the `Agent` class as a wrapper exposing the public duplex surface; `main.ts` keeps constructing AppLayout against it for now (in-process, temporarily)
3. Move `Conversation` ownership from the Agent class to a new `AnthropicConversationModel` class. `buildRequestParams` moves into the model. No behaviour changes.
4. Extract the in-agent Orchestrator with the existing injectors; replace `systemReminder` parameter threading with the injector list
5. Build the stdio bridge. Validate the protocol end-to-end with a JSON-line script.
6. Split the TUI into its own binary
7. Build the NATS bridge
8. Add multi-subscriber support to the Agent once a second concurrent client matters
9. Define and ship reactive tool primitives (used by Workspace model, Tower integration)
10. When the second agent model is needed: extract `AgentModel`, refactor the loop, write the new model

The steps are independently shippable.

## Open questions

- **Approval policy for autonomous runs.** Today the CLI auto-approves reads. Where does that policy live for headless agents? Probably: in the Agent's config, so the same policy applies regardless of who's connected. Revisit if a use case demands per-client policy.

- **Tool handler cancellation contract.** When the signal aborts, what does the handler do? Define a `ToolCancelledError` and have the registry handle it as an error event.

- **Backpressure on slow consumers.** If one subscriber's queue grows faster than it drains, what happens? Drop oldest events with a warning for ephemeral events; never drop `approval_request`. Per-event-type policy may be needed.

- **Reactive tool lifecycle.** When does a subscription get closed if the model never explicitly closes it? Probably: model decides, but the SDK provides a clean shutdown path.

- **History snapshot stability across model versions.** Add-only changes are safe; incompatible changes need a version field. Lean toward add-only discipline.

- **How mission content reaches agents without shared filesystem.** Today missions are files on disk that all roles can read. In a Tower deployment where the orchestrator and agents are on different hosts, mission content needs another path: attached on each delivery, fetched from a content-addressed store, or pulled via a Tower API. Deployment concern, not protocol concern.
