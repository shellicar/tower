# Bridge stdio protocol

The bridge is the v0 agent host. Its control channel is stdio, deliberately
not a wire concern: conversation creation and host config stay local until
practice teaches the wire shape.

There is one grammar, the control line, delivered at two points:

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
and the bucket is a stable route named in the block itself (conversation.md).
The bridge resolves each block against the bucket it names, so nothing binds
attachment storage to host config.

## Transport

One JSON object per line in, one JSON object per line out. Every input line,
whether from `-c` or from live stdin, produces exactly one output line. A line
that does not parse, or carries no known control key, is answered and the loop
continues:

```
{"error": "unparseable"}
{"error": "unsupported"}
```

Diagnostics go to stderr and are not part of the protocol. When stdin closes
the bridge keeps serving what was already spawned until it is killed.

## Live configuration

Four control lines set values held in shared cells and repointed while the
bridge runs. A repoint never touches anything already committed to a
conversation's record; the four differ by where the value lands, and that
dictates when a change is visible.

| Cell | Control line | Reaches |
| --- | --- | --- |
| skills directory | `skills` | running conversations on their next say; new spawns whole |
| system prompt | `system` | every conversation on its next turn |
| user context | `context` | new spawns only; conversations already born keep theirs |
| default model | `model` | new spawns only; a running conversation's model is fixed at birth |

- **skills** is re-scanned per say. Two layers, scoped differently: the
  *directory* is per-process (`skills_root`, shared by every conversation this
  instance serves; a repoint changes where all of them read from), but the
  *delta baseline* (name→content-hash of what a conversation has already been
  told) is per-conversation, held in `agent::run`'s own local state, one scan
  history per conversation. That's why a repoint surfaces to a running
  conversation as a catalogue delta on its next say, relative to *that
  conversation's own* last-seen state rather than a shared one, and to a new
  spawn as the full catalogue. With no skills directory set there is no
  catalogue, but the Skill tool is offered anyway (see "Why this is not in
  the tools array") and invoking it returns an error saying so.
- **system** is the API system prompt, read fresh each turn and **never
  persisted** to the record. A change reaches even a running conversation on
  its next turn. Because it is not in the record, a revived conversation takes
  the currently configured system prompt, not the one it was born with.
- **model** is only ever read at spawn: a conversation's model is part of
  its birth config, same footing as `context`. A repoint changes what the
  *next* spawn naming no `model` gets; it cannot move a running
  conversation onto a different model, and there is no way to do that over
  stdio in v0.
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

Repoint the skills directory. `~` and `~/...` are expanded against `$HOME`
(the only place they ever are: a control line is JSON over stdio, never a
shell, so nothing else expands a leading tilde).

```
{"skills": {"dir": "/path/to/skills"}}
{"skillsDir": "/path/to/skills"}
```

Setting it never fails, because the directory might not exist yet, or might
arrive before it does. A missing or non-directory path still sets the cell,
but adds a `warning` alongside the (always successful) result:

```
{"skillsDir": "/path/to/skills", "warning": "/path/to/skills does not exist or is unreadable: …"}
```

Missing `dir` itself is still an error, because there's no path to set at all:

```
{"error": "skills needs dir"}
```

### credentials

Name the credentials this host holds. One cell, replaced whole: the line
carries every credential, and whatever was there before is gone.

```
{"credentials": {
  "github-privileged": { "provider": "github", "account": "gh-holder" },
  "github-default":    { "provider": "github", "account": "gh-reader" }
}}
{"credentials": "ok", "warnings": []}
```

`account` names an item in the macOS Keychain under the service
`@shellicar/credentials`, which is a constant of the build and not
configurable. The secret is never held: it is read at the moment a child
process is spawned, so a rotation takes effect on the next call and there is
nothing that can go stale. There are no defaults and no environment
variables; until this line arrives, nothing is configured.

`provider` is a word from a closed set the build knows, currently `github`
alone. An unknown one is rejected when the line arrives, because a typo that
silently configures nothing is the failure this validation exists for:

```
{"error": "invalid credentials: credential \"x\" names unknown provider \"gitlab\"; known providers: github"}
```

`enabled` is optional and defaults to true. A disabled credential leaves
every group binding it inactive.

### tools

Bind credentials to tool groups. One cell, replaced whole, same as
`credentials`.

```
{"tools": {
  "github": { "credentials": "github-privileged" },
  "exec":   { "credentials": ["github-default"] }
}}
{"tools": "ok", "warnings": []}
```

A group name is likewise closed, currently `github` and `exec`, and an
unknown one is rejected when the line arrives. `exec` takes a list where a
group takes one, because exec can run anything and may need to carry several
credentials at once. `enabled` is optional and defaults to true here too.

A credential name that does not exist is different: it is accepted with a
warning, and that group is simply not active. Neither line can be validated
against the other's cell, which is exactly why the order they arrive in never
matters. The two are resolved against each other only at the point of use, so
both lines warn about the same thing:

```
{"tools": "ok", "warnings": ["tools group \"github\" names credential \"github-privileged\", which is not configured; the group is not active"]}
```

A warning is a string, as it already is on a `skills` write. The field is
`warnings` rather than `warning` because these operations can produce more
than one.

`{"settings":{}}` reports the resolved state of both cells, plus the same
`warnings` array. A group's state is one of `unconfigured`, `disabled`,
`missing` or `active`.

#### What a credential does

- **The privileged credential is provided only into the one gh child that
  uses it**, at the moment that child is spawned, and exists nowhere else.
- **Configuring any credential for a provider is what removes that
  provider's ambient environment from Exec**, whichever group binds it. The
  strip list is code belonging to the provider, never configuration: nobody
  setting this up should have to know which variables gh reads. For github it
  is `GH_TOKEN`, `GITHUB_TOKEN` and `SSH_AUTH_SOCK`, and the last matters
  because an ssh agent would let git authenticate around the token entirely.
- **What Exec then carries is only what the `exec` group binds.** A
  credential it binds but that cannot be read fails the Exec call rather than
  letting it run without one.

#### Why this is not in the tools array

The tools array is part of the cached prompt prefix, ordered ahead of system
and messages, so a single character changing in it misses the entire cache.
Anything that can vary per query therefore does not belong in it.

So the array is a constant of the build. All six GitHub tools are offered
whether or not they are configured, and `Skill` is offered whether or not a
skills directory is set; calling one that is not configured returns an
ordinary tool error naming what is missing. Which groups are actually usable
is told to the model in the conversation instead, by the mechanism the skills
catalogue already uses: the full state on a new conversation's opening
message, a delta on the next say of one already running.

### model

Set the default model a spawn takes when it names none, a live repoint of
`BRIDGE_MODEL`.

```
{"model": "claude-opus-5"}
{"model": "claude-opus-5"}
```

A `spawn` naming its own `model` is unaffected; this only changes the fallback.

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
