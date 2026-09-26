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

`proofs/skills-dir.mts <model> <scenario>` runs one scenario, each its own
process: `plugin-no-manifest`, `add-dir-only`, `add-dir-reload`,
`project-config-root`, `plugin-flat-layout`, `plugin-symlink-repoint`,
`plugin-edit-existing`, `register-repo-root-raw`, `settings-plugin`. Ground
truth for "did the
model actually see this skill" is the transcript's `skill_listing`
attachment (`config-dir/projects/<project>/<session>.jsonl`,
`attachment.type === "skill_listing"`, carrying `names`, `skillCount` and the
raw `content` string), checked by timestamp against which turn's own prompt
immediately precedes it, not the model's free-text answer to the SKILLS
question every scenario also asks. A `skill_listing` is attached only when
it changes, or on the first turn; its absence after a later turn means
"unchanged from the previous listing", not "no skills", which is why the
timestamp check matters and not just whether a name appears anywhere in the
transcript.

Streaming input mode does not emit `system/init` until the first user
message is sent. The proof's first draft looped on `run.messages()` waiting
for `init` before any `send()`, and hung on every run it started: one,
piped through `tail` under a 180-second `timeout`, exited `143` when
`timeout` killed the pipeline; two more, given their own `timeout` wrappers
after that, exited `124`; a fourth had no `timeout` wrapper and was stopped
by hand. The fix (send the first turn, then read `init` off that turn's
stream) is why every scenario below sends before it ever inspects a
message.

### Findings, each with its run

**A plugin (`plugins: [{type: 'local', path}]`) loads under `settingSources:
[]`, and its skill is always namespaced `<plugin-name>:<skill-name>`; that
name is not avoidable, but the skill also carries a bare-name alias that
dispatches it.** No `.claude-plugin/plugin.json` manifest is required: the
plugin's structure is auto-discovered, and its name falls back to the
directory's own basename (`code.claude.com/docs/en/agent-sdk/plugins`,
"Plugin structure reference": "A plugin directory typically contains a
`.claude-plugin/plugin.json` manifest file. The manifest is optional. When
omitted, Claude Code auto-discovers components from the directory layout";
the fallback naming rule itself is on a different page,
`code.claude.com/docs/en/plugins/manifest-reference`, as fetched 26 Sep:
"The manifest is optional. Without it, Claude Code loads the components it
finds in the standard layout... The plugin name then comes from the
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
"aliases":["proof12-plugin-skill-a"]}`. Sending the bare
`/proof12-plugin-skill-a` and the qualified `/plugin:proof12-plugin-skill-a`
as separate turns both dispatched it: the transcript's own record of each
turn (not the model's reply) shows the CLI rewrote both prompts to the same
`<command-name>/plugin:proof12-plugin-skill-a</command-name>` before Claude
ever saw them.

**A plugin's own path is fixed once the process starts; nothing in the SDK
re-points it to a different directory, but content inside that fixed path
can be rescanned on an explicit call, and a filesystem-level indirection
(the path's `skills/` entry as a symlink) turns that rescan into a genuine
re-point.** `Query` has no method that takes a plugin path: `reloadPlugins()` takes only
an optional `holdOnCacheImpact`, and `grep -o 'subtype:"[a-z_]*"'
node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs | sort -u` lists exactly
one plugin-related request subtype the runtime ever constructs,
`reload_plugins`. The plugin list is part of the one-time `query()` call,
not a control request.

Two same-path tests, one run each, plus a third run that changes the path's
target instead: `runs/2026-09-26T114821580564Z-skills-dir-plugin-no-manifest`
added a second skill file, `proof12-plugin-skill-b`, to the same
already-loaded plugin's `skills/` directory mid-run. Three seconds later,
with no reload call, the transcript's own next `skill_listing`
(`skillCount: 14`, matching the turn immediately before the edit) had not
changed; `query.reloadSkills()` immediately after returned a list already
carrying `plugin:proof12-plugin-skill-b`, and the following turn's fresh
listing confirmed it (`skillCount: 15`). `query.reloadPlugins()` also
succeeded but changed nothing `reloadSkills()` hadn't already picked up.
`runs/2026-09-26T120440996819Z-skills-dir-plugin-edit-existing` repeated
this for an edit to an *existing* file (changing a marker string in
`SKILL.md`'s own description, not adding a file): by timestamp, the turn
sent three seconds after the edit still carried the old marker's cached
listing, and only the turn sent right after `query.reloadSkills()` carried
the new one. What these two runs show is only about a plugin's own
`skills/` directory: with `settingSources: []`, Claude Code (2.1.282, Agent
SDK 0.3.282) did not pick up either a new file or an edited one there
without an explicit `reloadSkills()` call. That differs from the documented
behaviour of the personal, project and `--add-dir` locations
(`code.claude.com/docs/en/skills`, "Edit a skill during a session": "Claude
Code watches skill directories for file changes... Claude Code picks up the
change within the current session, without a restart"), but neither this
run nor that doc says why: `settingSources: []` also means none of those
three locations load at all in this harness, so there is no comparable
watch running in the same process to contrast against, and nothing here
traces the cause to the plugin path specifically (an `strace -e
trace=%file` run watching for `inotify_add_watch` on the plugin's `skills/`
directory, as the smoke run's own README section already does for a
different path, would be needed for that).

`runs/2026-09-26T120323557020Z-skills-dir-plugin-symlink-repoint` then
tested changing the directory rather than rescanning it: the plugin's path
was a wrapper directory whose only entry, `skills`, was a symlink to a first
target directory (one skill, `-f`, itself a plain `<name>/SKILL.md`
directory like the one `plugin-flat-layout` showed gets rejected as a
plugin root on its own). After the first turn, the symlink was swapped to a
second, unrelated target directory (one skill, `-g`, no relation to `-f`),
followed by `query.reloadSkills()`. The next turn's `skill_listing` carried
only `symlink-plugin:proof12-symlink-skill-g`; `-f` was gone entirely, not
merely superseded. The plugin's own name and path (`symlink-plugin`, the
wrapper directory) never changed; only what the symlink pointed at did.
This is the only way this proof found to change which directory's content a
plugin serves after the process has started: wrap it, symlink `skills/` to
the real, plain-layout directory, and call `reloadSkills()` after
re-pointing the symlink. `Query` has no method that takes a new path for an
existing plugin.

**A plugin's own root must already look like a plugin (a `skills/`,
`agents/`, `hooks/`, `commands/`, or `.claude-plugin/` child); a directory
with a skill folder directly inside it is not recognized as a plugin at
all.** Doc: `code.claude.com/docs/en/agent-sdk/plugins`, "Path
specifications": "The path should point to the plugin's root directory: the
parent of `skills/`, `agents/`, `hooks/`, `commands/`, or
`.claude-plugin/`." Run: `runs/2026-09-26T120230284636Z-skills-dir-plugin-flat-layout`,
a plugin path whose only content was `<name>/SKILL.md` directly under it, no
`skills/` level. `system/init.plugins` never listed it at all (only the two
builtin plugins), and the `skill_listing` never carried the skill: this is
enforced, not merely the documented convention.

**A settings-declared, directory-sourced marketplace loads a plugin from a
local path, mid-session, entirely through `settingSources: []`, with the
same namespacing as the `plugins` option.** `extraKnownMarketplaces` accepts
a marketplace whose own source is a local directory
(`code.claude.com/docs/en/settings-reference`: `"directory": { "source":
"directory", "path": "/opt/acme-corp/approved-marketplaces" }`, "path
required, the absolute path to a directory containing
`.claude-plugin/marketplace.json`"), and that marketplace's own plugin
entries can use a relative-path source inside it
(`code.claude.com/docs/en/plugins/marketplace-reference`, "Relative path
plugin source": "A relative path resolves only when Claude Code has the
marketplace's files, so check the marketplace source type: `github`, `git`,
`file`, and `directory`: Claude Code has the marketplace's files"; a
different sentence on the same page, "`settings`: relative paths are
rejected outright", is about a marketplace whose own source is `settings`,
the inline-plugin-list form, not about a `directory`-sourced one). None of
this is filesystem settings, so `settingSources` does not gate it
(`sdk.d.ts`: `settingSources` "control[s] which filesystem settings to
load"; `query.applyFlagSettings()`/`options.settings` is a separate,
always-on "flag settings" layer). Run:
`runs/2026-09-26T123446908126Z-skills-dir-settings-plugin`. A marketplace
directory held one plugin entry, `{"name": "proof12-mp-plugin", "source":
"./the-plugin"}`, `the-plugin/skills/proof12-mp-skill-j/SKILL.md` inside it.
`query.applyFlagSettings({extraKnownMarketplaces: {...}, enabledPlugins:
{"proof12-mp-plugin@proof12-marketplace": true}})` followed by
`query.reloadPlugins()` both returned successfully, and the very next turn's
`skill_listing` (confirmed by timestamp against the immediately preceding
prompt) carried `proof12-mp-plugin:proof12-mp-skill-j`, namespaced the same
way a `plugins`-option skill is.

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

**`projectConfigRoot` and a raw `register_repo_root` control request show
the same negative.** `sdk.d.ts` describes `projectConfigRoot` as where "the
`.claude` config trees (commands, agents, skills, workflows, routines,
output-styles...) come from... instead of `cwd`"; run
`runs/2026-09-26T115221865227Z-skills-dir-project-config-root` still came
back `skillCount: 13`, no `proof12-projectroot-skill-d`.
`register_repo_root` (`SDKControlRegisterRepoRootRequest` in `sdk.d.ts`,
"Add a directory as a working-directory root and optionally reload
CLAUDE.md, skills, and plugins") has no method on the typed `Query`
interface the way `reloadSkills`/`reloadPlugins` do, but `sdk.mjs` shows
those two going through one generic `this.request({subtype: ...})`, so
`runs/2026-09-26T120626865280Z-skills-dir-register-repo-root-raw` called
`(run.query as any).request({subtype: 'register_repo_root', directory,
reload_skills: true})` directly. It is reachable: the CLI answered
`{"subtype":"success", "response":{"directory": "..."}}`. The skill under
that directory still never appeared in either turn's `skill_listing`. None
of these three runs isolates `settingSources` as the specific cause the way
the `agent-sdk/skills` quote does for `additionalDirectories` (no strace, no
positive control that flips only `settingSources`); the result is
consistent with the same gate, across three different ways of naming a
directory, not a proof that it is.

**`skills` (`Options.skills`) and `AgentDefinition.skills` load nothing;
both are filters over skills some other route already discovered.**
`sdk.d.ts` (~line 2251): "This is a context filter, not a sandbox: unlisted
skills are hidden from the model's listing and rejected by the Skill tool,
but their files remain on disk." `code.claude.com/docs/en/agent-sdk/skills`:
"Unlike subagents, which you can define in the `agents` option, you create
skills as files on disk. The SDK doesn't provide a programmatic API for
registering them." Not run: there is nothing to run, a filter with no
source has nothing to filter.

**Not run, doc-only, and why:**
- The managed `/etc/claude-code/.claude/skills/` directory: writing it
  changes Stephen's own machine-wide Claude Code config, not just this
  harness.
- `$CLAUDE_CONFIG_DIR/skills/`: the user settings source, the same
  filesystem-settings gate `additionalDirectories` and `projectConfigRoot`
  showed above.
- Restarting the process with `resume` to change the plugin list, rather
  than anything tried live in this proof: `code.claude.com/docs/en/agent-sdk/sessions`,
  "What a resumed session restores": "If the session depended on
  `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, or
  directories added with `--add-dir`, pass them again when you resume." A
  resumed session can be handed a new `plugins` list, at the cost of the
  process restarting; that is a different shape from any of the
  live-changed-directory results above, all of which kept one process
  running throughout.

### Choices this proof made that the brief did not

- Did the reading, the script-writing and the live runs directly in this
  turn rather than delegating them to sub-agents.
- Created the worktree with `git worktree add ... -b proof-12-skills-dir
  claude-code-harness` under `.claude/worktrees/`, matching the layout the
  other `proof-*` worktrees already on disk use.
- Put every scenario in one file, `proofs/skills-dir.mts`, dispatched by a
  second CLI argument, rather than one file per scenario.
- Model: `claude-haiku-4-5`, matching the smoke proof's own README example.
- The first plugin fixture has no `.claude-plugin/plugin.json` manifest, to
  test the cheaper, no-manifest shape rather than repeat the smoke proof's
  manifest-bearing one.
- Fixture directories live under `os.tmpdir()` via `mkdtempSync`, removed in
  a `finally`, matching the "`/tmp` cleared at boot" rule, except the
  `register-repo-root-raw` scenario's: `register_repo_root` requires a
  subdirectory of `cwd`, so that fixture lives under the harness's own
  persistent per-proof working directory instead and is removed in that
  scenario's own `finally`, not the shared one. The `/tmp` log files this
  session's own commands wrote were deleted once read, for the same
  `/tmp`-cleared-at-boot reason.
- The first plugin's directory is literally named `plugin`, which is why its
  fallback-namespaced skill reads `plugin:proof12-plugin-skill-a`; a
  differently-named directory would change the prefix's text, not whether
  there is one.
- A 3-second settle before a "no reload call" turn, and a timestamp check
  against the transcript rather than trusting that a name's absence from a
  later turn's `skill_listing` means it was never attached, before
  concluding a directory is not watched.
- Ran `register_repo_root` past its typed surface with
  `(query as any).request(...)`, an internal method with no public type or
  documentation, reached only because `reloadSkills`/`reloadPlugins` are
  themselves thin wrappers over it in `sdk.mjs`; this call has no
  compatibility guarantee and may stop working on any SDK update. The
  alternative, an approval flow through `canUseTool` that returns an
  `addDirectories` `PermissionUpdate`, is a different, more roundabout shape
  than "declare a directory in config" and was not tried.
- Left the managed and user-settings skills directories, and restarting
  with `resume`, doc-only rather than live; see the reasons given with each
  above.
