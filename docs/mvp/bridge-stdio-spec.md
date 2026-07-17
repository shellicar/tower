# Bridge stdio protocol

The bridge is the v0 agent host. Its control channel is stdio, deliberately
not a wire concern: conversation creation and host config stay local until
practice teaches the wire shape.

There is one grammar — the control line — delivered at two points:

- **`-c` at launch.** A batch of control lines run before stdin takes over.
  This is how a launch is scripted: everything the bridge is asked to do at
  startup is the same lines you would send it live.
- **stdin, live.** The bridge keeps reading control lines for its whole life,
  so config changes without a restart.

Anything configurable over stdio is reachable at launch through `-c`; nothing
configurable over stdio gets a second, dedicated CLI flag. The CLI stays small
on purpose: only what is *not* a control line is a flag or an environment
variable.

## Launch

```
bridge -c '{"system":"You are …"}
{"skills":{"dir":"/path/to/skills"}}
{"spawn":{}}'
```

`-c` takes one string of newline-separated control lines. The bridge runs them
in order, writing each one's response line to stdout (so a launcher reads back
the `conversationId` of a `spawn`, and so on), then enters the live stdin loop.
`-c` is optional; with none, the bridge starts idle and waits on stdin.

Non-stdio settings are environment variables, unchanged:

| Variable | Meaning | Default |
| --- | --- | --- |
| `NATS_URL` | The broker | `nats://127.0.0.1:4222` |
| `BRIDGE_WORLD` | The agent world this instance joins | `local` |
| `BRIDGE_MODEL` | Default model for a spawn that names none | `claude-sonnet-5` |
| `BRIDGE_STREAM` | Capture stream `adopt` replays from | `conv-approval` |
| `BRIDGE_THINKING_BUDGET` | Extended thinking token budget; `0` disables | on |

There is no attachment-bucket setting. An attachment reference block carries
its own bucket: an object is `server + bucket + id`, the server is `NATS_URL`,
and the bucket is a stable route named in the block itself (conversation-spec).
The bridge resolves each block against the bucket it names, so nothing binds
attachment storage to host config.

## Transport

One JSON object per line in, one JSON object per line out. Every input line —
whether from `-c` or from live stdin — produces exactly one output line. A line
that does not parse, or carries no known control key, is answered and the loop
continues:

```
{"error": "unparseable"}
{"error": "unsupported"}
```

Diagnostics go to stderr and are not part of the protocol. When stdin closes
the bridge keeps serving what was already spawned until it is killed.

## Live configuration

Three control lines set values held in shared cells and repointed while the
bridge runs. A repoint never touches anything already committed to a
conversation's record; the three differ by where the value lands, and that
dictates when a change is visible.

| Cell | Control line | Reaches |
| --- | --- | --- |
| skills directory | `skills` | running conversations on their next say; new spawns whole |
| system prompt | `system` | every conversation on its next turn |
| user context | `context` | new spawns only; conversations already born keep theirs |

- **skills** is re-scanned per say. A repoint surfaces to a running
  conversation as a catalogue delta on its next say, and to a new spawn as the
  full catalogue. With no skills directory set, there is no catalogue and the
  Skill tool is not offered.
- **system** is the API system prompt, read fresh each turn and **never
  persisted** to the record. A change reaches even a running conversation on
  its next turn. Because it is not in the record, a revived conversation takes
  the currently configured system prompt, not the one it was born with.
- **context** is injected as a `<system-reminder>` block on a conversation's
  opening user message and **is committed** to the record. It is read once, at
  conversation birth. A later change affects only conversations spawned after
  it; a revived conversation replays the frozen block from its record. This is
  why a bridge restart cannot invalidate a running conversation's context: the
  record is the source, not the disk.

On the opening message the context block sits after the skills catalogue
reminder.

## Control lines

### spawn

Create and serve a new conversation. Returns its id.

```
{"spawn": {}}
{"conversationId": "…"}
```

Optional `model` overrides `BRIDGE_MODEL` for this conversation:

```
{"spawn": {"model": "claude-opus-5"}}
```

The system prompt and user context are host config, not spawn parameters: a
spawn takes whatever the `system` and `context` cells hold at birth.

### adopt

Revive a conversation whose holder died. The record outlives the servicer, so
a fresh instance replays the committed messages from the capture stream, seeds
its tree, and serves on. Returns the id and how many messages were replayed.

```
{"adopt": {"conversationId": "…"}}
{"conversationId": "…", "adoptedMessages": 12}
```

A record ending broken (a dangling `tool_use`) is served as it is; the next
turn's outcome says so. Replay reads the stream named by `BRIDGE_STREAM`.

### skills

Repoint the skills directory.

```
{"skills": {"dir": "/path/to/skills"}}
{"skillsDir": "/path/to/skills"}
```

Missing `dir` is an error:

```
{"error": "skills needs dir"}
```

### system

Set the system prompt.

```
{"system": "You are …"}
{"system": "set"}
```

### context

Set the user context injected at the start of each new conversation.

```
{"context": "The fleet is …"}
{"context": "set"}
```

## What this v0 does not do

- No persistence: conversations are tasks, and they die with the host. `adopt`
  recovers from the capture stream, not from bridge state.
- No `detached`: a kill is a crash from the wire's view. The pulse going silent
  is what observers fold.
- Control is stdio only. Creation and config are not wire concerns in v0.
