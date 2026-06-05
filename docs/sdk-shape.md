# SDK shape

## What this refactor does

Two concerns, related but distinct:

1. **Add the agent session concept to the SDK.** Before this refactor, the SDK has no way to run an ongoing conversation with the model across queries. Every call rebuilds the full context from the caller's hands. After this refactor, the SDK runs the agent session pattern: the consumer holds a Conversation, and the SDK mutates it as turns happen by pushing the user message, the assembled assistant message, and the tool results into it on the consumer's behalf. The consumer supplies only what genuinely changes per turn: the new user message, the optional one-shot system reminder, the optional per-query transform hook, the abort controller. Persistence across process restarts stays with the consumer: the SDK holds the Conversation in memory, and if the consumer wants to save and restore a session across process restarts, it reads the messages out of the Conversation itself and pushes them back in on next startup. Today the default consumer is the CLI at `apps/claude-sdk-cli`.

2. **Make the SDK stateful.** Before this refactor, every call to `runAgent` reconstructs a runner object, a control channel, an approval coordinator, and the turn-loop state, even though none of those need to be reconstructed per call. After this refactor, the Client, Tool registry, Control channel, and Approval coordinator are stateful blocks held by the consumer across its SDK usage. The consumer constructs each one once and reuses it on every query. This concern is distinct from the agent session concept; a stateful SDK would be valuable even without the session pattern (a consumer making many one-shot calls still benefits from reusing a single Client and a single Tool registry). The refactor addresses both in the same work because they touch the same code.

Everything else in this document is consequence of those two concerns. If you read something later that does not follow from them, the plan is wrong and needs fixing.

## What an agent session is

Read this section before anything else in this document. Every other section assumes you already know what "agent session" means here.

### What an agent session IS

An **agent session** is a usage pattern of the SDK. Specifically: the SDK holds a Conversation across queries and mutates it as turns happen, so the caller does not have to rebuild the message list on every call.

The motivation is the thing that makes talking to a language model different from calling any other API. The model has no memory of prior interactions except what you put in the messages you send. If you want the model's next answer to build on the previous one, the previous question and the previous answer both have to be in the messages on the next request. Over many turns this builds up a message list that grows with each exchange. Somebody has to maintain that list. With the agent session pattern, the SDK maintains it. Without the pattern, the caller maintains it.

The SDK's part of the pattern is a small handful of push sites inside the turn runner, which is why the concept takes so little code to add. See "What code would change if the agent session concept were added or removed?" below for the operational definition.

### What an agent session is NOT

- **Not an HTTP session.** No login state, no cookie jar, no server-side session tracking, no session-scoped authentication.
- **Not a database session.** No unit of work, no identity map, no transaction boundary, no commit.
- **Not a REPL or shell session.** No command history in the framework sense, no environment variables, no per-session process.
- **Not a class in the SDK.** There is no `Session` object you construct and dispatch method calls through. No `session.query(input)`. No `session.configure(partial)`.
- **Not a bundle of SDK blocks.** The Client, Tool registry, Control channel, Approval coordinator, and the rest are not "the session" and are not "session-scoped". They are SDK infrastructure that exists in the without-concept case too. The agent session is about how the SDK uses those blocks on the caller's behalf, not a container for them.
- **Not a session id.** The SDK does not assign, track, store, or reason about identifiers for agent sessions. If the consumer wants to tag sessions for its own purposes, that is a consumer concern.
- **Not a session file.** The SDK does not read or write agent session data to disk. If the consumer wants to persist an agent session across process restarts, the consumer does the file I/O.

Wherever "session" appears in this document without "agent" in front of it, read "agent session". If the substitution does not work in context, the wording is wrong and should be fixed on the spot.

### What code would change if the agent session concept were added or removed?

A small handful of lines in the SDK's turn runner:

- At the start of a query: push the user message into the Conversation.
- After each stream completes: push the assembled assistant message into the Conversation.
- After each tool execution: push the tool-result message into the Conversation.

That is all the concept adds to the SDK. Three push sites, all inside the turn runner, all mutating the Conversation on the caller's behalf.

**With the concept.** The caller holds a Conversation, passes a new user message per query, and the SDK runs the full turn loop, pushing the assistant and tool_result messages into the Conversation as they happen. The `run` call returns when the query is done.

**Without the concept.** The caller runs one turn at a time. It holds its own message list. It calls the SDK with the list, gets back the assembled assistant message, runs any tools itself or asks the SDK to run them, appends the tool_result to its own list, and calls the SDK again for the next turn. The turn loop lives in the caller, because there is no Conversation for the SDK to push into.

Tools still work in the without-concept case. The caller can still pass tool definitions, the turn runner can still parse `tool_use` blocks from the assistant message, the tool registry can still execute tools, the approval coordinator can still gate them. None of that depends on a Conversation being held by the SDK. It only means the caller is responsible for threading the message list through each turn and running the loop itself.

Everything else in the SDK is unchanged by this distinction. Client, Tool registry, Request builder, Stream processor, Approval coordinator, Control channel all exist either way and behave the same either way. The agent session concept is only about whether the SDK or the caller maintains the message list between turns, and whether the turn loop lives inside the SDK or outside it.

Tests that would change if you removed the concept: a small cluster that asserts Conversation mutation during a query (the user message lands, the assistant response lands, the tool results land, the Conversation grows correctly across turns). Everything else in the test suite is orthogonal.

## The problem this refactor fixes

Three problems, all addressed by this refactor. They are distinct: each one would be worth fixing on its own, and they happen to touch the same code, which is why they are being fixed together. Do not read them as three consequences of one root cause; they are three different things that happened to be wrong at the same time.

### Problem 1: the SDK did not mutate the Conversation

Before this refactor, the SDK has no way to run the agent session pattern. The caller supplies the full message list on every call. The SDK processes it, runs the turn loop, and returns. The caller then takes the assistant response and any tool_result messages and appends them to its own message list before the next call.

This works but is the wrong division of labour. The SDK is the thing that knows how to talk to the model. It owns the Conversation block. Asking the caller to maintain the message list in parallel is asking the caller to reimplement the SDK's own job.

The fix is to let the SDK mutate the Conversation on the caller's behalf. The caller holds a Conversation and passes it on every query. The SDK pushes the user message, the assistant response, and any tool_result messages into it as the turns unfold. On the next query, the SDK reads the existing messages from the Conversation and uses them without the caller having to supply anything. The caller never has to manage the message list by hand. This is what the "What an agent session is" section above means by "the agent session pattern".

### Problem 2: the SDK was stateless

Before this refactor, every call to `runAgent` takes a full options object with roughly fifteen fields: `model`, `tools`, `betas`, `systemPrompts`, `maxTokens`, `thinking`, `cacheTtl`, `cachedReminders`, `requireToolApproval`, `pauseAfterCompact`, `compactInputTokens`, `transformToolResult`, `messages`, `systemReminder`. Almost none of those fields change between calls. The model is the same. The tools are the same. The system prompts are the same. The cache settings are the same.

The caller has to re-supply every field on every call because the SDK is stateless: it has no place to hold any of these values between calls. Every call also reconstructs a runner object, a control channel, an approval coordinator, and the turn-loop state, even though none of those need to be reconstructed per call. This is wasteful at runtime and a source of drift in code: per-call reconstruction invites per-call state accumulation, which invites per-call bugs.

The fix is to make the SDK stateful. The Client, Tool registry, Control channel, and Approval coordinator are held by the consumer across its SDK usage and reused on every query. The consumer constructs each one once and passes it to every query. Only the abort controller and the per-query input are constructed per query. A stateful SDK is valuable independent of the agent session concept; a consumer making one-shot calls still benefits from reusing a single Client and a single Tool registry instead of rebuilding them on every call.

### Problem 3: the SDK was reading and writing files for conversation data

The old SDK has a `ConversationStore` that knows about history file paths. It has an `AnthropicAgentOptions.historyFile` field that forces every consumer to opt in to SDK-managed persistence. A parallel branch was adding a `RawEventWriter` and an `AuditWriter` that call `mkdirSync` and `appendFileSync` from inside the SDK. All of that is wrong.

The SDK is a library for talking to the Anthropic API. It should not touch the filesystem for conversation data. Every file path, every `fs` call, every "where does this go on disk" decision belongs to the consumer. The SDK exposes the Conversation as an in-memory block and provides operations to read messages out of it and push messages back into it. What the consumer does with those messages (saves them, prints them, streams them to a database, throws them away) is the consumer's concern.

The one pragmatic exception is credential storage for the Anthropic API: the OAuth token file lives inside the Client block. That is access to the API, not conversation data, and it is the only file I/O the SDK does. Everything else (conversation history, audit logs, resumable session directories, CLAUDE.md, config files) is consumer concern.

## Principles

These are the design principles the SDK follows after the refactor. Each is derived from the agent session concept or from the two problems above. If a proposed change would require relaxing one of these principles, the change is probably wrong.

**Substitution, not optionality.** Composability means a consumer can replace a block with their own implementation of the same responsibility. It does not mean every block ships an on-off switch. The defaults are the full feature. If a consumer does not want the default, they write their own. We do not degrade the defaults to offer "lite" versions.

**Substitution happens through behavioural interfaces.** Each block is defined by an interface (or an abstract class) whose behavioural contract is stated in prose on the type itself. Concrete classes implement the interface. A consumer substitutes a block by writing their own implementation of the same interface, and the contract tells them what a correct implementation must do on success, on error, on cancel, on partial data, on out-of-order events. Liskov substitution applies. "Same shape" at the type level is not sufficient. The contract is behavioural and lives on the interface, not only in this document.

**Not every helper is a block.** The blocks named in this document are the responsibility boundaries and substitution surfaces. Helpers, utilities, and internal collaborators that live inside a block's implementation are wiring, not blocks in their own right. Composability is the goal for the blocks, not an obligation for every file.

**The SDK understands the API. It does not understand the filesystem.** The SDK knows about Anthropic's message rules, compaction semantics, cache markers, streaming shapes. It does not know about file paths, directories, save locations, or where anything lives on disk. Those are consumer concerns. The one pragmatic exception is the credential file inside the Client block, because it is API access and not agent session state.

**Config describes usage, not API shape.** The consumer says what feature they want turned on and how they want it to behave. The SDK works out the API-level details: the beta header, the field on the request body, the accepted value range, the places cache markers go. The consumer should not have to know that enabling server compaction requires both a specific beta flag on the headers and a specific field on the body. They say `compaction: { enabled: true, inputTokens: 100000, pauseAfterCompact: true }` and the SDK emits both. Thinking, cache TTL, cached reminders, tool approval, and every similar feature follow the same rule: one grouped option per feature, named after the feature. A raw `betas` field still exists as an escape hatch for features the SDK does not yet understand, but it is the exception, not the primary surface.

**Two-way messaging over `MessagePort` is wiring, not wrapping.** The control channel exists because the SDK's default control blocks (approval, cancel) need bidirectional id-correlated message exchange without every call site sprouting callbacks. It is part of the default assembly. If a consumer replaces the blocks that use it with their own, the channel goes away with them. The channel is not framed as an optional wrapper around something else.

**Observation and control are separate surfaces.** Read-only observation (raw events, assembled messages, deltas, lifecycle) happens through `.on(...)` subscriptions on the long-lived blocks that emit events, set up once by the consumer at SDK setup time. Control (approvals, cancel) happens through the Control channel, also set up once. Different jobs, different surfaces, both set up once at setup and never touched again.

**The consumer owns the Conversation.** The Conversation is a block the consumer can read and modify directly. Push, remove, replace, read wire view, read full history are all operations the consumer can call. The SDK does not grow new helpers every time the consumer wants to do something new to the Conversation; the consumer composes with the block directly. This is the second bullet of the refactor in practice: the consumer reads messages out of the Conversation, writes them wherever, and on restart constructs a fresh Conversation and pushes the saved messages back in.

**Stateful SDK, not per-call reconstruction.** Blocks that hold state are constructed once and reused across queries. The Client (auth, connection pool), the Tool registry (compiled schemas), the Control channel (port pair), and the Approval coordinator (pending map) are stateful blocks. The Conversation and the durable config are also held across queries by the consumer. Only the abort controller and the per-query input are constructed per query. This is a separate concern from the agent session concept; a stateful SDK would be valuable even in the one-shot case, and the refactor would make sense even without the session pattern. Per-query object churn was a symptom of the SDK being stateless, not of the session concept being missing.

**The plan describes shape, not a feature list.** Block descriptions name where responsibilities would live once they exist. If the current code does not have a capability the plan describes, the refactor creates the block and preserves the current behaviour; it does not add the missing capability. New capabilities are follow-up work, not refactor scope. This principle applies to the plan as a whole: reading the plan as a feature checklist and trying to implement everything it names is a failure mode. The plan is a shape statement.

## The blocks

A **block** is a named responsibility boundary in the SDK. Most blocks are classes with methods. Some are pure functions. A few are named logic that lives inside other code and has no constructed instance of its own. The word "block" is about responsibility, not about "everything must be a class".

Each block below is described as what it is FOR first, then what it DOES, then what it is NOT. A reader should be able to read the "for" sentence alone and derive the rest. If that is not the case, the block description is unclear and should be fixed.

### There is no "Session" block

The agent session is not in this list. This is deliberate, not an oversight.

The agent session is not a block. It is what the blocks operate on. Specifically, an agent session is:

- a **Conversation** (described below as a block), plus
- a **durable config** (not a block; a plain data object the consumer builds from its own settings).

The consumer holds both as long-lived fields for the life of the agent session. There is no wrapping class that bundles them. There is no `Session` class anywhere in the SDK. A reader coming to this block list looking for "Session" should read the "What an agent session is" section at the top of this document instead.

The earlier version of this plan had a Session block in this list that described a class bundling Client, Conversation, and durable config. That description was wrong and cost five hours to unwind. See "Why this plan is written this way" at the end of this document for the full explanation of why it is now gone.

### Client

**For.** Talking to the Anthropic API over HTTP.

**Does.** Owns authentication: token acquisition, OAuth flow, token refresh. Owns HTTP transport. Owns client-identifying headers: the `User-Agent`, the Anthropic SDK version headers, and similar "who is calling" metadata that stays the same across every request. These are distinct from the `anthropic-beta` headers, which describe "what features this specific request is using" and are computed per request by the request builder from durable config. Takes a fully-formed request body and fully-formed request options (headers, abort signal, timeout) from the turn runner (which gets them from the request builder and merges the abort signal in) and sends them, adding its client-identifying headers on top. Returns a stream of raw Anthropic events for the stream processor to consume.

**Not.** Does not decide what goes in the request body or headers. Does not know anything about the agent session, the Conversation, or tools. Does not build requests. One instance per process is sufficient. Credential storage (reading and writing the OAuth token file) lives inside this block as the single pragmatic exception to "the SDK does not touch the filesystem", because it is access to the API and not agent session state.

### Conversation

**For.** Holding the in-memory message list of an agent session and enforcing the rules for valid conversation shapes.

**Does.** Knows alternation rules, compaction semantics, cache boundaries, message validation. Provides: push a message (validated), read the full history, read the wire view (deep-cloned, trimmed to the last compaction, cache-annotated, safe to mutate without corrupting storage), remove by id, replace by id, insert, clear. The consumer can call any of these directly. The turn runner calls push and read wire view during normal operation. The consumer's save and restore flow uses read (to save) and push (to restore).

**Not.** Does not know anything about disk. Does not read from files or write to files. Does not know about tools, approvals, or the request builder. The Conversation is the block the SDK mutates to run the agent session pattern; it is not "the session" itself.

### Stream processor

**For.** Turning a raw Anthropic event stream into meaningful output the consumer can consume at whichever level of detail it wants.

**Does.** Constructed once by the consumer at setup time. Parses deltas into blocks. Tracks per-TTL cache split. Tracks iteration counts. Tracks stop reasons and context management events. Assembles the final non-streaming-shaped message when the stream ends. Exposes `.on(...)` events (raw events, semantic deltas, per-block and per-message lifecycle, the assembled final message) that the consumer subscribes to once at setup. The same handlers fire for every stream the processor handles; the subscriptions outlive every stream and are never torn down and re-established per stream.

**Not.** Does not call the Client; the turn runner calls the Client and hands the raw event stream to the processor's `process` method. Does not push anything to the Conversation; the turn runner reads the assembled message from the processor and pushes it itself. Does not interpret tool schemas; the tool registry handles that. Not subscribed to per stream; the consumer subscribes once at setup.

### Request builder

**For.** Turning a durable config and a Conversation wire view into the exact request body and request options the Anthropic API expects.

**Does.** A pure function. Translates usage-level config (compaction, thinking, cache TTL, cached reminders, system prompts) into the combination of body fields, `cache_control` markers, and `anthropic-beta` header values the API actually requires. Applies the fixed SDK identity prefix `AGENT_SDK_PREFIX` to the system prompt; this is required by the Anthropic API for SDK calls, not a consumer policy choice, and not overridable. If an escape-hatch raw `betas` field is present in durable config, merges it on top of the computed betas.

**Not.** Not a class unless there is a specific reason. Holds no state. Does not know about the Client, the abort controller, or runtime wiring. Returns a `{ body, headers }` shape. The abort signal is merged into the request options by the turn runner, not by the builder, because the builder stays pure and does not know about cancel wiring.

### Tool registry

**For.** Holding tool definitions and executing tool uses when the model asks for them.

**Does.** Owns each tool's schema in both forms: Zod (source of truth for validation) and JSON Schema (what the request builder ships on the wire). Converts Zod to JSON Schema once when the tool is registered, not on every request. The public API is a two-step `resolve` then `run` pattern: `resolve(name, input)` looks up the tool, validates the input against the Zod schema, and returns either an error result (`not_found` or `invalid_input`) or a `ready` result carrying a `run(transform?)` closure. The closure captures the already-parsed input, so the query runner can hold it across the approval gate and invoke it after approval settles without re-parsing. This preserves the single-parse invariant from the original `AgentRun.#handleTools` code. The `run` closure calls the handler with the validated input, applies the optional per-query result-transform hook, converts the return value into an array of API content blocks, and returns them.

**Not.** Does not know about approval; that is the approval coordinator's job. Does not know about the Conversation. Does not know about the request builder. Does not construct full `tool_result` blocks; that requires knowing the corresponding `tool_use_id`, which only the query runner has seen. The registry returns the content; the query runner wraps it in the `tool_result` envelope. Just a callable catalogue with validation and format conversion.

### Approval coordinator

**For.** Mediating "can I run this tool?" between the SDK's default tool flow and the consumer's approval UI.

**Does.** Correlates outbound approval requests with inbound responses by id. Sends the request on the control channel. Parks the pending promise. Resolves it when the matching response arrives. Propagates cancel: if a `cancel` message arrives on the control channel, any pending approval is rejected and the query aborts.

**Not.** Does not take consumer callbacks. Its entire external surface is messages on the control channel. Does not know about the Conversation or the Tool registry. One instance per Control channel.

### Turn runner

**For.** Coordinating one turn of a conversation with the model. A turn is one request-and-response cycle between the SDK and the Anthropic API.

**Does.** The turn runner is constructed once by the consumer at setup time. Its constructor takes its dependencies (Client, Request builder, Stream processor, Tool registry, Approval coordinator) and holds them as instance state. After that it is reused on every turn via a `run` method. A turn is one request-and-response cycle between the SDK and the Anthropic API. Nothing more. The turn runner does not dispatch tools, does not construct `tool_result` messages, and does not decide whether to loop; those are the query runner's job.

It runs the following sequence:

1. Reads the Conversation wire view.
2. Calls the request builder to get `{ body, headers }` from the durable config and the wire view.
3. Merges the per-query abort signal into the request options. The request builder stays pure; the signal wiring lives here.
4. Calls the Client to stream the request. The Client returns an async iterable of raw Anthropic events.
5. Hands the iterable to the stream processor via `processor.process(rawIterable)`. The processor handles the stream internally; events fire on the `.on(...)` handlers the consumer already subscribed to at setup time. The turn runner does not subscribe or unsubscribe; the subscriptions outlive every turn.
6. Reads the assembled assistant message from the processor when the stream ends, and pushes it directly into the Conversation.
7. Returns the assembled assistant message and its stop reason to the caller (the query runner).

During a `run` call the turn runner holds local state in method-local variables: the assembled message reference, whether a cancel has been signalled. None of that state persists after the call returns. The instance itself only holds its constructor-injected dependencies.

**Not.** Not constructed per turn. Constructed once by the consumer at setup and reused for every turn via the `run` method. Does not dispatch tools; the query runner handles that between turns. Does not construct `tool_result` messages. Does not decide whether to loop. Does not subscribe or unsubscribe from anything per turn; the consumer's `.on(...)` handlers set up at startup fire naturally. Holds no per-turn or per-query state on the instance.

### Query runner

**For.** Coordinating one query: one user ask turned into however many turns the model needs to answer it.

**Does.** The query runner is constructed once by the consumer at setup time. Its constructor takes its dependencies (Turn runner, Conversation) and holds them as instance state. After that it is reused on every query via a `run` method. A query is one user ask turned into however many turns the model needs to answer it. The query runner owns the turn loop and the tool dispatch between turns.

It runs the following sequence:

1. Pushes the per-query user message into the Conversation. If a one-shot system reminder was supplied, applies it at this point too.
2. Enters the turn loop:
    a. Calls the turn runner's `run` method once. Gets back the assembled assistant message and its stop reason.
    b. If the stop reason is terminal (`end_turn`, `max_tokens`, `stop_sequence`), exits the loop.
    c. If the stop reason is `tool_use`, dispatches each `tool_use` block in the assembled message. For each: if approval is required, calls the approval coordinator and waits for the response; calls the tool registry with the tool name and input, gets back an array of content blocks; applies the per-query transform hook to the content if one was supplied; wraps the content in a `tool_result` block with the corresponding `tool_use_id`. After all `tool_use` blocks in this turn are processed, assembles a user-role message carrying the `tool_result` blocks and pushes it into the Conversation. Loops back to step 2a to run the next turn.
    d. Between iterations, checks whether cancel has been signalled. If it has, exits the loop.
3. Returns when the loop exits. The consumer awaits the `run` call directly; events during the query fire on the `.on(...)` handlers the consumer subscribed to at setup.

During a `run` call the query runner holds local state in method-local variables: the current turn number, the retry counter, the cancel flag, the pending tool uses being dispatched. None of that state persists after the call returns. The instance itself only holds its constructor-injected dependencies.

**Not.** Not constructed per query. Constructed once by the consumer at setup and reused for every query via the `run` method. Does not return a query handle; there is no such thing. The consumer already holds the Control channel (for cancel), the event-emitting blocks (for observation via `.on(...)`), and the query runner itself (for the call). There is nothing to bundle into a handle.

### Control channel

**For.** Bidirectional id-correlated message exchange between the SDK's default control blocks (approval, cancel) and the consumer's UI.

**Does.** Wraps a `MessagePort` pair. Provides a `send` surface the approval coordinator uses outbound, and an inbound dispatcher that routes messages to the approval coordinator for approval responses or to the abort controller for cancels.

**Not.** Not a user-facing abstraction. Not an optional wrapper around something else. Wiring used by the default control blocks. If a consumer substitutes those blocks with their own implementations that do not need two-way messaging, the control channel goes away with them.

## Lifetimes

The refactor's second concern (stateful SDK) means every block in this document has a specific construction lifetime. Here is exactly what lives how long and why. A block's "For / Does / Not" description is about its responsibility; its entry in this section is about when it is constructed and how long it sticks around.

**Constructed once at consumer setup.** The consumer constructs each of these once, at startup, and reuses them for the life of the process. If the consumer wants multiple independent conversations, it constructs multiple of each; the SDK does not multiplex.

- **Client.** The auth state, the HTTP connection pool, and the client-identifying headers are all worth sharing across every request. One per process is typical.
- **Tool registry.** Tool registration has a real cost: Zod-to-JSON-Schema conversion, handler reference capture, schema validation setup. Paid once per tool at registration.
- **Stream processor.** Holds its `.on(...)` subscriptions as instance state. The consumer subscribes once at setup and the same handlers fire for every stream. Per-stream state (partial assembled message, cache split tracking) lives in the `process` method's local variables.
- **Turn runner.** Holds its constructor-injected dependencies (Client, Request builder, Stream processor, Tool registry, Approval coordinator) as instance state. The `run` method runs one turn per call; per-turn state lives in method-local variables.
- **Query runner.** Holds its constructor-injected dependencies (Turn runner, Conversation) as instance state. The `run` method runs one query per call; per-query state lives in method-local variables.
- **Conversation.** The in-memory message list the SDK mutates under the agent session pattern. Constructed once at setup and held for the life of the process.
- **Durable config.** The settings for queries: `model`, `betas`, `systemPrompts`, `cacheTtl`, `cachedReminders`, `compaction`, `approvalMode`, `thinking`, `maxTokens`. Not a block; a plain data object the consumer builds from its own settings and reuses across queries.
- **Control channel.** A two-way `MessagePort` pair. One per consumer UI that handles approvals and cancels. A consumer that does not use default approval or cancel can omit the channel entirely.
- **Approval coordinator.** Bound to a Control channel at construction; one per channel.

**Per-query.** Constructed when the query starts, discarded when the query finishes. The only things that genuinely differ per query.

- **Abort controller.** One per query so each query can be cancelled independently.
- **Per-query input.** A plain data object the consumer builds for this one query: the user message, the optional one-shot system reminder, the optional per-query transform hook, the abort controller.

**Pure function.** Called per use, no construction, no state.

- **Request builder.** A pure function. Called once per turn by the turn runner. Holds no state.

### The distinguishing rule

Every block in the SDK is constructed once by the consumer at setup time and reused for the life of the process. The only per-query things are the abort controller and the per-query input data, neither of which is a block. The only thing that is not constructed at all is the request builder, because it is a pure function.

The consumer never subscribes to anything more than once. Every `.on(...)` call happens at setup; every event handler fires for the life of the process. Per-query or per-turn subscription setup and teardown is the anti-pattern this refactor is removing.

## What the consumer does

"The consumer" is whatever code uses this SDK. Today the default consumer is the CLI at `apps/claude-sdk-cli`. For any other consumer, read "CLI" below as "whatever holds the SDK".

### Setting up the SDK

At startup, the consumer does these things in order:

1. Construct the auth helper (today this is `AnthropicAuth`, living inside the Client block's namespace post-refactor). Call `getCredentials()` eagerly to force login if no credentials are stored locally. Wrap the result in a token-source closure that returns the current access token on each call.
2. Construct a Client, passing the token source.
3. Construct a Conversation. The consumer owns it; the SDK mutates it during a query to push user messages, assistant responses, and tool results. If the consumer is restoring saved messages from a previous process, it sets the initial history at this point.
4. Construct a Tool registry and register the tools the consumer wants available. The registry converts Zod to JSON Schema once per tool at registration time.
5. Construct a Control channel (a `MessagePort` pair).
6. Construct an Approval coordinator bound to the control channel.
7. Build a durable config object from the consumer's settings. Its fields are: `model`, `betas`, `systemPrompts`, `cacheTtl`, `cachedReminders`, `compaction`, `approvalMode`, `thinking`, `maxTokens`. Note that tools are NOT in durable config; tools live in the Tool registry.

The consumer holds all of the above as long-lived fields across its SDK usage. Each block is constructed once and reused on every query. None of them is "the session". The session pattern is what happens when the consumer holds a Conversation across queries and lets the SDK mutate it as turns happen; it is not a set of objects. A consumer not using the session pattern (making one-shot calls) would still hold the same blocks, just with a Conversation that is constructed and discarded per call.

### Running a query

On each user input, the consumer calls `queryRunner.run(...)` and awaits the return. The `run` method takes the per-query input:

- the user message
- the optional one-shot system reminder
- the optional per-query transform hook
- a fresh abort controller

Everything else the query needs (Client, Conversation, Tool registry, Stream processor, Turn runner, durable config, Control channel, Approval coordinator) is already held by the query runner and its dependencies, all constructed once at setup. The consumer does not pass them per query.

Events fire during the query on the `.on(...)` handlers the consumer subscribed to at SDK setup time. Nothing is subscribed or unsubscribed per query. If the consumer wants to cancel, it posts a cancel message on the Control channel it also set up at startup. There is no query handle, no per-query subscription, no per-query object to hold on to. The `run` call returns when the query is done.

The exact method signature (positional arguments, options object, something else) is still an open decision, but whatever shape it takes, it constructs no per-query objects other than the four per-query input fields listed above, and it does not return any new subscription surface.

### Saving and restoring the conversation

The SDK does not save or restore conversations. The consumer does, if it wants to. The only thing that needs saving is the messages in the Conversation. The durable config, the Tool registry, the Client, and every other block are reconstructed from the consumer's own code when it runs the Setting up steps again; they are not saved data, they are CLI state that gets reloaded at startup.

**To save.** Read the messages out of the Conversation (via `conversation.messages` or the read-full-history operation), serialise them however the consumer wants, and write them wherever the consumer wants. A JSON file is fine. A remote database is fine. Nothing at all is fine.

**To restore.** On the next startup, run through the Setting up steps as normal. At step 3 (construct a Conversation), push each saved message into the fresh Conversation one by one; the Conversation validates each push. That is the entire restore flow.

The SDK does not supply file I/O helpers. The SDK does not supply `save` or `load` methods on the Conversation or any other block. The SDK gives the consumer a Conversation it can read messages out of and push messages into, and trusts the consumer to do the rest.

## What is not in the SDK

If any of these slip back in during the rewrite, the rewrite has drifted and the drift should be backed out.

- **Session ids.** The SDK has no concept of a session identifier. If the consumer wants to tag agent sessions (for its own save and restore, for its UI, for audit), that is a consumer concern.
- **Session files.** No JSONL, no session directories, no atomic writes, no load-on-construct. The consumer does any file I/O for saved sessions.
- **Audit files.** No `RawEventWriter` inside the SDK. No `AuditWriter`. Audit is a consumer that subscribes to the SDK's long-lived event-emitting blocks at setup time via `.on(...)` and writes wherever it wants.
- **`historyFile` as a configuration field.** Not on any block, not on any constructor, not on any options object.
- **File system calls for agent session data.** `mkdirSync`, `appendFileSync`, `readFileSync`, `writeFileSync`, `renameSync` do not appear in any SDK source file except inside the Client block's credential storage helpers, which are the single pragmatic exception described above.
- **CLAUDE.md loading, config file loading, any other file-based input.** Consumer concern.
- **A top-level `Session`, `Agent`, or `AgentSession` class that bundles the blocks.** The SDK does not provide a wrapper class. A convenience factory function (for example `createDefaultAgent`) that constructs the default blocks and returns them is a reasonable addition in a later change; it is not a class and does not own the blocks, it only saves a few lines of setup code. Not in scope for this refactor.
- **`session.query(input)` or any equivalent method on a bundle-class.** The consumer calls the SDK's query entry point directly with the collaborators and the per-query input.
- **Per-query construction of stateful blocks.** The Client, Tool registry, Control channel, Approval coordinator, Conversation, and durable config are constructed once by the consumer and reused across queries, not reconstructed per query.
- **`ConversationStore`.** Deleted. Its history-file responsibility goes away. The `Conversation.load()` method that `ConversationStore` was the sole runtime caller of goes away with it as dead code.
- **Fourteen-field `RunAgentQuery` options object.** Deleted. The durable fields move into the durable config. The per-query fields (user message, one-shot system reminder, per-query transform hook) stay on the query call. Tools move into the Tool registry.

## Glossary

These terms have precise meanings in this document. Where they appear without qualification, they mean exactly what is listed here. Substituting a near-synonym is wrong and will drift the design.

- **Agent session.** One ongoing conversation with an Anthropic model, built up across many turns. Specifically: a Conversation (the in-memory message list) plus a durable config (the settings that do not change between turns). Held in memory by the consumer for the life of the process. Not a class. Not a file. Not a session id.
- **Conversation.** The in-memory message list of an agent session, plus the rules for valid push and read operations. One of the two parts of an agent session. A block in the SDK.
- **Durable config.** The settings of an agent session that stay the same across turns: `model`, `betas`, `systemPrompts`, `cacheTtl`, `cachedReminders`, `compaction`, `approvalMode`, `thinking`, `maxTokens`. One of the two parts of an agent session. NOT a block; a plain data object the consumer builds from its own settings. Does NOT include tools; tools live in the Tool registry.
- **Query.** One user ask against an agent session, running as many turns as the model needs to answer it. Starts by pushing the user's message into the Conversation. Ends when the model stops or the query is cancelled.
- **Turn.** One request-and-response cycle within a query. Builds a request from the current Conversation wire view, streams the response, handles any tool uses, pushes the assembled messages into the Conversation. One query is usually many turns.
- **Consumer.** Whatever code uses this SDK. Today the default consumer is the CLI at `apps/claude-sdk-cli`.
- **Per-query input.** The fields that legitimately change on every query: the user message, the optional one-shot system reminder, the optional per-query transform hook, the abort controller. Everything else (the Client, the Conversation, the Tool registry, the Control channel, the Approval coordinator, the durable config) is held by the consumer and reused across queries.
- **Per-query transform hook.** The optional `transformToolResult` function the consumer can pass per query to rewrite tool result blocks before they are pushed into the Conversation. Per-query and not durable because a "fetch file" query and a "show status" query may legitimately want different transforms.
- **Control channel.** The two-way `MessagePort` pair used by the default Approval coordinator and the cancel mechanism. Wiring, not a user-facing abstraction.
- **Block.** A named responsibility boundary in the SDK. Usually a class, sometimes a pure function, sometimes named logic inside other code. Substitutable by the consumer through behavioural interfaces.
- **Wire view.** A deep-cloned, compaction-trimmed, cache-annotated copy of the Conversation's messages, safe to hand to the request builder. Distinct from the full history, which may include pre-compaction messages the API should not see.
- **Stateful block.** A block in the SDK that holds state and is constructed once, then reused across queries by the consumer. The Client, Tool registry, Control channel, and Approval coordinator are the main stateful blocks. Stateful blocks are not scoped to agent sessions; their lifetime is the consumer's choice and they exist whether or not the session pattern is in use.
- **Per-query.** Scoped to a single query: constructed when the query starts, discarded when the query finishes.

### Words NOT to use without qualification, and what to use instead

The words in this list invite wrong substitutions. They are banned in this document. Where one of them would naturally appear, use the replacement. This list exists because the earlier version of this plan used several of these words unqualified and the resulting ambiguity cost five hours. See "Why this plan is written this way" for the full story.

- **"Session" on its own.** Ambiguous. A fresh reader matches it to HTTP session, database session, or framework session, which are all wrong. Use **"agent session"** every time.
- **"State" on its own, meaning the agent session.** Too abstract, and misleading because the agent session is a usage pattern, not a state object. If you mean the pattern, say **"the agent session pattern"**. If you mean the Conversation the SDK is mutating, say **"the Conversation"**.
- **"The agent" on its own, meaning the SDK.** "The agent" in this problem space is the model, not the library. Use **"the SDK"** when you mean the library.
- **"The agent" on its own, meaning an agent session.** Same ambiguity. Use **"the agent session"** when you mean the session.
- **"Context" on its own.** Has too many meanings in language model work: prompt context, context window, a context object in the programming sense, conversation history. Use **"the message list"**, **"the conversation history"**, or **"the context window"** depending on what is specifically meant.
- **"The runner" on its own.** Ambiguous between the turn runner and the query runner. Use the specific name.
- **"The channel" on its own.** Ambiguous between the control channel and streams from the Client. Use **"control channel"** when you mean the MessagePort pair.
- **"Bundles" or "wraps" when describing blocks.** The earlier plan said "Session bundles client + conversation + durable config" and the word "bundles" primed the reader to expect a wrapper class. If you find yourself reaching for "bundles", the thing you are describing is probably not a block; it is probably the consumer holding collaborators as fields. Say "the consumer holds" instead.
- **"Agent-session-scoped" or "session-scoped" when describing blocks.** Wrong framing. The Client, Tool registry, Control channel, and Approval coordinator are not scoped to agent sessions; they exist whether or not the session pattern is in use. Use **"stateful block"** or **"held by the consumer across queries"** instead. The bundle framing (Session bundles these collaborators) is the error this ban list exists to prevent.

## Why this plan is written this way

This plan exists in its current form because an earlier version of it failed in a specific and expensive way, and the failure mode has to be named if the plan is going to carry the refactor forward without repeating the failure. This section is not an abstract warning. It is a concrete description of the failure and the concrete fixes that prevent it.

### The failure

The earlier version of this plan described the agent session concept as a class called `Session` that "bundles client + conversation + durable config" and "provides `query(input)` returning a query handle, `configure(partial)` to update durable config mid-session, direct access to `conversation`, `config`, and `client`". The instance that wrote that description held the agent session concept in its head. It wrote the class shape the concept was going to take, and trusted the concept to ride along inside the class-shape words, because the concept felt obvious to the author and did not feel like something that needed explaining.

Then that instance ended. The concept ended with it.

A later instance read the plan cold. It found a class description (`Session` bundles X, provides Y, exposes Z) with no concept attached, no domain anchor, no definition of what a "session" meant in this problem space. The later instance reconstructed a concept to fit the class shape, and the concept it reconstructed was framework-session: a live object that owns collaborators and dispatches operations, like an HTTP session or a database session. That reconstruction was entirely wrong and completely internally consistent with the class shape it was working from. The later instance then spent ten file walks, a thousand lines of session log, and fifteen commits refining a model of the SDK that was structurally pointed at the wrong concept.

The error was detected in a conversation when the human kept trying to correct the direction and the AI kept translating each correction into a mechanical refinement of the wrong model. Every clue the human gave ("accumulation of messages", "session is a state", "persist and hydrate only in the CLI", "the thing I am talking to") was pointing at the same concept and was read into the wrong domain. The AI built a polished and articulate wrong answer because the concept it was polishing was not the right concept at all.

Fixing the error cost roughly five hours of real-time back-and-forth, during which the human had to hold the correct concept in memory and feed it into the conversation piece by piece until the AI stopped pattern-matching and started listening to the actual domain. That cost is the thing this plan exists to prevent next time.

### The instance-continuity problem under the failure

Plans in this project have to carry concepts across instance boundaries. Every instance that reads the plan is a fresh reader with no memory of the plan's author. A plan that works for its author and fails for a fresh reader is a plan that works for no one except the author, and the author is the one person who does not need the plan.

The instance that writes a plan is the worst reviewer of its own plan, because it still holds the concepts the plan is supposed to carry. Whether a plan carries its concepts across instance boundaries can only be verified by watching a fresh instance read it. That verification is expensive: it has to happen in real time, on a real refactor, with a real human standing by to catch the failure mode as it unfolds. The five hours above IS that verification for this plan. The cost has been paid once. The rules below exist so the cost is not paid again on this same refactor.

The instance that writes the plan is not careless, and the instance that reads the plan is not stupid. The failure is structural: concepts that live only in the author's head do not travel on text that describes class shapes. They have to be written down explicitly, in domain vocabulary, before any class shape is introduced that might invite a wrong reconstruction.

### The rules this plan follows

Each rule below is a concrete fix for a concrete failure mode. Abstract rules did not save the earlier plan. Concrete rules have a chance.

1. **State the refactor's actual goals at the top, verbatim, in plain English, before any other prose.** A reader who reads only the first section should know what the refactor does. This plan's first section is two bullets.

2. **Define every domain term on first use, and collect definitions in a glossary.** "Agent session", "Conversation", "query", "turn", "durable config", "wire view" all have definitions. Where they appear in the body they mean what the glossary says. Nothing else.

3. **Ban ambiguous substitutions explicitly.** The glossary has a "words NOT to use without qualification" list that names the exact substitutions the earlier plan fell into and pins the replacements. "Session" without "agent" is banned. "State" meaning the agent session is banned. "Bundles" and "wraps" when describing blocks are banned. If a future instance finds itself typing one of these words, it should stop and use the replacement.

4. **Describe concepts before describing shapes.** Every block description opens with "what it is FOR". The reader understands the purpose first and derives the methods from the purpose. A reader who only has the methods will reverse-engineer a purpose that may not match, which is exactly how the earlier Session block misled its later readers.

5. **Mark non-classes and non-blocks explicitly.** If a block is a pure function or named logic and not a long-lived object, its description says so. If a thing is data and not a block, it is kept out of the block list and explained elsewhere. The agent session itself is called out at the top of the block list as "not a block" so a reader scanning the list for it does not build a Session class in their head.

6. **Write the reasoning, not just the decision.** Every significant decision in this plan should be legible as "X because Y". If a later reader cannot find the Y, the decision is ambiguous and can drift. Detailed reasoning for individual design decisions lives in the session log at `.claude/sessions/`; this plan summarises the outcomes that matter for implementation and points at the log for the reasoning. The link between plan and log is deliberate: the plan carries the shape, the log carries the reasoning that produced the shape.

7. **The plan is not the code.** Plan text is a model of intent. Code is the current state of the system. They can disagree. When they disagree, either the plan is wrong (and should be updated) or the code is wrong (and should be fixed by the refactor). Walking the gap between them is what the refactor DOES. The plan is never refactored to match the code; that is how planning dies.

8. **The plan is also sometimes wrong.** A rule that emerged from the five hours above: the plan is a confusion-prevention document, not a spec. It can contain errors. Finding one is a legitimate outcome of doing the work. The correct response is to fix the plan in the same commit as the realisation, with the reasoning recorded, not to work around the error in code.

### Why abstract warnings are not enough

The earlier version of this plan had a "Why this plan is written this way" section that warned about exactly this failure mode in abstract terms: "the why had to be reconstructed from memory by the person who still held it". That warning was true. It was also written by the same instance that then, one section later, produced the Session block description that required the why to be reconstructed from memory. The warning did not save the section that came after it, because the warning was abstract and the Session block was concrete, and concrete drift always wins over abstract warnings.

This section is different. The rules above are concrete. The glossary is concrete. The ban list is concrete. The "not a block" callout at the top of the blocks list is concrete. Every fix has a specific failure mode it addresses.

If the next instance reads this plan and still produces a framework-session model or any other wrong reconstruction, one of those concrete fixes has failed and the plan needs a new concrete fix, not another abstract warning. If a future instance is tempted to add an abstract warning about drift: add a concrete fix instead. A glossary entry. A ban-list item. An "is NOT" bullet. A reasoning line on the decision. Concrete things survive across instance boundaries. Abstract warnings do not.

The `#232` framing from an earlier iteration of this refactor also appears in code comments, for example the class JSDoc on `AnthropicClient.ts`. These references should be updated as the refactor touches each file, to point at this plan file instead.
