# Feature comparison: claude-sdk-cli vs Claude Code, with MVP and TUI decisions

Filled in via a block-by-block walkthrough. See the **Summary** at the end for the consolidated MVP.

- **MVP** = the agent
- **TUI** = the local TUI app
- **NO** = explicit exclusion (only entries named directly)
- *(blank)* = not in scope, or designed-for but not v1, or deferred to its own design pass

---

## Authentication & startup

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| OAuth login flow (interactive) | ✓ PKCE | ✓ | | must |
| Credential exchange with its own encryption layer (handshake-established, independent of transport) | ✗ | ? | must | must |
| Token refresh | ✓ | ✓ | must | |
| API key fallback | ✗ | ✓ | | |
| Spawn agent with specific config | ✓ via CLI flags | ✓ | must (handshake + initial-message config) | |
| Settings file (user-level) | ✓ | ✓ | | |
| Settings file (project-level) | ✓ | ✓ | | |
| Settings hot reload | ✓ | partial | | |
| Init config file | ✓ `--init-config` | ✗ | | |

## Session lifecycle

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| New session | ✓ | ✓ | | |
| Resume saved session | ✓ | ✓ | | |
| Browse session list | ✗ | ✓ | | |
| Persistent conversation storage | ✓ JSONL | ✓ | | |
| Manual `/compact` | ✗ | ✓ | NO | NO |
| Auto-compaction | ✗ (removed) | ✓ | NO | NO |
| Checkpoint state | ✗ | ✓ | | |
| Audit log | ✓ | partial | must | |

## Tool surface

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| Tool registry | ✓ | ✓ | must | |
| Dynamic tools (add/remove at runtime) | ✗ | partial | want | |
| File read (text) | ✓ | ✓ | must | |
| File read (PDF, images as binary) | ✓ | ✓ | must | |
| File edit | ✓ | ✓ | must | |
| File create | ✓ | ✓ | | |
| File delete | ✓ | partial | | |
| File find / glob | ✓ | ✓ | must | |
| File search by content | ✓ | ✓ | must | |
| Slice / inspect (Head, Tail, Range) | ✓ | partial | | |
| Shell execution | ✓ | ✓ | must | |
| Background bash | ✗ | ✓ | NO | NO |
| Web search | ✓ | ✓ | | |
| Web fetch | ✓ | ✓ | | |
| Anthropic code execution server tool | ✓ | partial | | |
| TypeScript LSP tools | ✓ | ✗ | | |
| Tool composition (Pipe) | ✓ | ✗ | | |
| Large-output paging (Ref) | ✓ | ✓ (auto-save to file) | | |
| Notebook editing | ✗ | ✓ | | |
| Todo tool | ✗ | ✓ | | |
| Plan mode | ✗ | ✓ | | |
| Subagent dispatch | ✗ | ✓ | | |
| MCP servers | ✗ | ✓ | want | |
| Agent teams | ✗ | ✓ | | |
| Computer use | ✗ | ✓ | | |

## Approval & permissions

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| Approval flow (request / respond on protocol) | ✓ | ✓ | must | must |
| Distributed approvals (multi-client coordination) | ✗ | ✗ | | |
| Zone-based auto-approve | ✓ | partial | | |
| Permission modes (acceptEdits / plan / bypass) | ✗ | ✓ | | |
| Per-tool overrides | ✓ (prev CLI) | ✓ | | |
| Skip permissions for autonomous runs | ✗ | ✓ | | |
| ApprovalNotifier (process launch on approval) | ✓ | ✓ | NO | NO |

## Input

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| Multi-line input | ✓ | ✓ | | must |
| Editor primitives (cursor, backspace, arrow nav within line) | ✓ | ✓ | | must |
| Command mode (Ctrl+/ → key shortcut entry) | ✓ | ✗ | | must |
| Attachments (text / files / images) | ✓ command mode | ✓ @ + paste + drag | must | must |
| @-file mentions | ✗ | ✓ | | NO |
| Slash commands (built-in set) | partial via command mode | ✓ | | NO |
| Custom slash commands | ✓ via command mode | ✓ | | NO |
| Vim mode | ✗ | ✓ | | |
| Voice dictation | ✗ | ✓ | | |

## Display & status

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| Alt-buffer ANSI rendering | ✓ | ✓ | | must |
| Text reflow (ANSI-aware, grapheme-aware wrapping) | ✓ via `claude-core/reflow` | ✓ | | must |
| Window resize handling (re-render on resize, debounced) | ✓ | ✓ | | must |
| Flicker-free rendering (sync-update / SGR 2026) | ✓ | ✓ (fullscreen mode) | | |
| Sealed block flushing to scrollback | ✓ | ? | | |
| Streaming text display | ✓ | ✓ | | must |
| Streaming thinking display | ✓ (configurable) | ✗ | | |
| Tool call rendering | ✓ | ✓ | | want |
| Tool result expansion / collapse (space toggle) | ✓ | partial (recent) | | |
| Approval flash timer (visual pulse on pending) | ✓ | ✗ | | |
| Pending approval navigation (arrow keys) | ✓ | ✗ | | |
| Surrogate / lone-codepoint sanitisation in streaming text | ✓ | ? | | |
| Status line (model, cost, tokens, CWD) | ✓ | ✓ | | |
| Customisable status line | ✗ | ✓ | | |
| Output styles | ✗ | ✓ | | |
| Cost per turn (marginal annotation) | ✓ | ✓ | | |
| Cost limits / quotas | ✗ | partial | | |
| Context-window usage indicator | ✓ | ✓ | | |
| Mouse support | ✗ | ✓ (fullscreen) | | |

## Context management

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| CLAUDE.md auto-loading | ✓ from 4 paths | ✓ | | want |
| `/memory` (edit from TUI) | ✗ | ✓ | | NO |
| Auto memory (autonomous append) | ✗ | ✓ | NO | NO |
| `/init` (bootstrap project CLAUDE.md) | ✗ | ✓ | | NO |
| `@`-file inline expansion | ✗ | ✓ | | NO |
| Skills (instructions + tool subset, loaded at init) | ✗ | ✓ | want | |
| Mission (cross-session shared artefact / context) | ✓ (prev CLI) | ✗ | | |
| Persistent task list (carry-over todos across /clear, /new) | ✓ (prev CLI) | ✗ | | |

## Slash commands

These are Claude Code's slash commands, kept for comparison. They don't map cleanly to MVP or TUI columns because this is a fundamentally different design. In this architecture they collapse into: uniform config operations (all config is bootstrapped at spawn and dynamically updatable at runtime — model, settings, permissions all use the same primitive), command-mode conveniences in this TUI (`/clear`, `/help`), or Tower concerns (`/agents`). The MVP/TUI columns are left blank intentionally — the capability that matters is "config: bootstrap + dynamic update", not the individual commands.

| Command | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| `/clear` | ✗ | ✓ | | |
| `/help` | partial | ✓ | | |
| `/model` | partial | ✓ | | |
| `/cost` | partial | ✓ | | |
| `/status` | partial | ✓ | | |
| `/config` | ✗ | ✓ | | |
| `/permissions` | ✗ | ✓ | | |
| `/agents` | ✗ | ✓ | | |
| `/vim` | ✗ | ✓ | | |

## Extension surface

Most of this block is Claude Code's bolt-on mechanisms for reaching beyond a single-client local session. Because their core is one terminal driving one local session, each way of extending past that is a separate feature: channels push events in via an MCP server, Remote Control hands a local session off to web/mobile, web sessions spin up a fresh cloud sandbox, Slack spawns a session from a mention.

This architecture has one bridge protocol that subsumes all of them — any client can connect, push messages, and receive events. So these aren't features to build; they fall out of the protocol:

| Claude Code mechanism | This architecture |
|----------------------|-------------------|
| Channels (push events in via MCP) | a client sending inbound messages |
| Remote Control (web / mobile handoff) | a Tower client connecting to the agent |
| Web sessions (fresh cloud) | an agent spawned with a bridge |
| Slack (spawn from mention) | a client bridging Slack |

Channels in particular: an external system pushing an event is a client sending an inbound message; Claude replying is the agent emitting events the client consumes; the sender allowlist is sender identity plus gating; the permission relay is distributed approvals. All emergent. The MVP/TUI columns stay blank — nothing here is a feature to build. (Plugins are also blank: you own the harness, so a plugin system isn't necessary.)

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| Hooks (PreToolUse / PostToolUse / etc.) | partial | ✓ | NO | NO |
| Plugins | ✗ | ✓ | | |
| Channels (MCP push events into session) | ✗ | ✓ | | |
| Scheduled tasks | ✗ | ✓ | | |
| Remote Control (web / phone continuation) | ✗ | ✓ | | |

## Output modes / bridges

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| Stdio bridge (bidirectional) | ✗ | ✓ output-only | must | |
| HTTP / WebSocket / NATS bridges | ✗ | ✗ | | |

## Architecture & deployment

| Feature | claude-sdk-cli | Claude Code | MVP | TUI |
|---------|----------------|-------------|-----|-----|
| Agent runs as standalone process, no embedded UI (clients connect via bridge) | partial (refuses non-TTY) | ✓ Agent SDK | must | |
| Multiple bridge clients (N clients on one bridge) | ✗ | ✗ | | |
| Multiple bridges (agent runs N bridges at once) | ✗ | ✗ | | |
| Multiple agents per process (1 process hosts N agents) | ✗ | ✗ | | |
| Sandboxed environment (Docker etc.) | ✗ | partial | | |
| Sandboxed bash tool | partial | ✓ | | |
| Session portability across processes | ✗ | partial | | |

---

## Summary

The MVP is a **single agent process, one stdio bridge, one TUI client, basic approvals**. The multi-client / multi-bridge / distributed capabilities are designed into the protocol but not built in v1 — proving them is a POC, not a blocker.

### MVP must (agent)

- Credential exchange (encrypted, handshake-established)
- Token refresh
- Spawn with specific config (handshake + initial-message)
- Audit log (doubles as persistence)
- Tool registry + bundled tools: read (text + PDF/images), edit, find/glob, search, exec
- Approval flow (basic, single-client)
- Attachments (protocol side)
- Stdio bridge (bidirectional)
- Standalone process, no embedded UI

### MVP want (agent)

- Dynamic tools (add/remove at runtime)
- MCP servers
- Skills (instructions + tool subset)
- Runtime model switch

### TUI must

- OAuth login flow, credential exchange
- Multi-line input, editor primitives, command mode
- Attachments
- Alt-buffer rendering, text reflow, resize handling, streaming text display
- Approval render / respond

### TUI want

- CLAUDE.md auto-loading
- Tool call rendering

### Designed-for, not v1 (POC territory)

The protocol supports these; v1 doesn't implement them. Proving they work requires building the feature, so it's a POC exercise rather than MVP.

- Distributed approvals
- Multiple bridge clients (N clients on one bridge)
- Multiple bridges (agent runs N at once)
- Multiple agents per process

### Deferred (own design pass needed)

These have large design ramifications and need their own pass before any decision.

- Session lifecycle: resume, persistence, /clear, new-session semantics
- Session portability across processes
- Mission (cross-session shared artefact)
- Persistent task list (carry-over todos)

### NO (deliberate exclusions)

- Compaction (manual + auto)
- Auto memory
- Background bash
- Plan mode
- Hooks (PreToolUse / PostToolUse / etc.)
- ApprovalNotifier (external process launch on approval)
- Vim mode, voice dictation
- @-file mentions, slash-commands-as-input
- /memory, /init
