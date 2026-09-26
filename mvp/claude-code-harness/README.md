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
- `CLAUDE_CONFIG_DIR`: a fresh, empty directory per run, under
  `~/.local/state/tower-claude-code-harness/config-dirs/<run id>`.
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
  of that proof. Never cleared. A proof can't pass `cwd`.
- `pathToClaudeCodeExecutable`: `bin/claude-capture`, which runs the SDK's own
  bundled `claude` binary and records it.

Everything else comes from the proof's `options` (model, permission mode,
tools, plugins, skills, ...). The harness has no defaults of its own.
`options.model` is required.

## The login

Settings and config live in the run's own `CLAUDE_CONFIG_DIR`; the login is
Stephen's own. With `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the empty string,
Claude Code 2.1.282 keeps its credential file, its refresh lock and (macOS)
its Keychain item where a default install does: `~/.claude/.credentials.json`
on Linux, the `Claude Code-credentials` Keychain item on macOS. So a run and
Stephen's own Claude Code share one login, and a token refresh by either one
goes through the same lock and is seen by the other. No credential file is
written into the run's config directory.

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
| `config-dir/` | copy of the run's config directory after the run |
| `config-dir-manifest.json` | what was copied, skipped or redacted |

Timestamps are wall-clock ISO 8601 with microseconds. `<n>` counts the times
the SDK started the binary in that run.

No credential is written under the repo: `.credentials.json` is never
copied, and anything matching `sk-ant-...` (Anthropic keys and Claude.ai
tokens) is replaced with `sk-ant-[REDACTED]` in every file the harness
writes. The copied `.claude.json` does hold account details (name, email,
organisation). The live config directories outside the repo are kept.

## The smoke run

`proofs/smoke.mts` proves the isolation baseline, with a positive and a
negative test:

- **Negative:** it writes a dummy skill, `tower-harness-negative-probe`, to
  `~/.claude/skills/` for the length of the run. It must not appear. The run
  refuses to start if that directory already exists, and removes it
  afterwards whatever happens.
- **Positive:** it passes its own plugin, `proofs/smoke-plugin/`, through the
  SDK's `plugins` option (`--plugin-dir`). The plugin carries a dummy skill,
  `tower-harness-positive-probe`, which must appear, as
  `tower-harness-smoke:tower-harness-positive-probe`. With `settingSources: []`
  a plugin is the route that still loads a skill.
- It asks Claude which skills it has, which CLAUDE.md files are in its
  context, whether it has any permission rules, and whether two phrases from
  `~/.claude/CLAUDE.md` are in its context. Skills that come with the
  account show up too; the dummies are told apart by name.

It prints the init message's skills and plugins, Claude's answer, and whether
each dummy was named in each.

From the repo root, once:

```sh
pnpm install
```

Then, from `mvp/claude-code-harness/`, under a file-access trace:

```sh
mkdir -p runs
timeout 300 strace -f -s 4096 -e trace=%file,%process -o runs/smoke.strace node proofs/smoke.mts claude-haiku-4-5
mv runs/smoke.strace runs/<run dir it printed>/
```

`%process` puts every fork and exec in the trace, so each file access can be
attributed to the process that made it: the proof's node, the capture
wrapper, Claude Code, or one of Claude Code's own children (git, rg, sh, ps,
tmux, and on WSL `reg.exe`).

What to check, in the run directory:

- The skills the model was actually shown are in the transcript's
  `skill_listing` attachment, in
  `config-dir/projects/<project>/<session>.jsonl`. The init message's
  `skills` in `sdk-messages.jsonl` is a different list (the skills that are
  also slash commands).
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

## Proof 7: the participant stopped or killed mid-turn

`proofs/stopped.mts` (modes described at the top of the file). Claude Code is
spawned by the host directly (the SDK's `spawnClaudeCodeProcess` hook, same
command line, env and abort signal), not through the capture wrapper, so the
process tree is host -> claude and a process-group signal arrives once. The
hook still writes `claude/<n>/` (real pid in `argv.json`) and adds a
`--debug-file`, copied redacted into the run as `debug-<n>.log`. Proof 7
stamps its own records from the wall clock (`Date`), because the harness's
`stamp()` was seen 140-170 ms away from the clock strace and Claude Code use.

- `sh proofs/stopped-q1.sh <model>`: one Claude Code stopped mid-reply and
  mid-tool by abort, `interrupt()`, SIGINT and SIGTERM, each once under
  `strace` and once without. Each run has `stop.json`, `strace.txt` (traced)
  and `analysis.txt`.
- `sh proofs/stopped-q2.sh <model>` (`GAPS="100 3000"` for other gaps): three
  Claude Codes, three Ctrl-C presses from a driver process, to the host or to
  its process group. Each `runs/<ts>-stopped-drive-*/` has `strace.txt`,
  `host-log.txt`, `drive-log.txt`, `snapshots.jsonl`, `transcript-watch.jsonl`
  and `analysis.txt`; each Claude Code's own run dir has `store-appends.jsonl`.
- `node proofs/stopped.mts seed <model>`, then `drive <model> kill-fresh` and
  `drive <model> kill-resume <seed dir>`: SIGKILL to the host.
- `node proofs/stopped.mts recover <model> <kill drive dir>`: finds the
  transcripts, publishes what the store lacks, resumes and asks.

File-backed stores live under `~/.local/state/tower-claude-code-harness/stores/`
and debug logs under `.../debug/`, outside the repo.

## Proof 17: recovery when nobody knows how the last run ended

`proofs/recovery.mts` (modes and TODOs at the top of the file). A participant
is its own process (`participant <spec.json>`). Its spec holds, per
conversation, only a session id (none for a new one) and the message to say.
Everything else it knows is a constant in the file: the store root, the
config-dirs root, `os.tmpdir()`, its working directory and the model. Before
any Claude Code starts, it runs the same check on every conversation it is
given a session id for, twice:

- It looks for `<session>.jsonl` under every config dir and every
  `/tmp/claude-resume-*`.
- It looks for a matching `sessions/<pid>.json` (live when the pid is alive
  and `procStart` equals field 22 of `/proc/<pid>/stat`), and for command
  lines naming the session.
- It reads each transcript with `importSessionToStore` and appends what the
  store lacks (by uuid; entries without one by content).

The driver (`case <model> <case> <fresh|resumed>`) ends a participant one way
and serves again with a new one. It keeps a copy of every transcript line it
sees (generations kept when a file shrinks or comes back), and scores the
serve: lost entries, branches in the store, and whether the last-written
entries are in the resumed Claude Code's first API request
(`OTEL_LOG_RAW_API_BODIES`).

```sh
sh proofs/recovery-all.sh <model>     # every case, four lanes
node proofs/recovery.mts case <model> kill-orphan fresh
```

Each `runs/<ts>-recovery-<case>-<variant>/` has `driver-log.txt`,
`ending.json`, `keeper.jsonl`, `seen/`, `result.json` and one directory per
participant (`spec.json`, `participant-log.txt`, `check-<tag>.json`, and for
a serve that asks, `score.json`, `first-request-<tag>.json` and
`rescore.json`). Read `rescore.json` for whether the resume carried the
last-written entries: it matches by content, while `score.json`'s
`inRequest` is a substring test that a synthetic tool result or a prompt
saying "reply DONE" passes. `node proofs/recovery.mts --rescore <case dir>`
redoes it. The store is
`~/.local/state/tower-claude-code-harness/stores/proof-17-recovery/`. The
reboot cases delete only the resume dirs that hold their own sessions, not
every `/tmp/claude-resume-*`, because other sessions on the machine use them.
