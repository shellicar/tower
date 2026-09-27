# Claude Code proof harness

Runs Claude Code through the Agent SDK (`@anthropic-ai/claude-agent-sdk`) for
one proof and records everything it does. No NATS, no tower, no participant
logic. The decisions behind it are in
`docs/design/claude-code-participant.md`.

## What a run is

`startRun({ name, options })` in `src/harness.mts` starts one `query()` fed a
stream of messages, so a proof can send several messages into one running
Claude Code over time and interrupt it:

- `run.send(message)`: push an `SDKUserMessage`.
- `run.interrupt()`: interrupt the current turn.
- `run.end()`: close the input; Claude Code exits once it's done.
- `run.messages()`: every SDK message, in order.
- `run.query`: the SDK's query object, for any other control call.
- `run.done`: settles once the binary has exited and the config directory has
  been copied; rejects with the query's error, if any.

Isolation is the harness's baseline, not the proof's choice. Every run gets:

- `settingSources: []`: no user, project or local settings files, and no
  CLAUDE.md. A proof can't pass `settingSources`; the harness's value wins.
- `CLAUDE_CONFIG_DIR`: the agent's own directory,
  `~/.local/state/tower-claude-code-harness/config-dirs/<name>/`, named after
  the proof (`startRun`'s `name`), created the first time and reused by every
  run of that proof. Only a reset deletes it, for a clean start (below). "its
  ONE directory PER agent" (Stephen, 27 Sep). A proof can't pass it:
  `options.env`'s `CLAUDE_CONFIG_DIR` is overridden. See below.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`: the login (below).
- It strips a parent Claude Code session's variables from the environment
  (from `options.env` too): `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
  `AI_AGENT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`,
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`,
  `CLAUDE_CODE_INVOKED_SKILLS`, `CLAUDE_CODE_MESSAGING_SOCKET`,
  `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_BRIDGE_SESSION_ID`. The ones
  actually found are listed in the run's `run.json` as `strippedEnv`.

The harness also sets:

- `cwd`: the proof's own working directory,
  `~/.local/state/tower-claude-code-harness/work/<name>/`, named after the
  proof (`startRun`'s `name`), created the first time and reused by every run
  of that proof. Never cleared, and a reset leaves it alone. A proof can't
  pass `cwd`.
- `pathToClaudeCodeExecutable`: `bin/claude-capture`, which runs the SDK's own
  bundled `claude` binary and records it.

Everything else comes from the proof's `options` (model, permission mode,
tools, plugins, skills, ...). The harness has no defaults of its own.
`options.model` is required.

## The config directory

Claude Code keeps its own state in its config directory: transcripts
(`projects/<project>/<session>.jsonl`), a file per running process
(`sessions/<pid>.json`), and what it saves itself (`.claude.json`, such as a
connector turned off at runtime). Every run under one name shares it, one
after another or at the same time, with no lock and no per-run separation, so
a proof meets Claude Code's state from earlier runs the way a real
participant would: a later run can resume an earlier run's session by id with
no session store, and two Claude Codes can meet on one session.

- An agent that needs a clean start resets its directory with
  `pnpm reset-config-dir <name>` before its run (below).
- Claude Code 2.1.282 skips its transcript retention cleanup here: with
  `settingSources: []` the user settings are disabled, and no enabled source
  gives `cleanupPeriodDays` (its default is 30 days). It still writes
  `.last-cleanup`, the marker for its other housekeeping.
- Config directories from before this, one per run, are the timestamped
  `config-dirs/<timestamp>-<name>/` directories. They are kept.

## A clean start

`pnpm reset-config-dir <name>`, from `mvp/claude-code-harness/`, is the only
way to reset an agent's config directory; no agent `rm`s a config directory
by hand: "deleting is fine / what i meant is, we shouldnt make the agents use
rm / ie they use a script to do it 'safely'" (Stephen, 27 Sep).

```sh
pnpm reset-config-dir <name>
```

Exit 0 prints `{"configDir": ..., "deleted": true|false}`. Exit 1 is a
refusal, with the reason on stderr; nothing was deleted. Exit 2 is a usage
error (not exactly one name).

The script (`src/reset-config-dir.mts`) runs `resetConfigDir(name)` in
`src/harness.mts`:

- It deletes `config-dirs/<name>/`, whole, and makes a new empty one in its
  place. Each run's `runs/<id>/config-dir/` copy is the record of what was
  there.
- It only ever deletes `config-dirs/<name>/`: the name must be a direct child
  of `config-dirs/`, a symlink there is removed itself rather than followed,
  and links inside the directory are not followed.
- It refuses while any Claude Code is still running with that directory: a
  `sessions/<pid>.json` whose pid is alive and whose `procStart` equals field
  22 of `/proc/<pid>/stat` (the check proof 17 validated). The error names
  each pid, its pid file and both start times. `liveClaudeCodes(configDir)`
  is the same check on its own.
- It refuses the names `.` and `..`, which would point at `config-dirs/`
  itself or the state folder above it, and `.reset` (below).
- A name with no config directory yet gets an empty one; nothing is deleted
  (undecided: it could refuse instead).
- The working directory, `work/<name>/`, is not reset.

`config-dirs/.reset/` holds what an earlier version of the reset moved aside
instead of deleting (`<name>-<timestamp>/`). It is kept as it is; nothing
adds to it or takes from it, and a reset refuses the name `.reset`.

Where the running check can miss a Claude Code (undecided, see the TODO in
`src/harness.mts`): without `/proc` (macOS) every pid reads as not running;
a pid file that can't be parsed is skipped; a Claude Code that hasn't written
its pid file yet, and a run whose harness is still copying the config
directory after Claude Code exited, have none; and a run can start between
the check and the delete. A reset that slips through deletes files a running
Claude Code is using, or leaves a run's `config-dir/` copy partial. Also
undecided: a proof named `.reset` would use that folder as its config
directory, `startRun` still accepts `.` and `..`, and a reset under the name
of one of the old per-run directories (`config-dirs/<timestamp>-<name>/`)
deletes it.

`proofs/reset.mts <model>` proves it, under the name `reset`, running every
reset through `pnpm reset-config-dir` as a child process and printing a
`CHECK PASS`/`CHECK FAIL` line for each: `.`, `..` and `.reset` refused with
nothing changed; run 1 to the end, with its transcript in its run's
`config-dir/` copy; reset, leaving the directory empty, run 1's session gone,
every other entry in `config-dirs/` and the state folder still there, and run
1's copy unchanged; run 2 starting from the empty directory and ending with
only its own session in it; a reset refused, naming the pid, with every file
kept, while run 2's Claude Code is still running; and `config-dirs/.reset/`
the same files (path, size, sha256) at the end as at the start.
`.credentials.json`, if present, is listed by name and never read. From
`mvp/claude-code-harness/`:

```sh
node proofs/reset.mts claude-haiku-4-5 | tee runs/<timestamp>-reset-proof.log
```

## The login

Settings and config live in the agent's own `CLAUDE_CONFIG_DIR`; the login is
Stephen's own. With `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the empty string,
Claude Code 2.1.282 keeps its credential file, its refresh lock and (macOS)
its Keychain item where a default install does: `~/.claude/.credentials.json`
on Linux, the `Claude Code-credentials` Keychain item on macOS. So a run and
Stephen's own Claude Code share one login, and a token refresh by either one
goes through the same lock and is seen by the other. No credential file is
written into the agent's config directory.

Things to know:

- `CLAUDE_SECURESTORAGE_CONFIG_DIR` is undocumented. Found in the 2.1.282
  binary; it can change with any Claude Code version.
- `/logout` inside a run logs Stephen out everywhere (it revokes the shared
  refresh token), and `/login` inside a run replaces his login.
- macOS: from the macOS build's code only, untested. There only the empty
  string shares the login; a path, even `~/.claude`, names a different
  Keychain item.

## The broker

The harness itself touches no NATS, but the proofs that publish to tower
(`proofs/integration/`, `proofs/semantic/`) use the harness's own broker,
`mvp/compose.harness.yaml`: compose project `tower-harness`, nats on
127.0.0.1:31417, JetStream on a named volume, `restart: unless-stopped`.
Start it from `mvp/`:

```sh
docker compose -f compose.harness.yaml up -d nats
docker compose -f compose.harness.yaml run --rm stream-init
```

It persists across runs, since a resume from tower reads what earlier runs
published, so a proof never takes it down or removes its volume. Proofs
never use the bridge test broker (`compose.test.yaml`, 31416) or
`just broker-run`, and every process they start gets
`NATS_URL=nats://127.0.0.1:31417` explicitly, since an unset `NATS_URL`
means the fleet's 4222.

## The integration proof, attempt 3: state and the invariant check

The third integration attempt (`proofs/integration/`) keeps its durable
state in `~/.local/state/tower-claude-code-harness/integration-3/` and
names every agent `i3-...` (`AGENT_PREFIX` in `lib.mts`; `run.mts`
refuses an `--agent` without it), apart from the first attempt's
`integration/` and `int-...` names, since the leftover stop and recovery
act by agent name. Its evidence dirs are `runs/i3-<timestamp>-<label>/`.

`proofs/integration/invariant.mts` checks the invariant over any run
afterwards, from what persists: tower read back from the harness broker's
JetStream, and every lineage of the conversation under the state dir (request
and response bodies, serve/say/result events, store appends). It uses none of
the committer's code. From `mvp/claude-code-harness/`, with
`NATS_URL=nats://127.0.0.1:31417`:

```sh
node proofs/integration/invariant.mts --evidence runs/i3-<timestamp>-<label>   # every conversation the run names
node proofs/integration/invariant.mts <convId>...
node proofs/integration/invariant.mts --all
```

It writes `<convId>.md` and `.json` per conversation (default
`runs/i3-<timestamp>-invariant/`, or `--out`) and exits 1 on any FAIL. The
kinds of point, the truth each is judged against, the verdicts (PASS,
ROUND-TRIP, UNCHECKED, FAIL, and a content verdict that sets shape-only
divergences aside) and the check's own undecided assumptions are in the
file's header.

Every attempt-3 scenario takes `--commit run+last|run+entry` (required, no
default): the committer publishes that variant to tower and computes the
other as a shadow over the same recording, under the conversation id
`<id>~shadow` on the same broker (its records `published.shadow.jsonl`,
`committer.shadow.jsonl` beside the live ones). The check judges the shadow
exactly as it judges tower, writes `<id>.shadow.md`, and prints whether the
two differ. Alternate the live variant between runs; pickups only ever see
the live one.

## What a run records

`runs/<timestamp>-<name>/` (gitignored):

| Path | What |
| --- | --- |
| `run.json` | run id, config dir, working dir, setting sources, real binary, SDK version, options as passed (env as names only), stripped env names |
| `sdk-messages.jsonl` | every SDK message, `{ts, message}` |
| `harness-events.jsonl` | send, end, interrupt, errors, done |
| `claude/<n>/argv.json` | argv of the real binary, cwd, env names (not values) |
| `claude/<n>/stdin.txt`, `stdout.txt`, `stderr.txt` | every line, as `<timestamp> <raw line>` |
| `claude/<n>/exit.json` | exit code or signal, signals forwarded |
| `config-dir/` | copy of the agent's config directory after the run: everything the agent has accumulated, earlier runs' files included |
| `config-dir-manifest.json` | what was copied, skipped or redacted |

Timestamps are wall-clock ISO 8601 with microseconds. `<n>` counts the times
the SDK started the binary in that run.

No credential is written under the repo: `.credentials.json` is never
copied, and anything matching `sk-ant-...` (Anthropic keys and Claude.ai
tokens) is replaced with `sk-ant-[REDACTED]` in every file the harness
writes. The copied `.claude.json` does hold account details (name, email,
organisation). The live config directories outside the repo are kept and
reused.

## The smoke run

`proofs/smoke.mts` proves the isolation baseline, with a positive and a
negative test, over two runs under the name `smoke`:

- **Negative:** it writes a dummy skill, `tower-harness-negative-probe`, to
  `~/.claude/skills/` for the length of both runs. It must not appear. The run
  refuses to start if that directory already exists, and removes it
  afterwards whatever happens.
- **Positive:** it passes its own plugin, `proofs/smoke-plugin/`, through the
  SDK's `plugins` option (`--plugin-dir`). The plugin carries a dummy skill,
  `tower-harness-positive-probe`, which must appear, as
  `tower-harness-smoke:tower-harness-positive-probe`. With `settingSources: []`
  a plugin is the route that still loads a skill.
- Run 1 asks Claude which skills it has, which CLAUDE.md files are in its
  context, whether it has any permission rules, and whether two phrases from
  `~/.claude/CLAUDE.md` are in its context. Skills that come with the
  account show up too; the dummies are told apart by name.
- Run 2 resumes run 1's session by id (`resume`), straight from the shared
  config directory with no session store, and asks Claude to quote run 1's
  question back.

For each run it prints the config directory and the transcripts already in
it, the init message's skills and plugins, Claude's answer, and whether each
dummy was named in each.

From the repo root, once:

```sh
pnpm install
```

Then, from `mvp/claude-code-harness/`, under a file-access trace:

```sh
mkdir -p runs
timeout 300 strace -f -s 4096 -e trace=%file,%process -o runs/smoke.strace node proofs/smoke.mts claude-haiku-4-5
mv runs/smoke.strace runs/<run 1's dir, as printed>/
```

The trace covers both runs. Both runs' `run.json` name the same `configDir`,
and run 1's transcript is already in it when run 2 starts.

`%process` puts every fork and exec in the trace, so each file access can be
attributed to the process that made it: the proof's node, the capture
wrapper, Claude Code, or one of Claude Code's own children (git, rg, sh, ps,
tmux, and on WSL `reg.exe`).

What to check, in the run directory:

- The skills the model was actually shown are in the transcript's
  `skill_listing` attachment, in
  `config-dir/projects/<project>/<session>.jsonl`. The copy holds every
  session the agent has had; the run's own is the one named by its init
  message's `session_id` in `sdk-messages.jsonl`. The init message's `skills`
  is a different list (the skills that are also slash commands).
- Run 2 resumes run 1's session, so it keeps run 1's session id and appends
  to the same transcript, and Claude Code writes no new `skill_listing` for
  it. The listing in that transcript is run 1's; for run 2, the init
  message's `skills` is the evidence.
- Nothing Claude Code loaded as instructions: the transcript has no CLAUDE.md
  attachment, and the trace has no access to `~/.claude/CLAUDE.md`.
- `grep -o "\"$HOME/[^\"]*\"" smoke.strace | sort | uniq -c` lists every
  path under `$HOME` the run touched.

## Proof 1: summarised thinking

`proofs/thinking.mts <model> <scenario> [NAME=value ...]` runs one scenario
on one model, streaming (`includePartialMessages`). The scenarios
(`summarized`, `omitted`, `none`, `long`, `long-summarized`, `tools`,
`setting`, `switch`) are described at the top of the file. Trailing
`NAME=value` pairs are added to Claude Code's environment.

What was requested of the API is not visible between the SDK and the binary,
so the proof sets `OTEL_LOG_RAW_API_BODIES=file:<dir>`, Claude Code's own
request/response body log (no proxy), and `debugFile`. Both are copied,
redacted, into the run directory:

| Path | What |
| --- | --- |
| `api-bodies/index.jsonl` | one line per API call: query source, model, request and response file names |
| `api-bodies/*.request.json` | each request body as sent, including `thinking` and `betas`; earlier assistant thinking text replaced with `<REDACTED>` by Claude Code |
| `api-bodies/*.response.json` | each response, assembled; thinking text replaced with `<REDACTED>` |
| `debug.log` | Claude Code's debug log |

The proof prints, per turn, the thinking stream events and assistant thinking
blocks with their line numbers in `sdk-messages.jsonl`, the result usage, and
each request's `thinking` and `betas`.

## Proof 24: what Claude Code builds its next query on

`proofs/next/` scores ways a participant could commit, when a query ends,
what Claude Code builds its next query on.

- `offline.mts <proof-23 runs dir> [out.jsonl]`: each way against proof 23's
  recorded runs (raw copies under `~/.local/state/.../proof-23/`), history
  only.
- `run.mts <model> <cell|all> [...]`: live. Per cell a warm-up, the cell's
  prompt (ended by `interrupt()` at an ending, or left to end), each way's
  holding taken at the step's `result`, the probe sent into the same Claude
  Code (the ground truth), then one resume per distinct holding through a
  session store, with the same probe. Env: `P24_LIMIT` (the limit cell's
  output tokens), `P24_RECORDER=1` (Claude Code's undocumented request
  recorder, `CLAUDE_CODE_ELEGANT_MEADOW`), `P24_CONTEXT_USAGE=1`,
  `P24_NO_RESET=1`, `P24_NO_PRIME=1`. Its choices are listed at the top of
  the file, marked undecided.
- `analyse.mts <p24-index.json> [...]`: history and request/cache comparison
  per way; `table.mts <analysis.jsonl> [...]`: scenario by way.
- `setmodel-probe.mts <name> [...]`: which model names `setModel()` accepts.

Raw bodies and store appends stay under
`~/.local/state/tower-claude-code-harness/proof-24/`; run directories get
redacted copies. The harness's own `claude/<n>/stdout.txt` and, for
resumes, `run.json` (the store object's loaded entries) are not redacted
for email.

`options.mts <analysis.jsonl> [...]` writes option by ending
(`runs/p24-options.md`), and `r1.mts <proof-23 runs dir>` how soon each
commit option commits each entry after its transcript write
(`runs/p24-r1.txt`). The resume routes `run.mts` tries are listed in
`ways.mts` (fold, the API error entries kept, an unsent attachment after the
marker) and in `run.mts` (resumeSessionAt, --reply-on-resume, the marker or
partial left out). `P24_ERROR_TIMEOUT` overrides the API-error cell's
timeout.

## Proof 21: stopping an orphaned Claude Code

`proofs/orphans.mts` builds on proof 17b's recovery proof (`proofs/recovery.mts`,
brought in from `proof-17b-shared-dir`; its check is copied unchanged). Agent
name `orphans-21`, file store under `stores/proof-21-orphans/`, store resume
only.

- Layer 2, before each serve: find a live Claude Code on the session
  (`sessions/<pid>.json` in the agent's config dir or any
  `/tmp/claude-resume-*`, pid alive, `procStart` matching), SIGINT it, poll
  `/proc` until it has exited, run proof 17's check, then serve.
- Layer 1: each Claude Code is spawned as
  `setpriv --pdeathsig SIGINT -- <claude> <args>` from `spawnClaudeCodeProcess`.
- Cases `stop`, `kill`, `crash` (no layer 1) and `pd-stop`, `pd-kill`,
  `pd-crash` (layer 1), each `fresh` or `resumed`; the header of the file says
  what each does and what is undecided (TODOs).

From `mvp/claude-code-harness/`, each case under a signal-only trace
(`strace -e trace=none -s 0`: signals delivered, with sender, and exits), then
the summary:

```sh
sh proofs/orphans-all.sh claude-sonnet-5 r1 stop:fresh pd-kill:resumed ...
node proofs/orphans-summary.mts runs/21-*-r1.log > runs/21-summary.txt
```

A layer 2 signal goes only to a pid on the list of Claude Codes the case
started, with the start time it recorded; that list is a safety gate for the
proof, not how the participant finds an orphan.

## Proof 25: finding every leftover by a tag

`proofs/orphan-tag.mts` builds on proof 21's `proofs/orphans.mts` (brought in
from `proof-21-orphans`). Agent name `orphans-25`, file store under
`stores/proof-25-orphan-tag/`, store resume only.

- The tag: each Claude Code is spawned with `TOWER_AGENT=orphans-25` added to
  its environment (`spawnClaudeCodeProcess`); the participant's own
  environment doesn't carry it. Claude Code's own children inherit it.
- `proofs/tag-scan.mts`: reads every `/proc/<pid>/environ` and matches the
  whole entry `TOWER_AGENT=<name>`. From a tagged process it keeps only
  `CLAUDE_CONFIG_DIR`, to find that Claude Code's `sessions/<pid>.json`;
  from any other process, nothing.
- The tag stop, before each serve: scan (excluding the participant's own
  spawns and their descendants), SIGINT each found process with a live pid
  file, wait until everything found has exited, scan again until a scan finds
  none, then proof 17's check, then serve. The file header says what is
  undecided (TODOs).
- `proofs/tag-guard.mts <name>`: the same scan as a reset guard, read-only
  (exit 1 while anything carries the tag, 0 otherwise; never deletes). Not
  wired into `src/harness.mts`. Each case's clean start runs it, then
  `pnpm reset-config-dir`.
- Cases: proof 21's eight with the tag stop; `-now` variants of the four
  served at once, where serve 2's participant is started beforehand and sent
  GO the moment the old one exits; `pf-...-now` controls with proof 21's
  pid-file stop; `pd-double`, a second SIGINT to a Claude Code already
  shutting down. Each `fresh` or `resumed`.

From `mvp/claude-code-harness/`, each case under a signal-only trace, then the
summary:

```sh
sh proofs/orphan-tag-all.sh claude-sonnet-5 r1 pd-stop-now:fresh crash-stop:resumed ...
node proofs/orphan-tag-summary.mts runs/25-summary runs/25-*-r1.log > runs/25-summary.txt
```

A SIGINT goes only to a pid on the list of Claude Codes the case started,
with the start time it recorded; that list is a safety gate for the proof,
not how the participant finds a leftover.
## Proof 22: plain-named skills through the user level, fresh and resumed

`proofs/skills-user-level.mts <model> <scenario> [variant]` runs one scenario
under its own agent name (`p22-<scenario>[-<variant>]`), reset first through
`pnpm reset-config-dir`. `proofs/skills-user-level-trace.mts <file.strace>`
lists every access to a path in the real `~/.claude` or `~/.claude.json` in a
file-access trace, attributed to the Claude Code that made it (fresh, in the
agent dir, or resumed, in a `/tmp/claude-resume-*` dir).

The proof, not the harness, opens the `user` setting source, with
`extraArgs: {'setting-sources': 'user'}` (proof 19's way; the last flag wins,
`run.json` still records `[]`), except `pair-closed`. Every scenario sets
`syncClaudeAiSkills: false` through `settings`, resumes through a session
store (a file store, one JSONL per key, `sessionStoreFlush: 'eager'`), and
puts sentinels in the agent dir: `CLAUDE.md`, `rules/`, `agents/`,
`commands/`, `output-styles/`, and a `settings.json` with a permission rule
and a `UserPromptSubmit` hook that logs the `CLAUDE_CONFIG_DIR` it ran under.

Scenarios:

- `pair-nohook`: a fresh serve, then a resume of it through the store. The
  declared skills are linked into the agent dir's `skills/` by hand. A skill
  added between the serves (`p22-late`) can only reach the resumed Claude
  Code's transcript as a delta if it loaded it.
- `pair-closed`: the same with the user source closed, the trace baseline.
- `pair-hook`: the same pair with a `spawnClaudeCodeProcess` hook that links
  the declared skills into whatever `CLAUDE_CONFIG_DIR` the SDK gives it, then
  starts the SDK's command (the capture wrapper) unchanged.
- `live per-dir|dir-link`: a seed serve, then one resumed and one fresh
  Claude Code at once. Declared skills: none, set, a skill added, a skill
  edited, a skill removed, repointed to another dir, then `reloadSkills()`.
  `per-dir`: the proof applies each change to every config dir the hook
  linked into. `dir-link`: the hook makes a resume dir's `skills/` one link to
  the agent dir's `skills/`, and the proof changes the agent dir only.
- `link-shape whole-dir|every-dir|skill-md`: a pair over a declared dir with a
  plain skill, a plugin-shaped folder with no `SKILL.md` (`p22-shaped`) and a
  skill folder that is also plugin-shaped (`p22-hybrid`: `SKILL.md` plus
  `.claude-plugin/plugin.json`, hooks, `.mcp.json`, an agent, an inner skill).

Which entries get linked and how links are kept in step with the config are
undecided (TODOs in the file). Fixtures are kept, never deleted, under
`~/.local/state/tower-claude-code-harness/p22/`. Each scenario's
`runs/<stamp>-p22-<scenario>/` holds `proof-stdout.txt`, `summary.json`, the
redacted debug logs and request bodies, the store, and the resumed
transcripts copied from the resume dir before the SDK deletes it. The traces
(`strace -f -s 0 -e trace=%file,%process`) are `runs/<stamp>-p22-*.strace`,
read into `runs/<stamp>-p22-*.home-claude.txt`.

```sh
strace -f -s 0 -e trace=%file,%process -o runs/<stamp>-p22-pair-hook.strace \
  node proofs/skills-user-level.mts claude-sonnet-5 pair-hook
node proofs/skills-user-level-trace.mts runs/<stamp>-p22-pair-hook.strace
```

### What the runs showed (Claude Code 2.1.282, SDK 0.3.282, claude-sonnet-5)

- Fresh, user source open: skills load from the agent dir's `skills/` by plain
  name. Also loaded from the agent dir: `CLAUDE.md` and `rules/` (in the first
  request), `agents/` (in `system/init.agents`), `commands/` (listed as a
  skill), `settings.json` (its hook ran, its permission rule is listed).
- Resumed through the store, no hook: the debug log loads skills from
  `/tmp/claude-resume-*/skills` and finds 0. Both bare-name invocations fail
  ("isn't installed"), and `reloadSkills()` names no declared skill. The
  resume dir holds `settings.json` (the SDK copies it), so its hook and
  permission rule still apply. `CLAUDE.md`, rules, agents and commands are not
  loaded: their text in the resumed requests is only the seed serve's
  replayed messages.
- Resumed with the hook: the hook is given the resume dir, links into it
  before Claude Code starts, and the resumed Claude Code loads the skills
  (`p22-late` arrives as a delta listing, both invocations run). The same
  hook is given the agent dir for a fresh serve. The SDK's deletion of the
  resume dir removed the links, not the declared files (hashes unchanged).
- Live, both variants, fresh and resumed alike: set, add and edit reach both
  Claude Codes as delta listings on the next turn after an 8 s settle; a
  removed or repointed-away skill stops dispatching ("isn't available") but is
  never announced; `reloadSkills()` writes a full listing (`isInitial: true`)
  with only the current skills. `dir-link` needed one change in the agent dir
  to reach both.
- Link shape: a whole-dir link and linking every directory both adopt
  `p22-shaped` and `p22-hybrid` as `@skills-dir` plugins (hooks ran, agents
  and prefixed inner skills listed, the hybrid's MCP server started and
  failed). Linking only folders with a `SKILL.md` keeps `p22-shaped` out;
  `p22-hybrid` is still adopted as a plugin, beside its own plain skill.
- Real `~/.claude`: the credential file is opened read-only only (shared
  login), in every run. With the user source closed, the only other access is
  a read of `~/.claude/state/unattended-serving-consent.json` (absent). With
  it open, fresh and resumed Claude Codes alike also run the retention
  cleanup (every one in these runs except the three shortest, which ended
  within about 7 s; when it starts was not measured), which uses hard-coded
  home paths: they list `~/.claude/bridge-spawn`
  (the cleanup deletes entries older than 1 day there), open
  `~/.claude/state/served-calls` (absent) and read and unlink
  `~/.claude/state/settings-review.json` (absent). Nothing there was changed
  in these runs.
- What else opening the user source does, from the runs: the account's
  claude.ai plugin sync writes `plugins/synced/<org>_<account>/` into the
  agent dir and each resume dir (absent with the source closed; nothing was
  installed); the retention cleanup, skipped under `[]`, runs with the
  default 30 days over the agent dir's own files (nothing was old enough to
  be deleted here); `output-styles/` is read (the sentinel style is loaded,
  not selected). The trace shows the fresh Claude Code opening every
  sentinel in the agent dir, and the resumed one opening none of them, only
  looking for `CLAUDE.md`, `rules`, `commands` and `output-styles` in its
  resume dir (absent). No `unlinkat`, `renameat` or `rmdir` relative to a
  directory fd touched `~/.claude` in any trace.
- From the binary only (2.1.282, not run): the user source also gates
  user-scope MCP servers in `<config dir>/.claude.json`, `workflows/`,
  `processWrapper`, the user `sandbox` block, `env`, hooks, `statusLine`,
  `apiKeyHelper`, `enabledPlugins` and the other merged-settings keys, the
  claude.ai skills sync into `skills/synced/` (off with
  `syncClaudeAiSkills: false`), and writes to `<config dir>/settings.json`
  (sandbox exclusions, `blockReadsOutsideWorkingDirectories`, `effortLevel`,
  clearing `model` for an org default). Not gated by it: `keybindings.json`,
  `themes/`, `loop.md`, the `.claude.json` `env`, startup migrations of
  `settings.json`, and a set of bare reads of `settings.json`. The real-home
  paths in the binary (`~/.claude/bridge-spawn`, `~/.claude/state/...`,
  `~/.claude/ide` when `CLAUDE_CONFIG_DIR` is set, `~/.claude/.device-keys.json`)
  are not gated by the user source; the cleanup that reaches the first two is.
- `get_hooks_listing` labels the agent dir's hook "User settings
  (~/.claude/settings.json)"; the hook log shows it ran from the agent dir
  and the resume dir, never from `~/.claude`.

## Proof 26: keeping Claude Code's own machinery out of the user's home

`proofs/home.mts <model> <option>` runs proof 22's pair (a fresh serve, then a
resume of it through a session store) under the agent name `p26-<option>`,
reset first. It uses proof 22's spawn hook, which links the declared skill
`p26-seed` into whatever `CLAUDE_CONFIG_DIR` the SDK gives it. The `user`
source is opened the way proof 22 did it, except in `real-closed`.

Each serve runs these turns:

1. A no-tool turn.
2. A 30 s idle wait, so the housekeeping runs.
3. `/p26-seed`.
4. One Bash command of probes. It prints `HOME` and git's config origins and
   identity inside this worktree, without values. It prints `gh auth status`'s
   exit code, npm's userconfig path and whether that file exists, and
   `ssh -G`'s identity files.
5. Read and Write of `~/.local/state/tower-claude-code-harness/p26-probe/...`.
   The same file sits in both homes with different markers.
6. The stdio MCP server `proofs/home-mcp.mjs`, which reports its `HOME`.

The resumed serve stops after the Bash probe. The agent dir's `settings.json`
has a hook that logs the `HOME` it ran with.

`sh proofs/home-run.sh <model> <option>` runs one option under
`strace -f -y -ttt -s 0 -e trace=%file,%process,bind,connect`, which records
paths and never contents. It then reads the trace:

- `proofs/home-trace.mts` lists every access outside the run's own
  directories. It covers the real home, `/run/user/<uid>`, `/tmp` and the
  private HOME, labelled by process and by phase.
- `proofs/home-trace-brief.py` condenses that listing.
- `proofs/home-trace-machinery.py` keeps Claude Code's own accesses and every
  write.

Everything lands in `runs/<stamp>-p26-<option>/`.

HOME is set through `options.env`. The harness forces
`CLAUDE_SECURESTORAGE_CONFIG_DIR=""`, so the absolute value is set in the spawn
hook, which is proof code. Options that keep the real HOME with the `user`
source open run Claude Code inside bwrap with read-only binds of the real
paths the housekeeping prunes: `~/.claude/bridge-spawn`, `~/.claude/state`,
`~/.claude.json`, `~/.cache/claude`, `~/.cache/claude-cli-nodejs`,
`~/.local/share/claude` and `~/.local/state/claude`. This is the test's
guard: a delete there fails with `EROFS` and shows in the trace. `~/.claude`
itself is not guarded, because the login and its refresh lock live there.

Options:

| Option | What |
| --- | --- |
| `real-closed` | reference: the harness today (real HOME, user closed) |
| `real-open` | real HOME, user open, nothing switched off |
| `real-open-env` | + `DISABLE_AUTOUPDATER=1`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `CLAUDE_CODE_TMPDIR`, `XDG_RUNTIME_DIR` to private dirs |
| `real-open-cleanup0` | + flag setting `cleanupPeriodDays: 0` |
| `real-open-all` | both of the above |
| `real-open-mask` | bwrap binds private dirs over the housekeeping paths |
| `private-bare` | private HOME, `CLAUDE_SECURESTORAGE_CONFIG_DIR=$REAL_HOME/.claude` |
| `private-empty-secure` | private HOME with the harness's `""` (control) |
| `private-prefix-only` | private-bare + `CLAUDE_CODE_SHELL_PREFIX=proofs/home-shell-prefix.sh` (runs `HOME=<real> bash -c "$1"`) |
| `private-prefix` | + the MCP config's `env` sets `HOME` too |
| `private-links` | private-bare + links to the real `.gitconfig`, `.config/gh`, `.ssh`, `.npmrc` |
| `private-full` | private-prefix-only + `CLAUDE_CODE_TMPDIR`, `XDG_RUNTIME_DIR` to private dirs |

Which dotfiles a private HOME links back is undecided (TODO in the file). The
private HOME is fresh per proof run and kept under
`~/.local/state/tower-claude-code-harness/p26/`. Whether a participant's is
per agent and reused is undecided.

### What the runs showed (Claude Code 2.1.282, SDK 0.3.282, claude-sonnet-5, 27 Sep)

**Every option.**
- The login worked, except in `private-empty-secure` ("Not logged in").
- The only access to the credentials file was an `O_RDONLY` open of
  `~/.claude/.credentials.json`.
- No token refresh happened, so there was no lock and no write. From the
  code, the refresh lock is `<secure-storage dir>/.oauth_refresh.lock`, beside
  the file. The secure-storage dir is `$HOME/.claude` for `""` and the path
  itself when absolute.
- No `.credentials.json` appeared in the agent dir, the fixtures or any resume
  dir.
- Plain-named `/p26-seed` ran fresh and resumed in every option with the user
  source open. With it closed, it was "not installed".

**Real HOME with the user source closed** (the harness today):
- Writes MCP logs to `~/.cache/claude-cli-nodejs/<project>/`.
- The updater housekeeping reads `~/.local/share/claude/versions` and
  `~/.local/state/claude/locks`, and stats `~/.cache/claude/staging`.
- Reads `~/.gitconfig`, `~/.config/git/ignore`, `~/.config/anthropic/*` and
  `~/.claude/state/unattended-serving-consent.json`.
- Binds a socket in `/run/user/<uid>/cc-socks/`.

**Real HOME with the user source open** also:
- lists the real `~/.claude/bridge-spawn`. The code has a literal 1-day sweep
  there, rooted at `homedir()`.
- opens `~/.claude/state/served-calls`.
- reads and tries to unlink `~/.claude/state/settings-review.json`. It was
  absent, and the guard made the unlink `EROFS`.
- walks every project's folder under the shared `/tmp/claude-1000/`, about 70
  of them, for `<session>/images`.

Nothing in the real home was changed.

**The option 1 switches:**
- `real-open-env`: the MCP logs, the updater paths and `/tmp/claude-1000` move
  away. `cc-socks` goes to `/tmp/cc-socks-<uid>`, not to the private
  `XDG_RUNTIME_DIR`. The bridge-spawn, served-calls and settings-review
  accesses stay.
- `real-open-cleanup0`: those three stop. The debug log says "Skipping
  cleanup: settings have validation errors but cleanupPeriodDays was
  explicitly set": `0` is invalid (the docs say so), and the invalid settings
  are what skip the cleanup. In that run the claude.ai plugin sync wrote no
  `plugins/synced/`. Hooks still ran and transcripts were still written.
- `real-open-all`: nothing written to or deleted from the real home. Still
  there: the reads above, the Read and Write tools' stat of
  `~/.claude/state/settings-review.json`, and `/tmp/cc-socks-<uid>`.
- `real-open-mask`: the housekeeping lands in the mask dirs. `/tmp/claude-1000`
  and `/run/user/<uid>/cc-socks` are untouched by the mask. The 3-day-old
  entries planted in the masks were not deleted, so there is no positive
  deletion control. The listing is the evidence the cleanup ran.

**Private HOME** (`private-*`):
- The real home is reached only by the credentials read and by PATH lookups.
- The housekeeping lands in the private HOME: bridge-spawn, served-calls,
  settings-review, the updater dirs, `.cache/claude-cli-nodejs` and
  `.config/anthropic`.
- The CLAUDE.md-style ancestor walk no longer stops at the real home. It
  stats the real `~/.claude/{skills,agents,commands,workflows,output-styles}`
  as a project `.claude`. That is stat only; nothing was opened, and the
  project source was closed.
- `/tmp/claude-1000` and `cc-socks` stay shared unless moved (`private-full`).

**Commands under a private HOME:**
- Bash, hooks and the MCP server see the private HOME. The git identity fails
  (exit 128), `gh auth status` fails, and npm's userconfig points at the
  private HOME.
- ssh is unaffected: it opened the real `~/.ssh/config`, taking home from the
  passwd entry.
- The shell snapshot sources no rc files. With the real HOME it sources
  `~/.profile` and `~/.bashrc`.
- `CLAUDE_CODE_SHELL_PREFIX` puts the real HOME back for Bash, hooks and
  stdio MCP start-up (its log shows each). git, gh and npm then work. It does
  not wrap the snapshot shell.
- Read and Write resolve `~` to the private HOME in every private option.
- Links to the dotfiles fix gh and npm but not the git identity: its includes
  resolve under the private HOME.
- Commands inherit whatever switches an option sets. In `real-open-all` the
  Bash probe printed the private `XDG_CACHE_HOME`, `XDG_STATE_HOME`,
  `XDG_DATA_HOME`, `XDG_RUNTIME_DIR` and `CLAUDE_CODE_TMPDIR`, and
  `DISABLE_AUTOUPDATER=1`. In `private-full` it printed `CLAUDE_CODE_TMPDIR`
  and `XDG_RUNTIME_DIR`. The prefix restores only `HOME`. git, gh and npm
  still worked in both.
- Code quotes behind the above (secure-storage dir, credential file, refresh
  and write locks, the bridge-spawn sweep, the `cleanupPeriodDays` cutoff, and
  the SDK's Keychain naming and store-resume copy) are collected, verbatim with
  offsets, in `runs/p26-code-evidence.txt`.
