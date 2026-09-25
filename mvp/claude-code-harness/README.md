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

Everything about Claude Code's behaviour comes from the proof's `options`
(model, permission mode, tools, setting sources, ...). `options.model` is
required. The harness sets only:

- `CLAUDE_CONFIG_DIR`: a fresh, empty directory per run, under
  `~/.local/state/tower-claude-code-harness/config-dirs/<run id>`.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR=""`: the login (below).
- `pathToClaudeCodeExecutable`: `bin/claude-capture`, which runs the SDK's own
  bundled `claude` binary and records it.
- It strips a parent Claude Code session's variables from the environment
  (from `options.env` too): `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
  `AI_AGENT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`,
  `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`,
  `CLAUDE_CODE_INVOKED_SKILLS`, `CLAUDE_CODE_MESSAGING_SOCKET`,
  `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_BRIDGE_SESSION_ID`. The ones
  actually found are listed in the run's `run.json` as `strippedEnv`.

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
| `run.json` | run id, config dir, real binary, SDK version, options as passed (env as names only), stripped env names |
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

## Re-running the smoke run

From the repo root, once:

```sh
pnpm install
```

Then, from `mvp/claude-code-harness/`:

```sh
mkdir -p runs
strace -f -s 4096 -e trace=%file -o runs/smoke.strace node proofs/smoke.mts claude-haiku-4-5
```

It prints the run directory, `assistant: pong`, `result: success` and `done`.
Move the trace into the run directory it printed:

```sh
mv runs/smoke.strace runs/<run dir>/
```

### Checking `~/.claude/settings.json` was not read

`strace -e trace=%file` records every syscall that names a path (open, stat,
access, readlink, ...), in every process the run started. In the run
directory:

```sh
grep -c "\"$HOME/.claude/settings.json\"" smoke.strace
grep -o "\"$HOME/.claude/[^\"]*\"" smoke.strace | sort | uniq -c
grep -o '"[^"]*settings[^"]*\.json"' smoke.strace | sort | uniq -c
```

The first should print `0`. The second is the control: it shows
`~/.claude/.credentials.json` opened, so the trace does see file access under
`~/.claude`. The third lists every settings file Claude Code looked for,
which should include the run's own config dir's `settings.json`.

The same trace shows `~/.claude/CLAUDE.md` is read, not through the config
dir but because the working directory is under `$HOME`: Claude Code walks up
the parent directories for `.claude/CLAUDE.md`, and reaches `$HOME/.claude/`.
The session transcript lists it as "project instructions".
