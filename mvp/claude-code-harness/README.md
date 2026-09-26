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
