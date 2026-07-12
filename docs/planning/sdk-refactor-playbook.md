# SDK refactor playbook

## What this document is

This is the execution companion to `.claude/plans/sdk-shape.md`. The plan describes WHAT the SDK should be after the refactor. The playbook describes HOW to get there: which files are involved for each block, what happens to each, and in what order.

If this playbook and the plan disagree about the end state, the plan wins and the playbook is fixed. The plan is authoritative for design; the playbook is authoritative for execution order.

## Phases

The refactor runs in three phases:

**Phase 1: Plan (done).** The design document at `.claude/plans/sdk-shape.md` is settled.

**Phase 2: Design implementation.** Create new class files alongside the existing code. Write the new `TurnRunner`, `QueryRunner`, `StreamProcessor`, `ToolRegistry`, plus their interfaces. Wire up the new dependency graph and get it compiling. Do not touch the CLI startup path. Do not delete any existing files. The existing code path keeps working unchanged throughout phase 2.

**Phase 3: Swap and cleanup.** Wire the new classes into the CLI startup path. Delete `AgentRun`, `AnthropicAgent`, `createAnthropicAgent`, `ConversationStore`, `MessageStream`, `IAnthropicAgent`, `RunAgentQuery`. Update tests. Phase 3 runs in a later session, after phase 2 is complete and reviewable.

Each file entry below is tagged with the phase(s) it touches.

## File map

### Client

- **`packages/claude-sdk/src/private/AnthropicClient.ts`** `[phase 2: minor]` Update JSDoc to remove the `#232` issue reference (point at the plan file instead). Add a line noting the Client owns client-identifying headers (User-Agent, SDK version) but not feature beta headers.
- **`packages/claude-sdk/src/private/http/TokenRefreshingAnthropic.ts`** `[keep]` Token refresh mechanism. Unchanged.
- **`packages/claude-sdk/src/private/http/customFetch.ts`** `[keep]`
- **`packages/claude-sdk/src/private/http/getBody.ts`** `[keep]`
- **`packages/claude-sdk/src/private/http/getHeaders.ts`** `[keep]`
- **`packages/claude-sdk/src/private/http/sdkInternals.ts`** `[keep]`
- **`packages/claude-sdk/src/private/Auth/*`** (20 files) `[keep]` `[phase 3: optional move]` OAuth flow and credential storage. Behaviour unchanged. Optional phase 3 move to `private/Client/Auth/` to make the Client block's scope visible in the filesystem. Style call; decide before phase 3.

### Conversation

- **`packages/claude-sdk/src/private/Conversation.ts`** `[phase 2: minor]` `[phase 3: delete load]` Phase 2 may add a `setHistory(msgs[])` operation to cleanly support the restore flow from a saved message list (exact shape is an implementation detail; see the plan's "Setting up the SDK" section). Phase 3 deletes the `load()` method, which becomes dead code once `ConversationStore` is deleted.
- **`packages/claude-sdk/src/private/ConversationStore.ts`** `[phase 3: delete]` The whole file goes away. Its only job (wrapping `historyFile` and calling `Conversation.load()`) is removed under the plan rule that the SDK does not touch the filesystem for conversation data.
- **`packages/claude-sdk/test/Conversation.spec.ts`** `[phase 3: trim]` Remove the three `load()` test call sites at lines 219, 228, 236. Other tests stay.

### Stream processor

- **`packages/claude-sdk/src/private/MessageStream.ts`** `[keep, phase 2]` `[phase 3: delete]` The current per-stream class. Kept untouched in phase 2 so the existing code path keeps working. Deleted in phase 3 after the new `StreamProcessor` is wired into the CLI.
- **`packages/claude-sdk/src/private/StreamProcessor.ts`** `[new, phase 2]` New long-lived stream processor class. Same `.on(...)` event names as the current `MessageStream` (`message_start`, `message_text`, `thinking_text`, `message_stop`, `compaction_start`, `compaction_complete`). Constructor takes no per-stream arguments. Method `process(rawIterable)` runs one stream to completion; per-stream state lives in method-local variables, not on the instance. The consumer subscribes once at setup and the handlers fire for every stream the processor handles.
- **`packages/claude-sdk/test/MessageStream.spec.ts`** `[phase 3]` Either rename to `StreamProcessor.spec.ts` and retarget, or leave and write a parallel `StreamProcessor.spec.ts` in phase 2 then delete the old one in phase 3.

### Request builder

- **`packages/claude-sdk/src/private/RequestBuilder.ts`** `[keep]` Pure function, already correct shape. Minor JSDoc update optional to spell out the `systemReminder` cache-boundary placement for the next reader, but not required.
- **`packages/claude-sdk/test/RequestBuilder.spec.ts`** `[keep]`

### Tool registry

There is no existing `ToolRegistry` class. Tool execution currently lives inline in `AgentRun.#executeTool` at `AgentRun.ts:250`.

- **`packages/claude-sdk/src/private/ToolRegistry.ts`** `[new, phase 2]` New class. Constructor takes `AnyToolDefinition[]`, converts Zod schemas to JSON Schema once and caches the result. Method `execute(toolName, input, transformHook?)` validates input against the Zod schema, calls the handler, applies the transform hook if supplied, converts the output to an array of API content blocks, and returns the content blocks. Does NOT construct the full `tool_result` block; that requires knowing the `tool_use_id`, which is the query runner's concern.
- **`packages/claude-sdk/src/public/defineTool.ts`** `[keep]`
- **`packages/claude-sdk/src/public/types.ts`** `[phase 3: minor]` `ToolDefinition` and `AnyToolDefinition` types are unchanged in shape. `RunAgentQuery` is deleted in phase 3. `AnthropicAgentOptions.historyFile` is deleted in phase 3.
- **`packages/claude-sdk/src/public/interfaces.ts`** `[phase 2: add]` Add an `IToolRegistry` abstract class if the plan's behavioural-interface principle is applied here.

### Approval coordinator

- **`packages/claude-sdk/src/private/ApprovalState.ts`** `[keep]` `[phase 3: possible rename]` Already exists. Implements the approval coordinator responsibility: correlates requests with responses by id, parks pending promises, propagates cancel. Possibly rename file and class to `ApprovalCoordinator` in phase 3 to match the plan's naming. Behaviour unchanged.

### Turn runner

There is no existing `TurnRunner`. Turn logic currently lives inline in `AgentRun.run()` around the while loop.

- **`packages/claude-sdk/src/private/TurnRunner.ts`** `[new, phase 2]` New class. Constructor takes dependencies: `IAnthropicClient`, `StreamProcessor`, the request builder function (or the function's import reference). Method `run(conversation, durableConfig, perTurnInput)` executes one turn: reads the Conversation wire view, calls `buildRequestParams`, merges the per-query abort signal into request options, calls the Client to stream the request, hands the iterable to the Stream processor, reads the assembled message when the stream ends, pushes it to the Conversation, returns `{ message, stopReason }`. Does not dispatch tools; that is the query runner's job. Does not subscribe to any events per turn; the consumer's `.on(...)` handlers on the Stream processor are already set up at SDK startup and fire naturally.
- **`packages/claude-sdk/src/public/interfaces.ts`** `[phase 2: add]` Add an `ITurnRunner` abstract class.

### Query runner

There is no existing `QueryRunner`. Query loop logic currently lives in `AgentRun.run()`.

- **`packages/claude-sdk/src/private/QueryRunner.ts`** `[new, phase 2]` New class. Constructor takes dependencies: `TurnRunner`, `Conversation`, `ToolRegistry`, `ApprovalState` (the approval coordinator), durable config. Method `run(perQueryInput)` takes the per-query input fields (user message, optional `systemReminder`, optional `transformToolResult` hook, abort controller). Pushes the user message into the Conversation. Enters the turn loop. For each iteration: calls `turnRunner.run(...)`, inspects the returned stop reason, and if it is `tool_use`, dispatches each `tool_use` block: requests approval via the approval coordinator if required, calls `toolRegistry.execute(name, input, transformHook)` to get content blocks, wraps them in a `tool_result` block with the matching `tool_use_id`, assembles a user-role message carrying the tool_result blocks, pushes it into the Conversation, loops back to the next turn. Exits on terminal stop reason or cancel. Returns (or resolves a promise) when the query is done. Tracks first-turn-only state for `systemReminder`: passes it to `turnRunner.run` on the first iteration, `undefined` on subsequent iterations.
- **`packages/claude-sdk/src/public/interfaces.ts`** `[phase 2: add]` Add an `IQueryRunner` abstract class.

### Control channel

- **`packages/claude-sdk/src/private/AgentChannel.ts`** `[keep]` `[phase 3: possible rename]` Already exists. Wraps a `MessagePort` pair, provides `send` and inbound message dispatch. Possibly rename to `ControlChannel.ts` in phase 3 to match the plan's naming. Behaviour unchanged.

### Files on the CLI side (not SDK blocks, but touched by the refactor)

- **`apps/claude-sdk-cli/src/entry/main.ts`** `[phase 3]` Currently calls `createAnthropicAgent({ authToken, logger, historyFile })` at line 90-ish. Phase 3 replaces this with individual block construction: Client, Conversation, ToolRegistry, ControlChannel (AgentChannel), ApprovalState, StreamProcessor (with `.on(...)` subscriptions set at this point), TurnRunner, QueryRunner, durable config object.
- **`apps/claude-sdk-cli/src/runAgent.ts`** `[phase 3]` Currently calls `agent.runAgent(options)` with the 14-field options object. Phase 3 replaces this with a single `queryRunner.run(perQueryInput)` call. The durable fields (model, betas, tools, system prompts, cache TTL, compaction, etc.) are held by the caller of `runAgent` (main.ts) and passed once at setup; `runAgent` itself takes only the per-query input.
- **`apps/claude-sdk-cli/src/AgentMessageHandler.ts`** `[keep]` Message handler reads events from the channel. Unchanged. Its subscriptions to the channel's events are already set once at startup.
- **`apps/claude-sdk-cli/src/gitDelta.ts`** `[keep]` Source of the `systemReminder` string passed to `queryRunner.run`. Unchanged.
- **`apps/claude-sdk-cli/src/systemPrompts.ts`** `[keep]` Durable system prompts. Unchanged.

### Files deleted in phase 3

Consolidated list of deletions:

- `packages/claude-sdk/src/private/AgentRun.ts`
- `packages/claude-sdk/src/private/AnthropicAgent.ts`
- `packages/claude-sdk/src/public/createAnthropicAgent.ts`
- `packages/claude-sdk/src/private/ConversationStore.ts`
- `packages/claude-sdk/src/private/MessageStream.ts` (replaced by `StreamProcessor.ts`)
- `packages/claude-sdk/test/AgentRun.spec.ts` (replaced by `TurnRunner.spec.ts` and `QueryRunner.spec.ts`)

### Public surface changes in phase 3

- `RunAgentQuery` type: deleted. Replaced conceptually by the per-query input shape the query runner takes.
- `AnthropicAgentOptions` type: deleted or stripped. `historyFile` removed. `authToken` and `logger` move into whatever factory is used to construct the Client.
- `IAnthropicAgent` abstract class in `interfaces.ts`: deleted.
- `index.ts` re-exports: updated to reflect the new public API (new block classes, removed old types).
- `SdkQuerySummary.systemReminder` field at `types.ts:61`: kept. The field is used by `AgentMessageHandler.ts:120` to append the reminder to the streamed line output; this display behaviour is separate from the SDK-side handling.

### Open decisions flagged for later

These are style and naming calls that do not block phase 2 but need to be resolved before or during phase 3.

1. `AnthropicAuth` export status. Currently exported as public API at `index.ts:31`. Stays exported, becomes internal, or renamed? Decide before phase 3.
2. `Auth/` directory move to `Client/Auth/`. Style call to make the Client block's scope visible. Decide before phase 3.
3. `ApprovalState` → `ApprovalCoordinator` rename. Match plan naming or keep current. Decide before phase 3.
4. `AgentChannel` → `ControlChannel` rename. Same. Decide before phase 3.
5. `Conversation.setHistory(msgs[])` as an explicit method, or restoration via a loop of `push` calls. Decide during phase 2 when writing the new block wiring. The plan deliberately does not pin this because it is an implementation detail.
6. Whether `ToolRegistry`, `TurnRunner`, `QueryRunner`, `StreamProcessor` each have behavioural interfaces (abstract classes) in `interfaces.ts`, or are concrete classes only. Follows the plan's "substitution happens through behavioural interfaces" principle, but the exact interface surface is decided when the classes are written in phase 2.

---

## Ordered execution steps

Each step below is sized to be a single focused commit. Steps are ordered so each step's preconditions are satisfied by earlier steps. Every step has:

- **scope**: files touched
- **action**: one-line or one-paragraph summary of the change
- **tests**: what tests exist after this step (new, kept, or deleted)
- **check**: how to verify the step is done

Phase 2 is this session's next scope. Phase 3 is a later session.

### Phase 2: design implementation

Five steps. New class files alongside the existing code. The existing code path keeps working unchanged throughout phase 2.

#### Step 1. Add StreamProcessor and IStreamProcessor

- **scope**: `packages/claude-sdk/src/private/StreamProcessor.ts` (new), `packages/claude-sdk/src/public/interfaces.ts` (add `IStreamProcessor` abstract class).
- **action**: New long-lived stream processor class. Same `.on(...)` event surface as the current `MessageStream` (`message_start`, `message_text`, `thinking_text`, `message_stop`, `compaction_start`, `compaction_complete`, plus whatever else the existing `MessageStreamEvents` type declares). Constructor takes no per-stream arguments. Method `process(rawIterable)` runs one stream to completion; per-stream state (partial assembled message, cache split tracking, stop reason) lives in method-local variables, not on the instance. The consumer subscribes once at setup and the same handlers fire for every stream the processor handles.
- **tests**: new `packages/claude-sdk/test/StreamProcessor.spec.ts`. Covers single stream processed correctly, multiple streams via the same instance, `.on(...)` handlers fire for every stream, local state does not leak between calls. Old `MessageStream.spec.ts` stays untouched because `MessageStream.ts` still exists and is still used by `AgentRun`.
- **check**: `StreamProcessor.ts` compiles. New test passes. All old tests still pass.

#### Step 2. Add ToolRegistry and IToolRegistry

- **scope**: `packages/claude-sdk/src/private/ToolRegistry.ts` (new), `packages/claude-sdk/src/public/interfaces.ts` (add `IToolRegistry` abstract class).
- **action**: New class. Constructor takes `AnyToolDefinition[]`, converts each tool's Zod schema to JSON Schema once at construction and caches the result (matches the conversion currently done per-request in `buildRequestParams`). Method `execute(toolName, input, transformHook?)` looks up the tool by name, validates the input against the Zod schema, calls the handler with the validated input, applies the transform hook to the handler's output if supplied, and returns the handler's output converted to an array of API content blocks (stringified into a single text block if the handler returns a non-content-block value, matching current `AgentRun.#executeTool` behaviour). Does NOT construct the full `tool_result` block because that requires the `tool_use_id` which only the caller (query runner) sees. Errors (tool not found, invalid input, handler threw) are surfaced via a result type or thrown exceptions; the exact shape is an implementation call, but both cases have to be distinguishable by the query runner so it can preserve the current asymmetry (silent log on tool-not-found, `channel.send` on invalid input). Does not know about approval, conversation, or the channel.
- **tests**: new `packages/claude-sdk/test/ToolRegistry.spec.ts`. Covers: schema conversion happens once at construction (not on every execute), validation catches invalid input, handler is called with validated input, transform hook is applied to output, content-block return shape, tool-not-found is surfaced distinguishably from invalid-input. Old inline `#executeTool` and `#handleTools` in `AgentRun.ts` stay untouched.
- **check**: `ToolRegistry.ts` compiles. New test passes. All old tests still pass.

#### Step 3. Add TurnRunner and ITurnRunner

- **scope**: `packages/claude-sdk/src/private/TurnRunner.ts` (new), `packages/claude-sdk/src/public/interfaces.ts` (add `ITurnRunner` abstract class).
- **dependencies**: step 1 (StreamProcessor exists).
- **action**: New class. Constructor takes `IMessageStreamer` (the existing Client interface), `StreamProcessor`. Method `run(conversation, durableConfig, perTurnInput)` executes one turn: reads the Conversation wire view via `conversation.cloneForRequest()`, calls `buildRequestParams(builderOptions, wireView)` to get `{ body, headers }`, merges the per-query abort signal from `perTurnInput` into `Anthropic.RequestOptions`, calls `streamer.stream(body, requestOptions)` to get an async iterable of raw events, calls `streamProcessor.process(iterable)` and awaits the assembled-message result, pushes the assembled assistant message into the Conversation, returns `{ message, stopReason }`. Does NOT dispatch tools; that is the query runner's job. Does NOT subscribe to any `.on(...)` events per turn; it relies on whatever subscriptions were set on the StreamProcessor instance at startup. The `perTurnInput` is just the per-query input fields for this turn (the `systemReminder` passes through only on the first turn, the query runner decides).
- **tests**: new `packages/claude-sdk/test/TurnRunner.spec.ts`. Small and focused. Covers one turn end-to-end with a mocked `IMessageStreamer` and a real `StreamProcessor` (or a mocked one), per-query abort signal reaches the request options, assembled message is pushed to a real `Conversation`, stop reason is returned.
- **check**: `TurnRunner.ts` compiles. New test passes. All old tests still pass.

#### Step 4. Add QueryRunner and IQueryRunner

- **scope**: `packages/claude-sdk/src/private/QueryRunner.ts` (new), `packages/claude-sdk/src/public/interfaces.ts` (add `IQueryRunner` abstract class).
- **dependencies**: step 2 (ToolRegistry exists), step 3 (TurnRunner exists).
- **action**: New class. Constructor takes `TurnRunner`, `Conversation`, `ToolRegistry`, `ApprovalState`, `IAgentChannel` (for approval send and `tool_error` broadcast, preserving Decision 3's asymmetry), durable config. Method `run(perQueryInput)` takes the per-query input fields: user message, optional `systemReminder`, optional `transformToolResult` hook, abort controller. At the start of a query: if the durable config has `cachedReminders` AND the Conversation currently has no user messages (fresh conversation or post-compaction), injects the cached reminders by pushing a user message with `<system-reminder>` content blocks (matches current `AgentRun.execute` behaviour around line 47 of that file). Pushes the per-query user message into the Conversation. Enters the turn loop: calls `turnRunner.run(conversation, durableConfig, { ...perTurnInput, systemReminder: firstTurn ? input.systemReminder : undefined })`, inspects the stop reason. If terminal (`end_turn`, `max_tokens`, `stop_sequence`), exits. If `tool_use`, dispatches each `tool_use` block in the assembled message: validates approval if required via `ApprovalState`, calls `toolRegistry.execute(name, input, transformHook)` to get content blocks, catches tool-not-found errors (logs silently, no channel send) and invalid-input errors (sends `tool_error` on channel), wraps successful content in a `tool_result` block with the matching `tool_use_id`, assembles a user-role message carrying the tool_result blocks, pushes it to the Conversation, loops back to run the next turn. Exits the loop on terminal stop reason or cancel. Returns when done.
- **tests**: new `packages/claude-sdk/test/QueryRunner.spec.ts`. Covers: single-turn query exits on terminal stop reason, multi-turn with tool dispatch loops correctly, cancel propagation exits the loop, first-turn-only `systemReminder` state is correct, cached reminders are injected on a fresh conversation and not on a populated one, tool-not-found handling preserves the asymmetry (silent log, no channel send), invalid-input handling sends `tool_error` on the channel, approval flow works with both required and not-required cases.
- **check**: `QueryRunner.ts` compiles. New test passes. All old tests still pass.

#### Step 5. Minor updates (optional, any time during phase 2)

- **scope**: `packages/claude-sdk/src/private/AnthropicClient.ts` JSDoc update; optionally `packages/claude-sdk/src/private/RequestBuilder.ts` JSDoc; optionally `packages/claude-sdk/src/private/Conversation.ts` add `setHistory(msgs[])` method.
- **action**: Remove the `#232` issue reference from `AnthropicClient.ts` JSDoc at line 15 and point at `.claude/plans/sdk-shape.md` instead. Optionally add a line clarifying the Client owns client-identifying headers but not feature beta headers. Optionally add a short JSDoc on `buildRequestParams` explaining the systemReminder cache-boundary placement for the next reader. Optionally add `Conversation.setHistory(msgs[])` if phase 3's CLI restore flow wants it; if not, defer to phase 3.
- **tests**: no new tests; no existing tests change.
- **check**: files compile, all tests pass. These updates are cosmetic and can be dropped from phase 2 entirely if time is short.

### Phase 3: swap and cleanup (later session)

Seven steps. The CLI switches to the new classes, then the old classes are deleted.

#### Step 6. Swap the CLI to use the new blocks

- **scope**: `apps/claude-sdk-cli/src/entry/main.ts`, `apps/claude-sdk-cli/src/runAgent.ts`.
- **dependencies**: all of phase 2.
- **action**: `main.ts` stops calling `createAnthropicAgent({ authToken, logger, historyFile })`. Instead it constructs the individual blocks at startup: `AnthropicAuth` (same as today), `AnthropicClient`, `Conversation`, `ToolRegistry` (with the CLI's tools), `AgentChannel` (the existing channel class, for approval messaging), `ApprovalState`, `StreamProcessor` (with ALL `.on(...)` subscriptions set at this point; these were previously set per-turn inside `AgentRun`), `TurnRunner`, `QueryRunner`, and a durable config object (`{ model, betas, systemPrompts, cacheTtl, cachedReminders, compaction, approvalMode, thinking, maxTokens }`). `runAgent.ts` stops calling `agent.runAgent(options)` and instead calls `queryRunner.run({ userMessage, systemReminder: gitDelta, transformToolResult, abortController })`. The durable fields that currently sit on the per-call options (tools, betas, model, etc.) move out of `runAgent.ts` and into `main.ts`'s durable config construction.
- **tests**: manual end-to-end verification. Run the CLI, send a query, verify streaming works, tool approval works, tool execution works, cancel works, multi-turn tool loops work, `gitDelta` appears in the first turn only, compaction works. No automated test is added in this step.
- **check**: the CLI starts, a query completes end-to-end using the new blocks, the old `AgentRun` class is no longer called, the old `createAnthropicAgent` factory is no longer called.

#### Step 7. Delete the agent bundle files

- **scope**: delete `packages/claude-sdk/src/private/AgentRun.ts`, `packages/claude-sdk/src/private/AnthropicAgent.ts`, `packages/claude-sdk/src/public/createAnthropicAgent.ts`. Delete the `IAnthropicAgent` abstract class from `packages/claude-sdk/src/public/interfaces.ts`. Update `packages/claude-sdk/src/index.ts` to remove these exports.
- **dependencies**: step 6 (CLI no longer calls these).
- **tests**: delete `packages/claude-sdk/test/AgentRun.spec.ts`. Most of its assertions are tightly coupled to the old class's internal turn-loop structure and do not transfer cleanly. Any behavioural assertions that still matter (tool dispatch order, first-turn `systemReminder`, cancel propagation, cached reminder injection, tool-not-found vs invalid-input asymmetry) should already be covered by `QueryRunner.spec.ts` from step 4; if a gap is discovered at this step, add the missing assertion to `QueryRunner.spec.ts` before deleting `AgentRun.spec.ts`.
- **check**: `grep -r 'AgentRun\|AnthropicAgent\|createAnthropicAgent\|IAnthropicAgent' packages/ apps/` returns zero hits. All remaining tests pass.

#### Step 8. Delete the history store

- **scope**: delete `packages/claude-sdk/src/private/ConversationStore.ts`. Delete the `load()` method from `packages/claude-sdk/src/private/Conversation.ts`. Update `packages/claude-sdk/src/public/types.ts` to remove `historyFile?: string` from `AnthropicAgentOptions` (or delete the whole type if nothing still references it).
- **dependencies**: step 7 (AgentRun no longer references `ConversationStore`).
- **tests**: delete the three `Conversation.load()` test call sites in `packages/claude-sdk/test/Conversation.spec.ts` at lines 219, 228, 236. Other tests in that file stay.
- **check**: `grep -r 'ConversationStore\|historyFile' packages/ apps/` returns zero hits. `grep -r 'Conversation\.load' packages/` returns zero hits.

#### Step 9. Delete the old stream processor

- **scope**: delete `packages/claude-sdk/src/private/MessageStream.ts`. Delete `packages/claude-sdk/test/MessageStream.spec.ts` (replaced by `StreamProcessor.spec.ts` from step 1).
- **dependencies**: step 7 (AgentRun no longer imports `MessageStream`).
- **tests**: before deleting `MessageStream.spec.ts`, verify every assertion in it has a parallel in `StreamProcessor.spec.ts`. If the old test covers a case the new one does not (for example an edge case in event parsing), copy the assertion to `StreamProcessor.spec.ts` first.
- **check**: `grep -r 'MessageStream' packages/ apps/` returns zero hits.

#### Step 10. Remove old public types

- **scope**: `packages/claude-sdk/src/public/types.ts`. Delete `RunAgentQuery`. Delete or strip `AnthropicAgentOptions`. Delete `RunAgentResult` if nothing still uses it.
- **dependencies**: steps 7 and 8 (no code imports these types).
- **tests**: no test changes; any test that imported these types was deleted or retargeted in earlier steps.
- **check**: `grep -r 'RunAgentQuery\|AnthropicAgentOptions\|RunAgentResult' packages/ apps/` returns zero hits.

#### Step 11. Update the public SDK surface

- **scope**: `packages/claude-sdk/src/index.ts`. Add exports for the new block classes (`StreamProcessor`, `ToolRegistry`, `TurnRunner`, `QueryRunner`) and their interfaces (`IStreamProcessor`, `IToolRegistry`, `ITurnRunner`, `IQueryRunner`). Remove exports for the deleted types. Resolve the open decision about whether `AnthropicAuth` stays exported; keep it exported by default unless a reason to hide it surfaces.
- **dependencies**: steps 7, 8, 10.
- **tests**: no test changes.
- **check**: `apps/claude-sdk-cli` imports resolve correctly. `grep -r 'from .@shellicar/claude-sdk.' apps/` shows only imports that match the new exports.

#### Step 12. Optional renames and moves

- **scope**: optional cosmetic commits. `ApprovalState.ts` → `ApprovalCoordinator.ts`. `AgentChannel.ts` → `ControlChannel.ts`. `Auth/` → `Client/Auth/`.
- **dependencies**: all earlier steps.
- **action**: each rename is a separate small commit. File move or rename, import path updates throughout the codebase, nothing else.
- **tests**: update import paths in test files as part of each rename.
- **check**: all tests pass after each rename.

---

*End of ordered steps. Phase 2 is five commits (steps 1 through 5). Phase 3 is seven commits (steps 6 through 12). Review this section before I start phase 2 implementation.*
