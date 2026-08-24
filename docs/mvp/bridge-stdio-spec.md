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
| `BRIDGE_STREAM` | Capture stream `adopt` replays from | `conv-approval` |

The model is not among them. It is a control line and nothing else, and it
has no default: see `model` below.

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

Five control lines set values held in shared cells and repointed while the
bridge runs. A repoint never touches anything already committed to a
conversation's record; the five differ by where the value lands, and that
dictates when a change is visible.

| Cell | Control line | Reaches |
| --- | --- | --- |
| skills directory | `skills` | running conversations on their next say; new spawns whole |
| system prompt | `system` | every conversation on its next turn |
| user context | `context` | new spawns only; conversations already born keep theirs |
| model | `model` | new spawns only; a running conversation's model is fixed at birth |
| retry policy | `retry` | every conversation at once, including a turn already in flight |

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
- **model** is only ever read when a conversation is served: its whole model
  configuration is part of its birth config, same footing as `context`. A
  change reaches the *next* spawn or service request; it cannot move a
  running conversation onto a different model, and there is no way to do
  that over stdio in v0. Unlike the other three, this cell is merged into
  rather than replaced.
- **retry** is read at the moment a model request fails on the way out,
  rather than captured when a query starts, so setting or clearing it reaches
  a turn that is already waiting to be retried.
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

Optional `model` names the model for this conversation, in place of the
`model` cell's own `name`. The rest of the configuration still comes from the
cell:

```
{"spawn": {"model": "claude-opus-5"}}
```

The system prompt and user context are host config, not spawn parameters: a
spawn takes whatever the `system` and `context` cells hold at birth.

A spawn is refused outright when the `model` cell has no name and no
`maxTokens` between it and this line, because nothing defaults them:

```
{"error": "invalid model: no maxTokens is configured"}
```

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
  "exec":   { "credentials": ["github-default"], "max_timeout_s": 900 }
}}
{"tools": "ok", "warnings": []}
```

A group name is likewise closed, currently `github` and `exec`, and an
unknown one is rejected when the line arrives. `exec` takes a list where a
group takes one, because exec can run anything and may need to carry several
credentials at once. `enabled` is optional and defaults to true here too.

`max_timeout_s` is the exec group's alone: the longest an `Exec` call may ask
to run for, in whole seconds. Absent, this host bounds nothing and a call runs
for whatever it asked for. Present, it must be a whole number of seconds above
zero, and a value that cannot be one is rejected when the line arrives rather
than dropped, because a mistyped ceiling would otherwise leave the host
running unbounded while believing it had set a limit. A field a group does not
have is rejected the same way an unknown group name is, so `max_timeout_s`
written under `github` is refused rather than accepted and ignored.

`{"settings":{}}` reports the exec group's `max_timeout_s`, null when the host
bounds nothing, so the ceiling a bridge is enforcing can be read back rather
than discovered by having a call refused.

Every `Exec` call states its own `timeout` and is required to: a stated
timeout is the caller's expectation, so when it fires it tells the caller its
model of the command was wrong, where a default absorbs that silently. A call
asking for longer than this host allows is refused before anything runs, and
the refusal names the limit. It is refused rather than reduced to the limit,
because a call quietly cut to 900s while its caller believes it has 1800s
plans against a number that will never happen.

The limit's value is not in the `Exec` schema, and the schema's wording is
identical on every host whatever it has configured. The tools array heads the
cached prompt prefix (below), so a description carrying this host's number
would cost that host the entire prefix the moment the number changed. The
schema says only that a maximum may apply and that a call exceeding it is
refused, which is what the model needs to recognise the refusal when it
arrives.

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

#### The only route to a pull request is the tool

The six tools exist so that there is no other way to authenticate to GitHub
on a host that uses them. Configuring a credential for a provider is what
makes that provider active, and an active provider's environment is governed
for every Exec child from then on.

The `tools` mapping does not enter into that. It decides what Exec is given,
never whether the provider's environment is governed, so a host that
configures a github credential and binds it only to the privileged tools
still has gh's environment taken off its Exec children with nothing put back.
That is the case the rule exists for: otherwise the privileged tools would
sit beside an Exec that authenticates as the operator.

- **An active provider's ambient credentials come off every Exec child.**
- **An active provider's session location is pointed somewhere empty.**
  Removing the variable is not enough: unset, the CLI falls back to its real
  default, which is exactly where the operator's own login lives, and on
  macOS that session's token is in the system keyring where no amount of
  removing environment variables reaches. Overriding the location is what
  closes it, and the CLI then fails closed by asking for a login.
- **A provider nobody configured is left alone entirely.** Removing a route
  and replacing it are one act, not two, so a host that never opted into this
  keeps the environment it always had.
- **What a tool call asks for cannot override any of it.** A call's own `env`
  is applied first, then the removals, then what the host forces, so a value
  supplied by the caller can never be what the child authenticates as.
- **What Exec is given back is only what the `exec` group binds.** A
  credential it binds but that cannot be read fails the Exec call rather than
  letting it run without one.
- **The privileged credential is provided only into the one gh child that
  uses it**, at the moment that child is spawned, and exists nowhere else.

Which variables each of these covers is code belonging to the provider, never
configuration: the provider is the authority on its own CLI, and nobody
setting up a credential should have to know what gh reads.

Reading a credential needs macOS on Apple silicon. Elsewhere the tools are
still offered and still answer for themselves, the defence above still
applies in full, and nothing is injected in place of what it removed.

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

Configure the model this instance serves conversations with. One cell, but
unlike `permissions`, `credentials` and `tools` this line **merges**: it
updates the fields it names and leaves the rest alone. The reply echoes the
whole cell, not the line.

```
{"model": {"name": "claude-opus-5", "maxTokens": 120000, "thinking": "adaptive", "thinkingDisplay": "summarized", "effort": "xhigh"}}
{"model": {"name": "claude-opus-5", "maxTokens": 120000, "thinking": "adaptive", "thinkingDisplay": "summarized", "effort": "xhigh"}}
```

| Field | Required | Values |
| --- | --- | --- |
| `name` | yes | free text, never checked against a list |
| `maxTokens` | yes | one or greater, no upper bound |
| `thinking` | no | `adaptive` or `disabled` |
| `thinkingDisplay` | no | `summarized` or `omitted` |
| `effort` | no | `max`, `xhigh`, `high`, `medium`, `low` |

Sending `null` for an optional field clears it. `name` and `maxTokens` are
required of the *cell*, not of the line, so a later line can carry `effort`
alone:

```
{"model": {"effort": "low"}}
{"model": {"name": "claude-opus-5", "maxTokens": 120000, "thinking": "adaptive", "thinkingDisplay": "summarized", "effort": "low"}}
```

A line is validated on the values it carries. Anything that is not an object,
an unrecognised field anywhere in it, or a bad value is rejected, and the cell
is left exactly as it was:

```
{"error": "invalid model: unknown field \"budgetTokens\"; known fields: name, maxTokens, thinking, thinkingDisplay, effort"}
```

Nothing defaults, so until a line has filled in a name and a `maxTokens`, this
instance cannot serve a conversation at all: `spawn` and `adopt` answer with an
error, and a `service` request over NATS is rejected with reason `no_model`.
Because both are required, the cell is only ever unset or whole, so refusing
when a conversation is served leaves no unconfigured path behind it. That is
also why the check is there and not on the say: a conversation that exists is
always one bridge can run a turn for.

#### What the request carries

`max_tokens` always rides. The other two are omitted from the request body
entirely when unset, which is not the same as sent empty.

| Cell | Request |
| --- | --- |
| `thinking: adaptive`, no display | `"thinking": {"type": "adaptive"}` |
| `thinking: adaptive`, display set | `"thinking": {"type": "adaptive", "display": "summarized"}` |
| `thinking: disabled` | `"thinking": {"type": "disabled"}`, the display dropped |
| `thinking` unset | no `thinking` field, and no display either |
| `effort` set | `"output_config": {"effort": "xhigh"}` |
| `effort` unset | no `output_config` field |

`thinking` and `thinkingDisplay` are two flat fields rather than one object
mirroring the API's, and that is the merge's doing. A display is invalid
alongside `disabled` at the API, so with a display already set, switching
thinking to `disabled` one field at a time would otherwise leave bridge
rejecting a configuration reached legitimately. Bridge holds what was meant and
drops the display when it renders the request. It never rejects a combination.

#### Where the line is drawn

Bridge knows the shape of a request; the API owns what a given model will
accept. That is what makes `name` free text while `thinking`,
`thinkingDisplay` and `effort` are closed sets, and it is deliberately not the
tolerance rule that governs the wire.

Model names change constantly. Checking one against a list would only mean
bridge has to be rebuilt to reach a model that already works, so it never is.
A new effort level or thinking mode arrives with a feature release and is rare,
so a closed set that must be updated to adopt one is worth the cost: it catches
a typo when the line arrives instead of on the first turn.

Which efforts a given model supports, and that Opus 5 refuses disabled thinking
at `xhigh` or `max` effort, are the API's to reject and never bridge's to know.

### retry

Configure what bridge does when a model request fails on the way out. Beside
the `model` line and independent of it.

```
{"retry": {"maxRetries": 10, "baseDelayMs": 500, "maxDelayMs": 32000, "retryAfterCapMs": 60000}}
{"retry": {"maxRetries": 10, "baseDelayMs": 500, "maxDelayMs": 32000, "retryAfterCapMs": 60000}}
```

| Field | Values |
| --- | --- |
| `maxRetries` | how many retries before the turn is abandoned; one or greater |
| `baseDelayMs` | the first wait, and the unit the backoff doubles from; one or greater |
| `maxDelayMs` | the ceiling the doubling stops at; one or greater, and not below `baseDelayMs` |
| `retryAfterCapMs` | the longest a `retry-after` is honoured for; one or greater |

Unlike `model`, this line **replaces** the cell wholesale, because a policy is
one strategy and half of one mixed with half of another is not a strategy.
Bridge holds no default for any field, so every field is required and a line
missing one is refused with a message naming what was wrong:

```
{"retry": {"maxRetries": 10, "baseDelayMs": 500, "maxDelayMs": 32000}}
{"error": "invalid retry: retryAfterCapMs is required; every field is: maxRetries, baseDelayMs, maxDelayMs, retryAfterCapMs"}
```

`{"retry": null}` clears the policy. No line at all means there is no policy
and therefore no retrying, which is bridge exactly as it behaved before this
existed.

#### What is retried

The connect phase alone: the request up to and including the response status.
Once the stream has yielded anything the turn is past this point and is never
retried, because a partial stream cannot be replayed into the same turn.

A retry is one turn attempted again, not a new request. Same query id, same
turn id, same message id, and nothing new published on any subject. From
outside, the only difference is a turn that took longer.

| Failure | Retried |
| --- | --- |
| no response at all: dns, socket, timeout | always |
| 4xx | never, except 429 |
| 429 | always |
| 5xx | always |

That is the whole of the rule. It deliberately does not enumerate documented
status codes: the documentation has already changed under this code once, and
a rule written as a class stays correct when it changes again.

The wait is `baseDelayMs` doubled per attempt, capped at `maxDelayMs`, plus up
to half `baseDelayMs` of jitter so a host running many conversations does not
retry them in lockstep. A `retry-after` header is honoured as sent rather than
computed, capped at `retryAfterCapMs` so a long one cannot park a
conversation. The header says how long to wait, never whether to keep going,
so `maxRetries` still ends it.

When the retries run out the turn is abandoned exactly as it was before any of
this existed, and it is the last attempt's error that surfaces, since that is
the state the request was in when bridge gave up. A cancel during a backoff
wait takes effect immediately, not after the wait.

Every attempt is logged to stderr: the attempt number, the status or the
connection error, what the body called the error and its details, the
`retry-after` if there was one, and how long bridge is about to wait. A tier
spend cap is called out by name there, because it is a `rate_limit_error` 429
like any other in every visible respect and only
`error.details.error_code` (`enforced_spend_limit_reached`) tells it apart. It
changes no behaviour: it retries and gives up like any other 429. The console
is the only place any of this appears; nothing goes on the wire.

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

### settings

Report the live state of every cell a control line can set, plus the static
config the host was launched with. This is the read half of `skills`,
`system`, `context`, `model`, `retry`, `cwd`, `permissions`, `credentials` and
`tools`.

```
{"settings": {}}
{"warnings": [], "settings": {"system": {"set": true, "bytes": 4821, "hash": "…"}, "context": {"set": true, "bytes": 12903, "hash": "…"}, "model": "claude-sonnet-5", …}}
```

`system` and `context` hold bodies that run to tens of kilobytes, so the reply
summarises them instead of inlining them: one query would otherwise return a
wall of text with every other setting buried in it. `bytes` counts the body's
bytes, not its characters. A cell nobody has set reports `{"set": false}` and
nothing else.

`hash` tells two bodies apart without carrying either, so a caller that queries
twice knows from an unchanged hash that the body is unchanged. It is the same
non-cryptographic content hash the skills catalogue uses for change detection,
rendered as sixteen hex digits, so it is not reproducible outside the running
host and only means something against another value from that same host.

A body is returned when the request asks for it by name:

```
{"settings": {"include": ["system", "context"]}}
```

That is the same reply with a `text` field added to each entry named. The
entry's shape does not change with the request: it gains a field rather than
becoming a string, so a caller parses one shape either way. Naming nothing,
and `{"settings": {}}`, both give the summary. Naming a cell that is not set
adds nothing to it, because there is no body to add.

`system` and `context` are the only entries with a body, and naming anything
else is rejected rather than quietly doing nothing:

```
{"settings": {"include": ["skillsDir"]}}
{"error": "settings include names unknown entry \"skillsDir\"; entries with a body: context, system"}
```

This is stricter than the wire contract, deliberately. Tolerance there exists
so an old tower and a new bridge can coexist; stdio has no such skew, being an
operator talking to their own local process, so a name that silently did
nothing would only hand back a reply they go on to misread. An `include` that
is not an array, or an entry named as something other than a string, is
rejected the same way.

## What this v0 does not do

- No persistence: conversations are tasks, and they die with the host. `adopt`
  recovers from the capture stream, not from bridge state.
- No `detached`: a kill is a crash from the wire's view. The pulse going silent
  is what observers fold.
- Control is stdio only. Creation and config are not wire concerns in v0.
