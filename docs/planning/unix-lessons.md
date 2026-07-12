# Unix lessons

The architecture keeps turning out Unix-shaped. These are the lessons that actually bear on the design — captured so the reasons survive, and so where we *do* invent stays clearly marked.

## Everything is a byte stream over a file descriptor

"stdio" is a convention; the mechanism is file descriptors. fd 0 (stdin, read), fd 1 (stdout, write). The bridge reads/writes bytes through fds and doesn't know what's behind them. An fd can be backed by: an **anonymous pipe** (the parent/child case — our default), a **FIFO** (named pipe), a **Unix socket**, a **TCP socket**, a **file**, a **PTY**. So the "stdio bridge" is really a duplex-byte-stream bridge; stdio is just the default fds.

## Pipes are unidirectional; sockets are bidirectional

A pipe goes one way; a full-duplex channel needs two, mirrored (read fd 0, write fd 1; the other side reversed). A socket endpoint is full duplex — one fd per side, each both reads and writes. Above the construction point both collapse to `{ readable, writable }`: for stdio, two objects (stdin + stdout); for a socket, one object used both ways. That's why "give me a readable and a writable" is the right seam — everything below it (pipe vs socket, one fd vs two) is detail the bridge never sees.

## stdout is the protocol; stderr is everything else

The protocol lives on fd 1. Any stray write there — a log, a warning, a library's debug output — corrupts the stream. So logs/diagnostics go to **stderr (fd 2) or a file**; stdout is protocol-only. A hard rule, not a preference. (The audit sink and the logger never write stdout.)

## Spawning is fork/exec — the parent builds the child's world

The parent sets the child's fds, env, cwd *before* exec; the child inherits a configured world and runs. "Spawn agent with config" is exactly this. The agent is *handed* a world, it doesn't *fetch* one — which is why there's no auto-discovery and config comes from outside.

## The process is the unit of isolation and recovery

Crash isolation is free (agent crashes, TUI survives; and vice versa). Recovery is respawn. The ephemeral-agent / durable-audit model *is* the Unix process model — "cattle not pets" is how processes always worked.

## The failure model depends on the transport

- **stdio (pipes):** if the parent dies, the agent is reparented to init but its pipes are gone — the parent held the other ends. Next write gets SIGPIPE; stdin reads EOF. The agent is cut off, effectively dead even if the process lingers. No other process can adopt anonymous pipes. So stdio **couples** the agent's life to the parent.
- **socket:** the agent listens; clients connect and disconnect; a crashed client can reconnect. The agent **outlives** its clients.

So "TUI crashed, reconnect to the still-running agent" needs a socket, not stdio. v1 (stdio) recovers by respawning both and replaying the audit. Worth knowing the fork exists; not a v1 decision.

## Signals are the always-received channel

A signal can't be refused (permissions aside), only deferred. SIGTERM → graceful close + audit flush; SIGINT → cancel the current turn. An orchestrator killing a container sends signals, not protocol messages, so the agent handles both. This "always received" property is the same one that distinguishes **events** (can't be rejected) from rejectable **requests**.

## Backpressure is free over pipes, not over the network

A pipe's kernel buffer blocks the writer when the reader is slow — automatic. And the model streaming over HTTP is the rate ceiling anyway (LLM token rate, slow), so the pipe never floods. Only **network bridges** (no kernel buffer doing it for you) need a decision about slow consumers — and only when they arrive. When that happens it's a graceful-degradation knob (batch / coalesce), not a flow-control subsystem, and it's a rendering choice, not a transport feature.

## Files-as-transport conflates two concerns

You *could* make the channel a pair of append-only files (durable, survives restart). But it's a poor live transport — polling, no push, no delivery signal — and it reinvents the audit. Keep the transport **live** (pipe/socket) and the audit **durable** (file/db); restart recovery is the audit, not a durable transport. And a log only captures one direction cleanly — to rebuild a conversation you need both directions, which is just a complete audit.

---

The meta-point: the architecture reuses primitives that have been load-bearing for fifty years — byte streams over fds, fork/exec, respawn, signals. That's why it feels clean. Where we invent — the protocol semantics, credential exchange, the content vocabulary — is exactly where Unix has no answer, which is the right place to spend invention.
