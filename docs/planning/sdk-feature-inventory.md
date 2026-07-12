# SDK feature inventory

Inventory of behaviours implemented in the current SDK and CLI against the multi-transport agent architecture doc at `.claude/plans/multi-transport-architecture.md`. Coverage values: **covered** (doc names it explicitly), **partial** (doc touches it but leaves details unresolved), **not-covered** (no mention).

This document inventories. It does not propose, critique, or sketch.

## SDK public API surface

**Location**: `packages/claude-sdk/src/index.ts`, `packages/claude-sdk/src/public/`

**Description**: The single-export-barrel for the SDK. Names every class, type, and helper consumers wire by hand. The shape of the public surface today is "long-lived collaborators constructed once at setup, reused for every query."

**Specific behaviours**:
- Exports `AnthropicClient`, `ApprovalCoordinator`, `ControlChannel`, `Conversation`, `QueryRunner`, `StreamProcessor`, `ToolRegistry`, `TurnRunner`, `AnthropicAuth`, `calculateCost`, `defineTool`, `toWireTool` — covered — doc's "What carries over" section names most of these.
- Exports `IPublisher<T>` / `ISubscriber<T>` interfaces for the channel — partial — doc names `ControlChannel<T>` as "promoted from implementation detail to the agent's outbound primitive" but the split publisher/subscriber roles aren't discussed.
- Exports `IStreamProcessor`, `IToolRegistry`, `ITurnRunner`, `IQueryRunner` abstract bases — not-covered — the new Agent interface doesn't account for whether these stay public.
- Exports enums `AnthropicBeta`, `CacheTtl`, and constant `COMPACT_BETA` — not-covered — cache control and beta header configuration isn't in the doc's surface.

## OAuth authentication (Claude Code account)

**Location**: `packages/claude-sdk/src/private/Client/Auth/AnthropicAuth.ts` and the rest of `Auth/`

**Description**: PKCE-style OAuth flow against Anthropic's Claude.ai endpoint. Credentials are persisted to disk; expired tokens are refreshed automatically; an interactive login is triggered when no credentials exist.

**Specific behaviours**:
- Two redirect modes — `local` (opens browser, listens on `localhost:3001` for the callback) and `manual` (prints URL, reads pasted code from stdin) — not-covered — doc lists "Authentication on remote transports" as a non-goal but says nothing about the agent's outbound OAuth.
- Credentials persisted to a file path computed by `credentialsPath.ts` — not-covered.
- Profile is fetched once after first login and merged into credentials — not-covered.
- `isExpired` check + `refreshCredentials` triggers automatic refresh on `getCredentials()` — not-covered.
- `AuthCredentials` type re-exported from the SDK index — not-covered.

## HTTP client and per-request token refresh

**Location**: `packages/claude-sdk/src/private/AnthropicClient.ts`, `packages/claude-sdk/src/private/http/TokenRefreshingAnthropic.ts`, `packages/claude-sdk/src/private/http/customFetch.ts`

**Description**: `AnthropicClient` wraps `@anthropic-ai/sdk`'s `Anthropic` client. `TokenRefreshingAnthropic` subclasses `Anthropic` to override `apiKeyAuth` and `bearerAuth` so a `() => Promise<string>` getter is called per request (the upstream SDK silently drops non-string `apiKey`/`authToken` values).

**Specific behaviours**:
- Per-request bearer token via async getter — not-covered — doc lists "AnthropicClient (HTTP+auth)" under "SDK plumbing" but doesn't address the getter contract.
- Static `user-agent` header pinning `@shellicar/claude-sdk/${version}` — not-covered.
- `customFetch` logs request and response bodies, distinguishing SSE responses from JSON — not-covered.
- Re-emits `finalMessage` events from the underlying `BetaMessageStream` so consumers can audit-log them (current consumer: `AuditWriter`) — not-covered — see Audit log entry.
- Extends `IMessageStreamer` (one-method abstract base) — partial — doc names `IMessageStreamer` as the seam below the Agent.

## Conversation history and compaction

**Location**: `packages/claude-sdk/src/private/Conversation.ts`

**Description**: In-memory message store. Enforces role-alternation merge for consecutive user messages, supports tagging messages for later removal, and handles compaction blocks specially when cloning for a request.

**Specific behaviours**:
- `push` merges consecutive user messages into one (the API requires strict role alternation) — not-covered.
- `push` accepts an `opts.id` tag; `remove(id)` deletes the last-tagged message — not-covered — no obvious orchestrator use case in the doc.
- Compaction blocks are appended like any other message; history is never truncated — not-covered — doc mentions `message_compaction_start` / `message_compaction` events as model-specific but doesn't address the storage semantics.
- `cloneForRequest(compactEnabled)` returns a deep clone of the slice from the last compaction forward — not-covered.
- When `compactEnabled` is false, `cloneForRequest` converts compaction blocks back to text blocks; failed compactions (null content) are dropped, and assistant messages left empty are dropped — not-covered.
- `setHistory` replaces the full history (used for resuming from session file) — not-covered — doc's `history()` snapshot API is read-only; the rehydration direction isn't shown.

## RequestBuilder (`buildRequestParams`)

**Location**: `packages/claude-sdk/src/private/RequestBuilder.ts`

**Description**: Pure function from `(options, messages)` to `{ body, headers }`. Encodes a large amount of Anthropic-protocol detail: cache_control placement, beta header composition, system-prompt prefix, context management edits, ephemeral system-reminder injection.

**Specific behaviours**:
- `AGENT_SDK_PREFIX` ("You are a Claude agent, built on Anthropic's Claude Agent SDK.") is prepended to system prompts unconditionally — not-covered.
- `cacheLastUserMessage` adds `cache_control` to the last non-thinking content block of the last user message before any reminder is injected — not-covered — cache boundary placement is part of the protocol surface the doc doesn't discuss.
- `systemReminder` is injected *after* the cache boundary (post-cache, never stored in history) onto the last user message — partial — doc names `systemReminder` becoming a `TurnInjector`, but the post-cache placement is the actual mechanism.
- `cache_control` is also added to the last tool entry — not-covered.
- The last system prompt entry has `cache_control` with the durable `cacheTtl` — not-covered.
- Beta header string is composed from the `betas` flag map, plus `COMPACT_BETA` when compaction is enabled — not-covered.
- `thinking: 'adaptive'` and `display: 'summarized'` set when `thinking === true` — not-covered.
- `context_management.edits` array assembled from the `ContextManagement` beta plus compaction config (`clear_thinking_20251015`, `clear_tool_uses_20250919`, `compact_20260112`) — not-covered.
- `cache_control: { scope: 'global' }` set on the body when `PromptCachingScope` beta is enabled — not-covered.
- `serverTools` are prepended to client tools; `transformTool` (CLI-supplied) runs on each client tool to add `defer_loading`, `allowed_callers`, or strip `input_examples` — not-covered.
- `input_examples` are always emitted on the wire; the CLI's `transformTool` strips them when ATU is disabled — not-covered.
- `toWireTool` converts a tool definition's Zod input schema to JSON Schema (draft-07, IO=input) — not-covered.

**Doc coverage**: not-covered — doc says `buildRequestParams` "moves inside the model" and is no longer a top-level SDK export, but doesn't account for the per-request mutation surface (cache markers, ephemeral injection, beta composition).

## StreamProcessor (Anthropic stream events → SDK events)

**Location**: `packages/claude-sdk/src/private/StreamProcessor.ts`

**Description**: Subscribes to a `BetaMessageStream`, renames events into the SDK's `MessageStreamEvents` vocabulary, and awaits `finalMessage()` to assemble the `MessageStreamResult` (blocks + stopReason + usage + contextManagementOccurred flag).

**Specific behaviours**:
- Emits a renamed event set: `message_start`, `message_text`, `message_stop`, `thinking_start`/`thinking_text`/`thinking_stop`, `compaction_start`/`compaction_complete`, `server_tool_use`, `server_tool_result` — partial — doc lists `text_delta`, `thinking_delta`, `tool_use`, etc. as base events but the rename mapping isn't shown.
- Server tool result type names (`web_search`, `web_fetch`, `code_execution`, `bash_code_execution`, `text_editor_code_execution`, `tool_search`, `mcp`) are mapped from the raw block types — not-covered.
- `mapBlocks` converts raw `BetaContentBlock`s to the SDK's `ContentBlock` discriminated union (text, thinking, redacted_thinking, tool_use, compaction, server_tool_use, server tool result variants) — not-covered.
- `mcp_tool_use` and `container_upload` blocks are silently ignored — not-covered.
- `contextManagementOccurred` flag returned in the result when the response carries `context_management` — not-covered.
- Per-stream state lives in `BetaMessageStream`; `process()` is non-reentrant on a single instance — not-covered.
- `IStreamProcessor` extends `EventEmitter` with typed event map; long-lived, listeners attached once — partial — doc's text section says `subscribe()` "returns a per-consumer iterator instead of exposing one shared iterator," which is the opposite topology.

## TurnRunner (one request/response cycle)

**Location**: `packages/claude-sdk/src/private/TurnRunner.ts`

**Description**: Per-turn: clone conversation, build request, stream, push assistant message into `Conversation`, return result.

**Specific behaviours**:
- Reads `Conversation.cloneForRequest(compactEnabled)` to get a mutable wire view — not-covered.
- Merges the per-turn `abortSignal` into `Anthropic.RequestOptions` alongside the built `anthropic-beta` header — partial — doc's cancellation section mentions the HTTP request signal works today.
- Maps SDK `ContentBlock`s back to wire-format `BetaContentBlockParam`s when pushing the assembled assistant message back into `Conversation` — not-covered.
- Empty-content assistant messages are not pushed — not-covered.

## QueryRunner (turn loop and tool dispatch)

**Location**: `packages/claude-sdk/src/private/QueryRunner.ts`

**Description**: Long-lived. Owns the per-query loop: push user messages, loop turns until terminal stop or cancel, dispatch tools between turns. Emits SDK control-channel events.

**Specific behaviours**:
- `cachedReminders` injection: when no user messages exist in history (fresh conversation OR post-compaction state), the first user message of the query is prefixed with one `<system-reminder>…</system-reminder>` block per reminder — partial — doc mentions `ClaudeMdInjector` "adds cached reminders on a fresh conversation" but the post-compaction case isn't named.
- Per-query `ApprovalCoordinator.reset()` clears any leftover `cancelled` flag from a previous query — not-covered.
- `query_summary` event emitted pre-turn with system/user/assistant/thinking counts plus the current `systemReminder` — not-covered.
- `systemReminder` is one-shot: passed only on the first turn of a query, reset to `undefined` after — partial — doc names this as `TurnInjector`s, but the "first turn only" behaviour belongs to `cachedReminders`, not the per-turn injector.
- Empty `tool_use` stop-reason retry: up to 2 retries when `stopReason === 'tool_use'` but no tool_use blocks were accumulated — not-covered.
- `message_usage` event after every turn, with `costUsd` computed by `calculateCost(usage, model, cacheTtl)` and `contextWindow` derived from `getContextWindow(model)` — partial — doc names a `usage` event with `tokens`, `costUsd`, `contextWindow` but the per-turn timing is the actual behaviour.
- `turn_content` event after every turn carrying the raw block list — not-covered — doc names `text_delta` etc., not a per-turn aggregate.
- `done` event with the stop reason at terminal stop — covered (matches doc's `turn_ended`).
- `error` event when `TurnRunner.run` throws — covered.
- Tool dispatch: phase 1 `resolve` parses input once; phase 2 runs the closure across the approval gate without re-parsing — not-covered.
- Tool-not-found vs invalid-input asymmetry: `not_found` is logged silently and emits an error `tool_result` block; `invalid_input` broadcasts a `tool_error` event on the channel as well — not-covered.
- When approval is required, all approval requests are fired in parallel and closures execute in the order approvals arrive (`Promise.race`) — not-covered.
- When approval is not required, closures run sequentially in the model's order — not-covered.
- `cancelled` flag is checked between every tool in both paths — partial — doc's "Cancel during another client's action. Cancel is global." matches the global semantics.
- Random UUID is generated per `tool_approval_request` (`randomUUID()`) — not-covered — doc names `requestId` but not its source.

## ApprovalCoordinator

**Location**: `packages/claude-sdk/src/private/ApprovalCoordinator.ts`

**Description**: Per-`requestId` pending map; resolves the promise when a matching `tool_approval_response` arrives; on `cancel`, resolves all pending approvals as rejected with reason `'cancelled'`.

**Specific behaviours**:
- Map keyed by `requestId` — covered (doc names "Approval conflict. First valid approval for a requestId wins.").
- `reset()` clears the `cancelled` flag for reuse across queries — not-covered.
- Cancel resolves all pending with `approved: false, reason: 'cancelled'` — partial — doc names `approved: false, reason: 'cancelled'` for pending approvals during cancel.
- No `approval_settled` notification — partial — doc adds `approval_settled` as a real event and notes the current absence.

## ToolRegistry

**Location**: `packages/claude-sdk/src/private/ToolRegistry.ts`

**Description**: Constructed with the tool definition list. Caches JSON-Schema-converted wire format at construction. `resolve(name, input)` parses once and returns a `run` closure that captures the parsed input.

**Specific behaviours**:
- Single `safeParse` per tool_use; run closure invokes the handler with already-parsed input — not-covered.
- Handler return shape `{ textContent, attachments? }`; `textContent` runs through optional `transform`, then `JSON.stringify`'d if non-string; `attachments` flow back as native `tool_result.content` blocks — not-covered — doc's reactive-tools section discusses an effect shape, but the existing attachment passthrough isn't named.
- Three result kinds: `not_found`, `invalid_input`, `ready` — not-covered.
- `wireTools` returns the cached array; pricing remains constant after construction — not-covered.

## ControlChannel (per-subscriber FIFO)

**Location**: `packages/claude-sdk/src/private/ControlChannel.ts`

**Description**: Implements `IPublisher<T>` and `ISubscriber<T>`. Each subscriber has its own queue and pump; messages fan out by enqueueing into every subscriber's queue. `send` is fire-and-forget; failed handlers are swallowed so one bad subscriber doesn't stop delivery.

**Specific behaviours**:
- Per-subscriber FIFO queues with independent pumps — covered (doc names ControlChannel as the outbound primitive and per-subscriber queues).
- `send` throws if the channel is closed — not-covered.
- `drain()` resolves when every subscriber queue is empty and no handler is in-flight — not-covered.
- Handler errors are caught and silently swallowed in the pump — not-covered.

## Tool definition contract

**Location**: `packages/claude-sdk/src/public/types.ts`, `packages/claude-sdk/src/public/defineTool.ts`

**Description**: `ToolDefinition<TSchema, TOutputSchema>` carries name, description, optional `operation`, Zod input/output schemas, `defer_loading`, `input_examples`, and the typed handler.

**Specific behaviours**:
- `operation: 'read' | 'write' | 'delete'` field — partial — used by `permissions.ts` for zone-based approval (see Permissions entry); doc doesn't mention an authoring-time operation field.
- `defer_loading?: boolean` — partial — used by ATU transform.
- `input_examples` (typed via Zod input) — not-covered.
- `output_schema` — not-covered — every tool ships an output schema today even though the API doesn't consume it.
- Handler return type is `{ textContent: TOutput; attachments?: ToolAttachmentBlock[] }` — not-covered — doc's reactive-tool section names a different effect shape but doesn't account for the existing `textContent` + `attachments` split.
- `ToolAttachmentBlock` is `DocumentBlock | ImageBlock` (base64 PDF / image variants) — not-covered.
- `defineTool` is an identity helper for inference — not-covered.

## TransformToolResult / per-query hook

**Location**: `packages/claude-sdk/src/public/types.ts` (`TransformToolResult`, `PerQueryInput.transformToolResult`); used in `QueryRunner` / `ToolRegistry`

**Description**: Optional per-query hook called on raw tool output before stringification. The CLI uses it to ref-swap large strings.

**Specific behaviours**:
- Signature `(toolName: string, output: unknown) => unknown` — not-covered.
- Called between `handler` return and `JSON.stringify` — not-covered.
- The CLI wires `RefStore.walkAndRef` here and never transforms output from the `Ref` tool itself — not-covered.

## Ref tooling (large-output paging)

**Location**: `packages/claude-sdk-tools/src/RefStore/RefStore.ts`, `packages/claude-sdk-tools/src/Ref/Ref.ts`

**Description**: In-memory keyed string store. `walkAndRef` traverses tool output trees and replaces any string over a threshold with a `{ ref, size, hint }` token. The `Ref` tool returns the stored content sliced by `start` and `limit`.

**Specific behaviours**:
- Per-string and per-uniform-string-array threshold check (joined-newline length) — not-covered.
- UUID ref ids, hint strings recording the originating tool/path (`toolName.field[index]`) — not-covered.
- `Ref` tool returns slice with `found`, `hint`, `content`, `totalSize`, `start`, `end` — not-covered.
- Tool output from the `Ref` tool itself is never ref-swapped — not-covered.

**Doc coverage**: not-covered. The doc's "ref-swap large values" mention exists only in source comments; the ref subsystem isn't named in the architecture.

## Pricing and context-window resolution

**Location**: `packages/claude-sdk/src/private/pricing.ts`

**Description**: Per-model rate table (input, 5m/1h cache write, cache read, output) and per-model context window size. Both look up by model ID with a date-suffix fallback strip.

**Specific behaviours**:
- `calculateCost` factors cache TTL (`5m` vs `1h`) into the cache-write rate — not-covered.
- `getContextWindow` returns 200,000 default if model is unknown — not-covered.
- Date-suffix stripping (`-\d{8}$`) fallback before defaulting — not-covered.

## SDK event vocabulary (`SdkMessage`, `ConsumerMessage`)

**Location**: `packages/claude-sdk/src/public/types.ts`

**Description**: Discriminated unions for the outbound and inbound control-channel messages.

**Specific behaviours**:
- Outbound `SdkMessage` types: `message_start`, `message_text`, `message_thinking`, `message_compaction_start`, `message_compaction`, `message_end`, `tool_approval_request`, `server_tool_use`, `server_tool_result`, `tool_error`, `done`, `error`, `message_usage`, `query_summary`, `turn_content` — partial — doc names some (`text_delta`, `thinking_delta`, `tool_use`, `approval_request`, `usage`, `turn_ended`, `error`) but uses different names; the rename mapping isn't shown.
- Inbound `ConsumerMessage`: `tool_approval_response` and `cancel` — partial — doc names `user_input`, `approval`, `cancel` for `AgentMessage`; the existing channel doesn't carry user input on the consumer port.
- `SdkServerToolUse` / `SdkServerToolResult` distinct types — not-covered.

## Beta flags and cache TTL

**Location**: `packages/claude-sdk/src/public/enums.ts`

**Description**: Two enums and one constant: `AnthropicBeta` (`ClaudeCodeAuth`, `ContextManagement`, `PromptCachingScope`, `AdvancedToolUse`), `CacheTtl` (`5m`, `1h`), `COMPACT_BETA` constant.

**Doc coverage**: not-covered.

## CLI entry / `main.ts` wiring

**Location**: `apps/claude-sdk-cli/src/entry/main.ts`

**Description**: Concrete wiring. Constructs `AnthropicAuth`, `AnthropicClient`, `Conversation`, `ConversationSession`, `ConfigLoader`, `TsServerService`, `AuditWriter`, `StreamProcessor`, `ApprovalCoordinator`, `ToolRegistry`, `TurnRunner`, `QueryRunner`, `AgentMessageHandler`, `GitStateMonitor`, `ClaudeMdLoader`, `AppLayout`. Sets up `sdkChannel` (outbound) and `consumerChannel` (inbound) and forwards `StreamProcessor` events into `sdkChannel`.

**Specific behaviours**:
- Two `ControlChannel`s: outbound `SdkMessage` and inbound `ConsumerMessage` — partial — doc names a single bidirectional interface; the existing two-channel split is the actual shape.
- Per-query mutable `currentAbortController` reference closed over by the consumer-channel handler — partial — doc names cancellation collapsing to one AbortController.
- `--model` CLI override stored in a mutable `overrides.model` slot; `getEffectiveModel()` resolves on every read — not-covered.
- `mapConfig()` runs at startup and again before every turn — `durableConfig` is mutated in place via `Object.assign` — not-covered.
- `process.title = 'claude-sdk-cli'` — not-covered.
- SIGINT requires two presses (first calls `cleanup`, second exits with code 1) — not-covered.
- SIGTERM triggers cleanup — not-covered.
- `uncaughtException` and `unhandledRejection` are logged, not fatal — not-covered.
- Refuses to start if `!process.stdin.isTTY` — not-covered.

## CLI arguments

**Location**: `apps/claude-sdk-cli/src/entry/main.ts` (parseArgs block), `apps/claude-sdk-cli/src/help.ts`

**Specific behaviours**:
- `--version` / `-v`, `--version-info`, `--init-config`, `--help` / `-h` / `-?` — not-covered.
- `--file` (path to initial input file; resolved with `~` expansion), `--name` (session display name), `--model` (override), `--prompt` (initial prompt text), `--no-resume` (start fresh, ignore saved session) — not-covered.
- Initial-turn build: if `--file` or `--prompt` is set, one turn is dispatched before the editor loop — not-covered.

## Config loader (`ConfigLoader`)

**Location**: `packages/claude-core/src/Config/`

**Description**: Layered config from N file paths, schema-validated by Zod. Two-layer model: `sources` (per-file raw) and `config` (merged, validated). Watcher delivers raw change events; loader debounces.

**Specific behaviours**:
- Two paths in CLI: `~/.claude/sdk-config.json` and `./.claude/sdk-config.json` — not-covered.
- Layered merge with null-deletes — covered by source comments; doc not-covered.
- `pathFields` — path values resolved against the source file's directory and `expandPath`'d before merge; CLI uses for `hooks.approvalNotify.command` — not-covered.
- Initial `load()` is forgiving (parse errors warn, partial load); reload aborts on parse or schema error and keeps prior config — not-covered.
- Default 100ms debounce; 0 disables — covered by source; doc not-covered (its `config` lifecycle isn't named beyond a non-goal of "persistence beyond the current file-based session model").
- `onChange(listener)` returns unsubscribe — not-covered.
- Listeners are fired only on the idle phase (caller's contract; CLI uses `turnInProgress` flag to gate model display update) — not-covered.
- `IConfigFileReader` and `IConfigWatcher` abstract bases; CLI wires `NodeConfigFileReader` and `NodeConfigWatcher` — not-covered.

## Config schema

**Location**: `apps/claude-sdk-cli/src/cli-config/schema.ts`, `cli-config/consts.ts`, `cli-config/initConfig.ts`

**Specific behaviours**:
- Fields: `model`, `maxTokens`, `historyReplay`, `claudeMd`, `compact`, `advancedTools`, `serverTools`, `hooks` — not-covered.
- `$schema` field points at a public URL for editor autocomplete — not-covered.
- `compact` config: `enabled`, `inputTokens` trigger, `pauseAfterCompaction`, `customInstructions` — partial — doc names compaction blocks but not the trigger config.
- `advancedTools` config: `enabled`, `searchTool` (`regex`/`bm25`), `allowProgrammaticExecution[]`, `codeExecutionTool` version — not-covered.
- `serverTools.webSearch`/`webFetch`: `enabled`, `version`, `allowedCallers` — not-covered.
- `claudeMd.sources` toggles per source (`user`, `project`, `projectClaude`, `local`) — not-covered.
- `historyReplay.enabled` and `historyReplay.showThinking` — not-covered.
- `hooks.approvalNotify`: `{ command, delayMs }` or null — not-covered (closest doc analogue is `HookInjector`, which describes a different injection point).
- `initConfig` writes defaults to `~/.claude/sdk-config.json` — not-covered.

## CLAUDE.md loading

**Location**: `apps/claude-sdk-cli/src/ClaudeMdLoader.ts`

**Specific behaviours**:
- Four standard sources, in order: `~/.claude/CLAUDE.md`, `./CLAUDE.md`, `./.claude/CLAUDE.md`, `./CLAUDE.local.md` — not-covered — doc doesn't enumerate.
- Each section is wrapped with a per-file label and `INSTRUCTION_PREFIX` saying these instructions override default behavior — not-covered.
- Files re-read on every call (no watcher) — not-covered — `runTurn` calls `getContent` before every query and writes into `durableConfig.cachedReminders`.
- Missing files fail silently — not-covered.
- Per-source toggles via `claudeMdSources` from config — not-covered.

## Per-turn injection in the CLI

**Location**: `apps/claude-sdk-cli/src/entry/main.ts` (`runTurn`), `runAgent.ts`

**Description**: Each turn does three injection-ish things outside the SDK: refresh `durableConfig` from `mapConfig()`, refresh `cachedReminders` from `ClaudeMdLoader`, and compute the git delta string passed as `systemReminder`.

**Specific behaviours**:
- `durableConfig` mutated in place via `Object.assign(durableConfig, mapConfig())` before every query — not-covered.
- `cachedReminders` set to one-element array (joined CLAUDE.md content) per turn — not-covered.
- Git delta from `GitStateMonitor.getDelta()` passed as `systemReminder` — partial — doc names `GitDeltaInjector` as `[git delta]` appended to `systemReminder`; the existing behaviour is "the entire systemReminder is the git delta line."
- `GitStateMonitor.takeSnapshot()` called after the turn completes (excludes agent's own changes from the next delta) — not-covered.
- Conversation session and history files saved per turn (`session.saveSession()` pre-turn, `session.saveConversation()` post-turn) — not-covered.

## Git state monitor

**Location**: `apps/claude-sdk-cli/src/GitStateMonitor.ts`, `gitSnapshot.ts`, `gitDelta.ts`

**Description**: Snapshots `git branch / rev-parse HEAD / status --porcelain / stash list` in parallel and diffs vs. the previous snapshot. First-turn returns undefined (no baseline).

**Specific behaviours**:
- Tracks branch, HEAD short-sha, staged/unstaged/untracked file path sets, and stash count — not-covered.
- File-set diffs report added/removed counts only — not-covered.
- Snapshot taken post-turn (not pre-turn) so the agent's own edits don't appear in its next delta — not-covered.
- `[git delta]` prefix is hardcoded — not-covered.

## Audit log (`AuditWriter`)

**Location**: `apps/claude-sdk-cli/src/AuditWriter.ts`, wired in `main.ts` via `client.on('finalMessage', …)`

**Specific behaviours**:
- JSONL append to `~/.claude/audit/<session-id>.jsonl` — not-covered.
- One line per `finalMessage` event from the Anthropic stream (i.e. one per turn) — not-covered.
- Append failure is fatal: prints to `console.error` and `process.exit(1)` — not-covered — listed as known debt in project CLAUDE.md.

## Conversation session (resume / persistence)

**Location**: `apps/claude-sdk-cli/src/model/ConversationSession.ts`

**Description**: File-based session with a CWD marker (`.claude/.sdk-conversation-id`) pointing to a JSONL history (`~/.claude/conversations/<id>.jsonl`) and a CWD-local history of session IDs (`.claude/.sdk-conversation-history`).

**Specific behaviours**:
- `startFresh()` mints a random UUID and skips load — not-covered.
- `load()` reads the CWD marker; if absent, mints a UUID; if present, reads the home-dir JSONL and calls `Conversation.setHistory(...)` — not-covered.
- `saveSession()` writes the marker and appends the id to the CWD session-history list (de-duped) — not-covered.
- `saveConversation()` writes the JSONL — `writeFileSync` is non-atomic (listed as known debt) — not-covered.
- `createNew()` mints a fresh id and clears the conversation in place — not-covered.
- `--no-resume` flag forces `startFresh` regardless of marker — not-covered.

## History replay

**Location**: `apps/claude-sdk-cli/src/replayHistory.ts`, called from `main.ts` once at startup

**Specific behaviours**:
- Pure function: walks stored `BetaMessageParam[]` and produces `ReplayBlock[]` for the TUI — not-covered.
- Maps user text → prompt block, user tool_result → "↩ N results" appended to tools block, assistant text → response block, assistant thinking → thinking block (gated on `showThinking`), assistant tool_use → "→ name" tools block, assistant compaction → compaction block — not-covered.
- Walks the content array in order so text before tool_use shows above the tools block — not-covered.

## System prompts (hardcoded)

**Location**: `apps/claude-sdk-cli/src/systemPrompts.ts`

**Specific behaviours**:
- Five hardcoded strings appended to `systemPrompts` in `mapConfig`, after the SDK's `AGENT_SDK_PREFIX` — not-covered.
- No `SystemPromptBuilder` exists; the project root CLAUDE.md describes one but the implementation is a constant array — not-covered.

## Permissions / auto-approval policy

**Location**: `apps/claude-sdk-cli/src/permissions.ts`

**Description**: Zone-based permission policy. Maps a tool's `operation` (`read`/`write`/`delete`) to one of `Approve` / `Ask` / `Deny`, with different tables for "inside CWD" and "outside CWD."

**Specific behaviours**:
- Default zone: read=Approve, write=Approve, delete=Ask — not-covered.
- Outside-CWD zone: read=Approve, write=Ask, delete=Deny — not-covered.
- Path lookup: input field `file` (for `PreviewEdit`/`EditFile`) or `path` (everything else) — not-covered.
- `Pipe` tool: max of inner-step permissions; empty steps → Ask — not-covered.
- Unknown tool name → Deny — not-covered.
- Approve/Deny short-circuit the user prompt in `AgentMessageHandler` — not-covered.

**Doc coverage**: open question in the doc: "Approval policy for autonomous runs. Today the CLI auto-approves reads. Where does that policy live for headless agents?" — partial.

## Approval notify hook

**Location**: `apps/claude-sdk-cli/src/model/ApprovalNotifier.ts`, `IProcessLauncher.ts`, `NodeProcessLauncher.ts`

**Specific behaviours**:
- On `tool_approval_request`, schedules a process launch after `delayMs` (skipped if config is null) — not-covered.
- Stdin to the launched process is the JSON-serialised approval request — not-covered.
- On approval response (user answers Y/N or auto-policy fires), `cancel()` clears the pending timer — not-covered.
- `IProcessLauncher` abstract base, `NodeProcessLauncher` runs `sh -c <command>` (see file) — not-covered.

## AgentMessageHandler (controller)

**Location**: `apps/claude-sdk-cli/src/controller/AgentMessageHandler.ts`

**Description**: The CLI's `SdkMessage` consumer. Translates each SDK event into AppLayout calls. Maintains `lastUsage` / `usageBeforeTools` to compute marginal cost per tool batch.

**Specific behaviours**:
- Tool summary formatting from input (`path`/`file`/`url`/`query`/`pattern`/`description`) — not-covered.
- Per-tool-batch marginal-cost annotation appended to the sealed tools block on the next `message_usage` event — not-covered.
- Auto-approval policy is consulted; only `PermissionAction.Ask` results in a user-facing prompt — not-covered.
- Posts `tool_approval_response` back on `consumerChannel` — not-covered.
- `turn_content` is currently a no-op in the handler (kept "available for consumers that need it") — not-covered.

## TUI surface (`AppLayout`, renderers, screen, ANSI)

**Location**: `apps/claude-sdk-cli/src/AppLayout.ts`, `apps/claude-sdk-cli/src/view/*.ts`, `apps/claude-sdk-cli/src/model/*.ts`, `packages/claude-core/src/{ansi,screen,input,reflow,renderer,viewport,sanitise,status-line}.ts`

**Specific behaviours**:
- Alt-buffer rendering, sync-update markers, raw input mode — not-covered (doc names TUI as moving to its own binary; rendering specifics are explicitly out of scope per the mission brief).
- Two modes: `editor`, `streaming` — not-covered.
- Command mode (Ctrl+/) for clipboard text/file/image attachment, session new — not-covered.
- Approval flash timer (~1 Hz) — not-covered.
- Y/N keys resolve queued approvals; ←/→ navigate pending tools; space expand/collapse — not-covered.
- Resize handler with 300ms debounce — not-covered.
- Sealed blocks flushed to scrollback on transitions out of streaming — not-covered.
- `appendToLastSealed` for retroactive tools-block annotation — not-covered.
- Sanitises lone-surrogate UTF-16 characters from streaming text — not-covered.

**Out-of-scope (apparent)**: doc deliberately moves the TUI to its own binary and considers presentation concerns transports' problem.

## Status state and renderer

**Location**: `apps/claude-sdk-cli/src/model/StatusState.ts`, `view/renderStatus.ts`

**Specific behaviours**:
- Token totals accumulated across all turns — not-covered.
- Last context used and context window taken from each `message_usage` — not-covered.
- Cost total accumulated — not-covered.
- Session name (from `--name`), model, CWD basename — not-covered.

## Tools — design contracts visible across the registry

**Location**: `packages/claude-sdk-tools/src/*/`

**Description**: Every tool ships an `input_schema`, an `output_schema`, an `input_examples` array, and a handler returning `{ textContent, attachments? }`. Tools are constructed by factory functions taking dependencies (`IFileSystem`, `ITypeScriptService`, `RefStore`, the registry for `Pipe`).

**Specific behaviours**:
- `defineTool` identity wrapper preserves precise Zod types through to `AnyToolDefinition` — not-covered.
- `operation` field labels each tool `read | write | delete` (default `read`) for the permissions layer — not-covered.
- `defer_loading` flag passed through ATU transform — not-covered.
- `input_examples` ship on wire; ATU disabled strips them; tools provide multiple realistic examples — not-covered.
- `attachments` (PDF documents, images) returned by `ReadFile` are placed as native API content blocks in the tool_result alongside the text — not-covered.

## ReadFile (binary handling)

**Location**: `packages/claude-sdk-tools/src/ReadFile/`

**Specific behaviours**:
- `mimeType` input parameter: `text/plain` (default), `application/pdf`, `image/*` — not-covered.
- Detects MIME via header bytes (`file-type` package); rejects mismatch between declared and detected type — not-covered.
- 32MB hard cap for non-text reads; 5MB cap for base64 image payload — not-covered.
- Returns `{ type: 'binary', mimeType, sizeKb }` text plus an attachment block, OR `{ type: 'content', values, totalLines }` for text — not-covered.

## Pipe tool

**Location**: `packages/claude-sdk-tools/src/Pipe/Pipe.ts`

**Description**: Composes `read`-operation tools in a single tool call. The pipe value is threaded into each step as `input.content`.

**Specific behaviours**:
- Constructed with a list of valid pipe-source tool definitions — not-covered.
- Enforces `tool.operation === 'read'` per step — not-covered.
- Re-parses each step's merged input against the step tool's `input_schema` — not-covered.

## EditFile / PreviewEdit pair

**Location**: `packages/claude-sdk-tools/src/EditFile/`

**Specific behaviours**:
- In-memory `Map<patchId, PreviewEditOutputType>` shared between `PreviewEdit` and `EditFile` — not-covered.
- SHA-256 of original file content stored alongside the new content for `EditFile` to validate against — not-covered.
- `previousPatchId` chaining: read the previous patch's `newContent` as the base for the next preview — not-covered.
- `lineEdits` applied bottom-to-top so line numbers in subsequent edits don't shift; `textEdits` applied after in order — not-covered.
- `append`, `lineEdits`, and `textEdits` modes with mutual-exclusivity rules — not-covered.

## Exec tool

**Location**: `packages/claude-sdk-tools/src/Exec/`

**Specific behaviours**:
- Pipelined commands (stdout → stdin) across `commands` arrays — not-covered.
- Multi-step `sequential | bail_on_error | independent` chaining — not-covered.
- Built-in deny rules (`builtinRules.ts`) checked before execution; returns a structured `BLOCKED:` message instead of running — not-covered.
- `stripAnsi` option to clean output — not-covered.
- Per-command `cwd`, `env`, `stdin`, `redirect`, `merge_stderr` — not-covered.

## TypeScript service (LSP-like)

**Location**: `packages/claude-sdk-tools/src/typescript/TsServerService.ts`, `ITypeScriptService.ts`; tools in `TsDiagnostics`, `TsHover`, `TsReferences`, `TsDefinition`

**Specific behaviours**:
- Long-lived `tsserver` subprocess started at CLI launch — not-covered.
- On-demand `open` per file; cached in `#openFiles` set — not-covered.
- Per-request timeout (default 15s) — not-covered.
- On process exit, all pending requests reject — not-covered.
- Stopped during CLI cleanup — not-covered.
- Tools constructed via `createTs*` factories that close over the service — not-covered.

## Filesystem abstraction

**Location**: `packages/claude-core/src/fs/interfaces.ts`, `packages/claude-sdk-tools/src/fs/NodeFileSystem.ts`, `nodeFs.ts`

**Specific behaviours**:
- `IFileSystem` abstract base with `cwd`, `homedir`, `exists`, `readFile`, `writeFile`, `deleteFile`, `deleteDirectory`, `find`, `appendFile`, `stat`, `readdir`, `realpath`, `getEnvVar` — not-covered.
- `find` is a default method on the base that delegates to `walk(this, …)` — not-covered.
- `expandPath(value, fs)` handles `~`, `$VAR`, `${VAR}` against the fs's `homedir()` and `getEnvVar` — not-covered.

## Logger (CLI)

**Location**: `apps/claude-sdk-cli/src/logger.ts`, `redact.ts`

**Specific behaviours**:
- Winston file logger at `claude-sdk-cli.log` (CWD-relative) — not-covered.
- Five levels: trace, debug, info, warn, error — not-covered.
- String truncation and large-object summarisation in the log format — not-covered.
- `redact` walks payloads and substitutes a fixed sensitive-key list (authorization, x-api-key, api_key, password, secret, token, etc.) with `[REDACTED]` — not-covered.
- `ILogger` is an SDK-public type — not-covered.

## mcp-exec server

**Location**: `packages/mcp-exec/src/entry/{index,cli}.ts`

**Specific behaviours**:
- Exposes `@shellicar/claude-sdk-tools` `Exec` as a single MCP tool — not-covered.
- Uses `StdioServerTransport` from the MCP SDK — not-covered.
- Wraps tool output as `content: [{ type: 'text', text: JSON.stringify(result) }]` plus `structuredContent` — not-covered.
- `isError: !result.success` — not-covered.

## Build-version injection

**Location**: imports of `@shellicar/build-version/version` (e.g. `AnthropicClient.ts`, CLI `help.ts`)

**Specific behaviours**:
- Build-time GitVersion data (version, branch, sha, commitDate, buildDate) injected as a module by an esbuild plugin — not-covered.
- `AnthropicClient` emits `user-agent` containing the SDK package version — not-covered.

## Server tools (web search, web fetch, code execution)

**Location**: `apps/claude-sdk-cli/src/buildServerTools.ts`, `buildAtuTransform.ts`

**Specific behaviours**:
- `web_search` and `web_fetch` versioned types (`web_search_20250305` / `web_search_20260209`, `web_fetch_20250910` / `web_fetch_20260209`) — not-covered.
- `allowed_callers` resolved from `'direct' | 'code_execution'` to the configured code-execution tool version — not-covered.
- ATU "tool_search" (`bm25` / `regex` variants) appended when ATU+searchTool is configured — not-covered.
- ATU `allowProgrammaticExecution` list controls which client tools get the code-execution caller — not-covered.
- The CLI's prompts emit a copyright/usage instruction block (see `web_search_copyright_requirements`) — not-covered.

## Summary

### Real gaps — behaviours in code that the doc doesn't address at all

1. **OAuth flow and credential lifecycle** — `AnthropicAuth`, local/manual redirect modes, port 3001 callback, per-request token refresh in `TokenRefreshingAnthropic`. The doc lists "Authentication on remote transports" as a non-goal but doesn't address the agent's outbound login at all.
2. **Anthropic-protocol details in `buildRequestParams`** — cache_control placement (last user message, last tool, last system prompt entry), beta-string composition including `COMPACT_BETA`, `context_management.edits` for clear_thinking / clear_tool_uses / compact, `cache_control { scope: 'global' }`, the `AGENT_SDK_PREFIX` constant, ATU `transformTool` hook applied to wire tools. Doc collapses all of this into "buildRequestParams moves inside the model."
3. **Audit log** — `client.on('finalMessage', …)` → JSONL per-session file under `~/.claude/audit/`; fatal-on-error semantics. Not in `What carries over`, not in `What changes`.
4. **Conversation session persistence** — random UUID per session, CWD-marker file, home-dir history JSONL, CWD session-id history list, `--no-resume`, post-turn save. Doc's `Session` interface is `{ id, load(), save(snapshot) }` and explicitly leaves persistence out of scope; the resume protocol is invisible there.
5. **Configuration system** — layered `ConfigLoader` with two paths, watcher with 100ms debounce, `pathFields` resolution-per-source, null-deletes in merge, two-layer raw+resolved model, idle-phase gating in the CLI. Doc says "configuration is constructed by the caller" with no further structure.
6. **Permissions / auto-approval policy** — zone-based (inside CWD vs outside) over (read/write/delete) with Approve/Ask/Deny. Pipe nests by max. Doc has an open question about where this policy lives for headless runs but doesn't account for the existing zone model.
7. **Hook system (approval notify)** — per-config command launched on `tool_approval_request` with delay and stdin payload. Doc names a `HookInjector` for per-turn injection, which is a different surface.
8. **Ref tooling** — `RefStore.walkAndRef` ref-swapping large strings, the Ref tool API, the per-query `transformToolResult` hook the SDK exposes. Comment in `What carries over` mentions transforming large values exists in source but the architecture treats it as out of scope.
9. **Empty-tool-use retry and tool_use stop semantics** — QueryRunner retries up to twice when `stopReason === 'tool_use'` with no tool_use blocks, then emits an error. Not mentioned.
10. **Tool authoring contract** — `output_schema`, `input_examples`, `operation`, `defer_loading`, `attachments` flowing through to `tool_result.content`. Doc names tool input → output but not the existing decorative-field set or the attachment passthrough.

### Underspecified — behaviours the doc mentions or implies but doesn't account for architecturally

1. **SDK event vocabulary rename** — doc names base events `text_delta`, `thinking_delta`, `tool_use`, `usage`, `turn_ended`, `approval_request` etc.; the existing SDK emits a different set (`message_text`, `message_thinking`, `tool_approval_request`, `done`, `message_usage`, plus `query_summary`, `turn_content`, `message_compaction_start`, `message_compaction`, `tool_error`, `server_tool_use`, `server_tool_result`). The translation is not shown.
2. **Per-turn injection** — doc names `TurnInjector` (`GitDeltaInjector`, `ClaudeMdInjector`, `HookInjector`). Today: `cachedReminders` is part of `DurableConfig` and applied once per conversation (fresh or post-compaction); `systemReminder` is one-shot first-turn-only inside a query; the git delta is the entire `systemReminder` string today, not appended to it; CLAUDE.md content is one cached reminder, re-read every turn rather than only "on fresh conversation."
3. **ControlChannel surface** — doc names it as the outbound primitive but the existing CLI uses two `ControlChannel`s (one outbound `SdkMessage`, one inbound `ConsumerMessage`) and the `IPublisher` / `ISubscriber` split is not visible in the doc.
4. **Cancellation reach** — doc says cancellation collapses to one AbortController and threads to tool handlers (new). Today cancellation reaches the in-flight HTTP request and resolves pending approvals; tool handlers do not take a signal and the SDK has no `ToolCancelledError`.
5. **Approval coordinator** — doc names `approval_settled` as a new real event and notes the current absence. The `reset()` method that allows reuse across queries isn't accounted for.
6. **History snapshots** — doc names `HistorySnapshot` and `agent.history()`. Today there is no history-emitter API; the CLI reads/writes JSONL directly via `ConversationSession` and replays through `replayHistory` for the TUI.
7. **Server tools** — present in the request shape and in stream events; doc doesn't mention them, even in "What carries over."
8. **Beta flags / cache TTL** — public surface (`AnthropicBeta`, `CacheTtl`, `COMPACT_BETA`) is invisible in the doc but determines the wire shape today.

### Out-of-scope (apparent) — behaviours that look like gaps but the doc deliberately excludes

1. **TUI rendering specifics** — `AppLayout`, command mode, approval flash, sealed-block flushing, resize debounce, ANSI plumbing in `claude-core`. Doc moves the TUI to a separate binary.
2. **Pricing table and `getContextWindow`** — these inform the `usage` event payload today but the doc's `usage` event leaves pricing as an implementation concern.
3. **Logger and redaction** — winston file logger and the sensitive-key redact list belong to the CLI's local diagnostics, not the agent protocol.
4. **Filesystem abstraction (`IFileSystem`)** — used everywhere but a deployment concern, not in the protocol surface.
5. **TypeScript service (`tsserver`)** — long-lived sub-process is a CLI-side tool implementation, not architectural.
6. **mcp-exec server** — wraps `Exec` as MCP; entirely an external integration that consumes the tools package and doesn't go through the agent protocol.
7. **CLI argument parsing** (`--file`, `--prompt`, `--name`, `--model`, `--no-resume`, `--init-config`) — CLI surface.
8. **Build-version injection** — build-tooling concern.
9. **`ApprovalNotifier` mechanism (process launch)** — deployment-specific hook; the doc's "external commands" `HookInjector` is per-turn input augmentation, a different role.
