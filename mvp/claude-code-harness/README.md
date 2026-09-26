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

## Proof 12: skills from a directory declared in config

The question: how does a running Claude Code get skills from a directory
named in config, without `settingSources`. The harness forces
`settingSources: []` on every run regardless of what a proof passes
(`src/harness.mts`), which is the same constraint the Claude Code participant
runs under, so every option here is checked under that fixed baseline, not
argued from the docs alone.

`proofs/skills-dir.mts <model> <scenario>` runs one scenario
(`plugin-no-manifest`, `add-dir-only`, `add-dir-reload`,
`project-config-root`), each its own process. Ground truth for "did the model
actually see this skill" is the transcript's `skill_listing` attachment
(`config-dir/projects/<project>/<session>.jsonl`, `attachment.type ===
"skill_listing"`, carrying `names` and `skillCount`), not the model's own
free-text answer to the SKILLS question each scenario also asks: a small
model can omit or invent a name, and the first draft of this proof caught
exactly that gap on the plugin scenario (see below). A `skill_listing` is
attached only when it changes, or on the first turn, so its absence after a
later turn means "unchanged", not "no skills".

Streaming input mode does not emit `system/init` until the first user
message is sent. The proof's first draft looped on `run.messages()` waiting
for `init` before any `send()`, and hung until `timeout` killed every one of
the three runs it started; that bug, and the fix (send the first turn, then
read `init` off that turn's stream), are why every scenario below sends
before it ever inspects a message.

### Findings, each with its run

**A plugin (`plugins: [{type: 'local', path}]`) loads under `settingSources:
[]`, and its skill is always namespaced `<plugin-name>:<skill-name>`; that
name is not avoidable, but the skill also carries a bare-name alias a human
can dispatch by.** No `.claude-plugin/plugin.json` manifest is required: the
plugin's structure is auto-discovered, and its name falls back to the
directory's own basename
(`code.claude.com/docs/en/plugins/manifest-reference`, "Plugin structure
reference": "The manifest is optional. When omitted, Claude Code
auto-discovers components from the directory layout"; the fallback naming
rule is documented at `code.claude.com/docs/en/plugins/manifest-reference`
line 30 of the fetched copy: "The plugin name then comes from the
marketplace entry, or from the directory name when you load the plugin with
`--plugin-dir`"). The namespacing itself is unconditional
(`code.claude.com/docs/en/skills`, "Resolve skills that share a name" table:
"A plugin skill and a skill at any of the locations above | Both load,
because plugin skills are namespaced as `/plugin-name:skill-name`"), and
`SdkPluginConfig` (`sdk.d.ts`) has no field to override it.

Run: `runs/2026-09-26T114821580564Z-skills-dir-plugin-no-manifest`. A plugin
directory named `plugin` with one skill, `proof12-plugin-skill-a`, loaded
with no manifest; `system/init.plugins` reported
`{"name":"plugin","path":".../plugin","source":"plugin@inline"}` and the
skill listed as `plugin:proof12-plugin-skill-a`. `query.reloadSkills()`'s
response carried `{"name":"plugin:proof12-plugin-skill-a", ...,
"aliases":["proof12-plugin-skill-a"]}`. Sending the bare `/proof12-plugin-skill-a`
and the qualified `/plugin:proof12-plugin-skill-a` as separate turns both
invoked the skill (the model's reply named the skill's canonical, prefixed
form in both cases, matching the skill's own body).

**A new skill file dropped into an already-loaded plugin's `skills/`
directory is not picked up on its own; `query.reloadSkills()` picks it up,
`query.reloadPlugins()` is not additionally needed.** Same run. A second
skill, `proof12-plugin-skill-b`, was written to the same plugin directory
mid-run. Three seconds later, with no reload call, both the model's answer
and the transcript's own `skill_listing` (`skillCount: 14`, no
`skill-b`) agreed it was still invisible. Calling `query.reloadSkills()`
immediately after returned a skills list that already carried
`plugin:proof12-plugin-skill-b`, and the next turn's fresh `skill_listing`
confirmed it (`skillCount: 15`). This is the harness's own analogue of
bridge's rescan-per-say `skills` control line (`mvp/CLAUDE.md`): a plugin
directory can be re-pointed to fresh content, but only on an explicit call,
never a background watch, so a participant using this route would need to
call `reloadSkills()` itself before or at each say. Nothing in this run
needed `reloadPlugins()`; that call also succeeded but changed nothing
`reloadSkills()` hadn't already picked up. Contrast: the personal, project
and `--add-dir` skills locations get a background filesystem watch with no
reload call (`code.claude.com/docs/en/skills`, "Edit a skill during a
session": "Claude Code watches skill directories for file changes... Claude
Code picks up the change within the current session, without a restart");
that sentence never names a plugin's own `skills/` directory, and this run
shows it does not get the same watch for a brand new file.

**`additionalDirectories` (`--add-dir`) does not load skills from
`<dir>/.claude/skills/` under `settingSources: []`, and `reloadSkills()`
does not reach past that gate either.** Doc: `additionalDirectories`'s
own skill-loading path is documented as going through the project settings
source (`code.claude.com/docs/en/agent-sdk/skills`, the settingSources Note:
"The project source also covers `<dir>/.claude/skills/` in each directory
you pass through `additionalDirectories`... If you set `settingSources`
explicitly, include `'project'`... or use the `plugins` option... to load
skills from a specific path"). Runs:
`runs/2026-09-26T115124362176Z-skills-dir-add-dir-only` (one turn,
`additionalDirectories` naming a directory with
`.claude/skills/proof12-adddir-skill-c/`; `skill_listing` came back
`skillCount: 13`, thirteen built-in/account skills, no `skill-c`) and
`runs/2026-09-26T115202568179Z-skills-dir-add-dir-reload` (same fixture,
plus a `query.reloadSkills()` call between two turns; both turns' listings
stayed at `skillCount: 13`, unchanged).

**`projectConfigRoot` is gated the same way.** Same negative, same fixture
shape, one live run:
`runs/2026-09-26T115221865227Z-skills-dir-project-config-root`. `sdk.d.ts`
describes `projectConfigRoot` as where "the `.claude` config trees (commands,
agents, skills, workflows, routines, output-styles...) come from... instead
of `cwd`"; the run's `skill_listing` still came back `skillCount: 13`, no
`proof12-projectroot-skill-d`, matching the `additionalDirectories` result
and confirming the gate is on the settings source, not on which option named
the directory.

**`register_repo_root` is a control request the Agent SDK cannot send.** It
exists only in `sdk.d.ts` (`SDKControlRegisterRepoRootRequest`, "Add a
directory as a working-directory root and optionally reload CLAUDE.md,
skills, and plugins"), with no method exposed on the typed `Query` interface
the way `reloadSkills`/`reloadPlugins` are. `grep -n
"register_repo_root|registerRepoRoot"
node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
node_modules/@anthropic-ai/claude-agent-sdk/core.mjs` has zero hits, against
matches for `reload_skills` and `reload_plugins` in the same files: the
runtime code never constructs this request, so it is reachable, if at all,
only through the `addDirectories` `PermissionUpdate` a `canUseTool` callback
can return (`destination: 'session'`), and the request's own doc ties even
that to being "a strict subdirectory of cwd, or of a directory passed at
launch via `--add-dir`", the same family the runs above show gated by
`settingSources`. Not run live: it needs a `canUseTool` approval flow to
trigger at all, which is a different shape from "declare a directory in
config" and was judged out of scope for this proof; TODO: undecided whether
it is worth a follow-up proof.

**Not run, doc-only, and why:**
- The managed `/etc/claude-code/.claude/skills/` directory: writing it
  changes Stephen's own machine-wide Claude Code config, not just this
  harness.
- A settings-declared plugin (`enabledPlugins`, a marketplace): still the
  plugin route above, just named from a settings file instead of the SDK
  option; the harness's `settingSources: []` would also block the settings
  file that names it.
- `$CLAUDE_CONFIG_DIR/skills/`: the user settings source, same gate.

### Choices this proof made that the brief did not

- Model: `claude-haiku-4-5`, matching the smoke proof's own README example.
- The plugin fixture has no `.claude-plugin/plugin.json` manifest, to test
  the cheaper, no-manifest shape rather than repeat the smoke proof's
  manifest-bearing one.
- Fixture directories live under `os.tmpdir()` via `mkdtempSync`, removed in
  a `finally`, matching the "`/tmp` cleared at boot" rule rather than adding
  anything long-lived under the repo.
- The plugin's directory is literally named `plugin`, which is why its
  fallback-namespaced skill reads `plugin:proof12-plugin-skill-a`; a
  differently-named directory would change the prefix's text, not whether
  there is one.
- A 3-second settle before the "no reload call" turn, to give a filesystem
  watcher (if one exists for a plugin's `skills/` dir) a chance to fire
  before concluding it does not.
- `register_repo_root` was left doc-only rather than driven through a
  `canUseTool`-approval live run; see the TODO above.
