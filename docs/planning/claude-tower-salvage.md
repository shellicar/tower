# Salvage from claude-tower (POC)

## What this is

`claude-tower` was an earlier proof-of-concept: an **external coordination server** for managing multiple Claude Code sessions, bolted onto Claude Code from the outside via hooks and an MCP bridge. It is superseded by tower (this platform).

This note preserves the parts of its design worth carrying — concrete requirements and data models — so they feed tower's **deferred** design passes (control plane, monitoring, distributed approvals, config-permissions) when those come. It is input for those passes, not settled design.

The original brief lived at `projects/claude-tower/briefs/architecture.md` in the fleet repo, which is being deprecated. The useful content is captured here so it survives.

## The framing gap (read first)

claude-tower intercepts Claude Code from the outside: `PreToolUse` / `SessionStart` hooks fire tool calls at an HTTP server, an MCP server (`mcp-tower`) bridges voluntary check-ins, and the server holds the hook's HTTP connection open to pause a tool call until a human approves.

tower owns the agent, which speaks the protocol natively. So the *mechanism* does not carry — the hooks, the MCP bridge, and the held connection are all workarounds for not controlling the tool. What carries is the **what**: the requirements and data models claude-tower worked out for the control-plane / monitoring / approval layer that tower currently defers.

## What carries, and where it maps

### Session registry + metadata → control-plane registry + monitoring

claude-tower tracked, per session:
- `name` (human-readable, e.g. "CircuitBreaker"), `role` (fm / pm / worker), `repo`, `machine`, `fleet` (display grouping only)
- `status`: `working | idle | blocked | waiting_approval | done`
- `lastSeen`, `contextPercent`, `costUsd`

A concrete answer to "what does the control plane / monitoring track per agent." Maps to tower's control-plane **registry** (identity, lifecycle) and **monitoring** (receiver-side metrics: health, cost, context).

### Approval queue → distributed approvals + Tower frontend

A queue of pending tool-approvals, visible to one operator across all sessions, with approve / deny / **modify** (operator edits the tool input before allowing). The held-connection pattern is the hook-model workaround and does **not** carry — in tower an approval is a protocol *request* (addressed, rejectable, response routes to the sender). The queue semantics and the cross-session operator view map to **distributed approvals** (deferred) and the Tower **management frontend**.

### Permission rules → approval coordinator + config-permissions

`deny > ask > allow` matching (first deny wins; else first allow; else default ask). Rule shape (from claude-cli#101 / Exec structured permissions):
- match on `tool` (glob); for Exec: `program` / `args` / `params` (flag-aware); for Edit/Write: `filePath` (glob)
- `action: deny | ask | allow`

Maps to the **approval coordinator** and the deferred **config-permissions model**.

### Dashboard + activity feed → control-plane frontend + monitoring

Single-pane web UI: session list with status, approval queue with action buttons, real-time activity feed (SSE). The "single-pane view across machines" is Tower's reason to exist. Maps to the Tower **management frontend** + **monitoring**.

### Coordination tools → native protocol + routing

The `tower_*` MCP tools become native protocol concerns rather than bolt-on tools:
- `tower_checkin` (register at start) → handshake / init on the bridge
- `tower_status` (heartbeat: status, context %, cost) → status events
- `tower_report` (end-of-task summary) → an event
- `tower_message` (to a session, or broadcast) → **routing** (the Mailroom)

### The problem statement → the why for the orchestration layer

The three problems claude-tower set out to solve are the motivation for tower's whole orchestration layer + the fleet:
1. **Orchestration** — no single-pane view of sessions across machines (active / idle / blocked / cost).
2. **Approval bottleneck** — a human context-switching between terminals to approve each session.
3. **Session visibility** — no persistent record of what sessions are doing, have done, or cost.

## What does not carry

- **HTTP hooks** (`PreToolUse`, `SessionStart`) — interception you do not need when you own the agent.
- **MCP bridge** (`mcp-tower`) — replaced by the native bridge protocol.
- **Held HTTP connection** for approvals — replaced by protocol requests.
- **"Hono server = the architecture"** — tower is the platform; the control plane is one component within it, not the whole thing.

## Bottom line

claude-tower is a prior, concrete exploration of tower's deferred control-plane / monitoring / approval layer, from the outside-in. Mine it for requirements and data models when those design passes happen; do not carry its bolt-on mechanism.
