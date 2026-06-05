# Architecture Refactor Plan

## Context

Identified 2026-04-06. The SDK and CLI work correctly but several classes carry more
responsibilities than they should, which makes them harder to extend and impossible to
unit test in isolation. This plan captures the agreed design direction and the ordered
steps to get there.

The core invariant: **the CLI+SDK must work at every commit**. Each substep is a
complete, shippable unit. If a substep goes wrong, revert it — all previous substeps
remain intact. Nothing is abandoned; rollback cost is always exactly one step.

---

## Target Design

### Architecture

The CLI follows a three-layer model:

**State** — pure data and transitions. No rendering, no I/O. Each state object is a
pure state machine: methods take the current state to a new state. Fully testable
without any terminal or ANSI knowledge.

**Renderer** — pure functions `(state, cols) → string[]`. Given a state and the current
terminal width, produce lines of text. No knowledge of screen height, scroll position,
or other components. Testable with plain string assertions.

**ScreenCoordinator** — owns the physical screen. Handles events (keypress, stream data,
resize). After handling each event it: updates the relevant state, calls all renderers
with the current `cols`, allocates rows across the outputs, and writes the assembled
result to the terminal. The coordinator is the single trigger for re-renders — nothing
else writes to the screen.

This is deliberately pull-based and explicit: the coordinator decides when to render and
pulls from renderers. No data binding, no reactive subscriptions. The clean separation
between state and rendering is what enables the coordinator to do incremental re-renders
(only re-render components whose state changed) later without restructuring anything —
but that is a future optimisation, not a current requirement.

### SDK

| Class | Responsibility |
|-------|---------------|
| `Conversation` | Pure data: ordered messages, role alternation, compaction trim. No I/O. |
| `ConversationStore` | Load/save a `Conversation` from a JSONL file. |
| `RequestBuilder` | Pure function: `(RunAgentQuery, messages) → BetaMessageStreamParams`. |
| `StreamProcessor` | Raw Anthropic stream events → typed blocks. Already `MessageStream`, keep as-is. |
| `ToolRunner` | Validate input, call handler, transform result. |
| `AgentLoop` | Orchestrate: Conversation + RequestBuilder + StreamProcessor + ToolRunner. The loop itself. |

Auth is already well-decomposed. No changes planned there.

### CLI — State layer

| Class | Responsibility |
|-------|---------------|
| `EditorState` | Lines, cursor position, transitions (`handleKey`). No rendering, no I/O. |
| `ConversationState` | Sealed blocks, active block, flush boundary. No rendering. |
| `ToolApprovalState` | Pending tools, selection, approval promise queue. No rendering. |
| `StatusState` | Token/cost accumulators. No rendering. |
| `CommandModeState` | Mode flag, attachments, preview state. No rendering. |

### CLI — Renderer layer

| Function | Signature |
|----------|----------|
| `renderEditor` | `(EditorState, cols) → string[]` |
| `renderConversation` | `(ConversationState, cols, availableRows) → string[]` |
| `renderToolApproval` | `(ToolApprovalState, cols) → string[]` |
| `renderStatus` | `(StatusState, cols) → string` |
| `renderCommandMode` | `(CommandModeState, cols) → string[]` |

### CLI — Coordinator and handlers

| Class | Responsibility |
|-------|---------------|
| `ScreenCoordinator` | Owns the physical screen. Routes events. Calls renderers. Allocates rows. Assembles and writes output. (Slimmed `AppLayout`.) |
| `AgentMessageHandler` | Maps `SdkMessage` events → state mutations. Extracted from `runAgent.ts`. |
| `PermissionPolicy` | Auto-approve/deny logic. Currently split across `permissions.ts` and `runAgent.ts`. |

---

## Steps

### Step 1 — Split `Conversation` from `ConversationStore`

**1a — Extract `Conversation` (pure data)**
- `Conversation`: holds `#items`, `push()`, `remove()`, `messages` getter, role-alternation,
  compaction trim. No file I/O.
- `ConversationStore`: wraps `Conversation`, loads from JSONL in constructor, calls save on
  every mutation.
- `AgentRun` receives `Conversation` instead of `ConversationHistory`.
- External API unchanged (`historyFile` option still works).
- **Estimate: 1 | Risk: Low** — single failure mode: forgetting to call save in
  `ConversationStore.push()`. Obvious, fast to catch.
- **Tests: `Conversation` becomes fully unit-testable** — role alternation, compaction clear,
  push/remove, trim logic. All pure assertions, no mocks needed. +1 for tests.

**1b — History replay in TUI**
- On startup, walk the messages loaded from file and replay them into `ConversationDisplay`
  so prior turns are visible.
- Requires decisions: what to show for compaction blocks, tool use/result pairs, thinking
  blocks. Get this wrong → confusing display, not a crash.
- Depends on 1a (cleanly) but is a separate commit.
- **Estimate: 2 | Risk: Medium** — decisions about what to display, runtime-visible.
- **Tests: partial** — the parse-to-display-events function is testable if extracted. +1.

---

### Step 2 — Extract `RequestBuilder`

- Extract `AgentRun.#getMessageStream` params-building into a pure function/class:
  tools mapping, betas resolution, context_management config, system prompts, cache_control,
  thinking flag → `BetaMessageStreamParams`.
- `#getMessageStream` keeps the stream call, delegates params to `RequestBuilder`.
- No UI impact, no external API change.
- **Estimate: 1 | Risk: Very Low** — TypeScript catches missed fields. API error on first
  run if anything wrong. Fast to diagnose.
- **Tests: clean** — one test per beta feature: "given compact enabled, request has compact
  edit". Pure assertions. +1 for tests.

---

### Step 3 — Extract `EditorState` and `EditorRenderer` from `AppLayout`

Do these in order. Each substep compiles and runs standalone.

**3a — Extract `EditorState`**
- Move `#editorLines`, `#cursorLine`, `#cursorCol` to `EditorState`.
- Expose read-only accessors. `AppLayout` holds `this.#editorState` and reads from it.
- Key handling and rendering stay in `AppLayout` for now.
- **Estimate: 1 | Risk: Low** — TypeScript finds every missed reference at compile time.
- **Tests: marginal at this point** — state is there but transitions aren't yet.

**3b — Move key handling into `EditorState.handleKey(key)`**
- `AppLayout.handleKey` routes: if editor mode → `this.#editorState.handleKey(key)`.
- Must be done atomically — extract AND update call site in same commit. No gap where
  neither has the logic.
- Edge cases: backspace at col 0 merges lines, Enter mid-line splits, multi-line paste,
  word jump at line boundary. These are where regressions hide.
- **Estimate: 2 | Risk: Medium-High** — runtime edge case regressions, caught by typing.
- **Tests: clean and valuable** — pure state machine with no ANSI noise. Test every edge
  case: backspace at line start, Enter mid-line, Ctrl+Left, paste. High confidence. +2.

**3c — Extract `EditorRenderer`**
- Move the editor region render logic out of `AppLayout.render()` into a pure function
  `renderEditor(state: EditorState, cols: number): string[]`.
- `AppLayout.render()` calls `renderEditor(this.#editorState, cols)` for the editor region.
- Visual regression if column width or ANSI cursor placement is wrong — visible immediately.
- **Estimate: 1 | Risk: Medium** — fast feedback, obvious if wrong.
- **Tests: clean** — `renderEditor(state, cols)` is a pure function. String assertions
  without needing to instantiate any class. +1.

---

### Step 4 — Extract `AgentMessageHandler` from `runAgent.ts`

**4a — Stateless cases**
- Move `message_thinking`, `message_text`, `message_compaction_start`, `message_compaction`,
  `done`, `error`, `query_summary` into `AgentMessageHandler`.
- Constructor takes state objects (`ConversationState`, `StatusState`), `logger`, model, cacheTtl.
  Handler mutates state directly; coordinator re-renders after each message.
- `port.on('message', (msg) => handler.handle(msg))`.
- **Estimate: 1 | Risk: Low** — straight delegations, TypeScript catches missing refs.
- **Tests: clean** — pass real state objects, assert state mutations for each message. +1.

**4b — Stateful cases**
- Move `usageBeforeTools` tracking and delta calculation.
- Move `toolApprovalRequest` async function.
- The invariant: capture usage at start of first tool batch, compute delta on next
  `message_usage`, then null. Getting the reset timing wrong → wrong delta annotation.
  Not a crash, but a wrong number on the tools block.
- **Estimate: 1-2 | Risk: Medium** — runtime-visible wrong number, needs a tool-use
  interaction to catch.
- **Tests: clean** — fire a sequence of tool+usage messages, assert delta annotation
  string. Catches the reset-timing bug. +1.

---

### Step 5 — Extract state and renderers from `AppLayout`

Each substep extracts one concern: a `*State` class (pure data + transitions) and a
`render*` pure function (state + cols → lines). Both move together in one commit so
the app is always in a working state. `AppLayout` holds the state objects and calls
the render functions.

**5a — Extract `StatusState` + `renderStatus`**
- Move the 5 token/cost accumulators to `StatusState`. Move the status line render
  logic to `renderStatus(state, cols): string`.
- `AppLayout` holds `this.#statusState`, calls `renderStatus` in its render pass.
- **Estimate: 1 | Risk: Low** — pure state + pure function. Visible immediately if wrong.
- **Tests: clean** — given usage sequence, assert state totals and render output. +1.

**5b — Extract `ConversationState` + `renderConversation`**
- Move sealed blocks, active block, flush count, `transitionBlock`, `appendStreaming`,
  `completeStreaming`, `appendToLastSealed` to `ConversationState`.
- Move render logic to `renderConversation(state, cols, availableRows): string[]`.
- The flush-to-scroll boundary is subtle — blocks flushed to scroll are permanently written.
  Getting `#flushedCount` wrong causes double-rendering or missing content.
- **Estimate: 2 | Risk: Medium** — flush logic is the dangerous part, visible but confusing.
- **Tests: partial** — state transitions yes; flush-to-scroll boundary needs care. +1-2.

**5c — Extract `ToolApprovalState` + `renderToolApproval`**
- Move pending tools list, selection, expand/collapse, approval promise queue
  (`#pendingApprovals`) to `ToolApprovalState`.
- Move render logic to `renderToolApproval(state, cols): string[]`.
- The async coordination — resolve functions in an array, keyboard handler pops them —
  must move together. Splitting this across two commits creates a broken state.
- **Estimate: 2 | Risk: Medium-High** — async approval flow, only caught during a
  tool-use interaction.
- **Tests: valuable** — async approval flow, cancel flow, keyboard navigation. +2.

**5d — Extract `CommandModeState` + `renderCommandMode`**
- Move `#commandMode`, `#previewMode`, `#attachments` to `CommandModeState`.
- Move `#buildCommandRow` and `#buildPreviewRows` logic to `renderCommandMode(state, cols): string[]`.
- The clipboard reads are async; the attachment store interaction must move with the state.
- **Estimate: 2 | Risk: Medium** — async clipboard flow, attachment state coordination.
- **Tests: partial** — command dispatch logic testable; clipboard reads need mocking. +1.

**5e — `ScreenCoordinator` cleanup**
- By this point all state and rendering logic has moved out. `AppLayout` becomes pure
  wiring: holds state objects, routes keyboard events, calls render functions, assembles
  output, writes to screen.
- Rename to `ScreenCoordinator`.
- **Estimate: 1 | Risk: Low** — routing logic, visible immediately if wrong.
- **Tests: marginal** — routing logic testable; screen output not. —

---

## Summary

| Step | Estimate | Risk | Tests (additional) |
|------|----------|------|-------------------|
| 1a Conversation split | 1 | Low | +1 |
| 1b History replay | 2 | Medium | +1 |
| 2 RequestBuilder | 1 | Very Low | +1 |
| 3a EditorState | 1 | Low | — |
| 3b EditorState.handleKey | 2 | Medium-High | +2 |
| 3c EditorRenderer | 1 | Medium | +1 |
| 4a MessageHandler stateless | 1 | Low | +1 |
| 4b MessageHandler stateful | 1-2 | Medium | +1 |
| 5a StatusState + renderStatus | 1 | Low | +1 |
| 5b ConversationState + renderConversation | 2 | Medium | +1-2 |
| 5c ToolApprovalState + renderToolApproval | 2 | Medium-High | +2 |
| 5d CommandModeState + renderCommandMode | 2 | Medium | +1 |
| 5e ScreenCoordinator cleanup | 1 | Low | — |
| **Total** | **19-21** | | **+13-14** |

Refactoring alone: ~19-21 units. With tests written at each step: ~32-35 units.

The steps with the best test ROI (high value, catches real bugs): **1a, 2, 3b, 4b**.
Start there. The rest can follow.
