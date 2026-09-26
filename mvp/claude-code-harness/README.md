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
`plugin-edit-existing`, `register-repo-root-raw`, `settings-plugin`,
`settings-plugin-live`. Ground truth for "did the
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

Doc-only, not tried: both plugin routes load more than skills from the same
root. `code.claude.com/docs/en/agent-sdk/plugins`: "A plugin can include:
Skills... Agents... Hooks: event handlers... MCP servers." `SdkPluginConfig`
has a `skipMcpDiscovery` field to opt a plugin's `.mcp.json` out, and no
equivalent for hooks; the settings-declared marketplace route showed no
such option at all in this proof's own runs. A directory declared only to
supply skills, through either route, also supplies whatever hooks, agents,
commands and MCP servers happen to sit next to those skills in the same
root, and hooks run commands.

**An `Options.plugins` entry's own path is fixed once the process starts;
nothing in the SDK re-points it to a different directory, but content
inside that fixed path can be rescanned on an explicit call, and a
filesystem-level indirection (the path's `skills/` entry as a symlink) turns
that rescan into a genuine re-point.** (A second finding below, on the
settings-declared marketplace route, also found that re-pointing an
already-adopted directory in place did not work there, by a different
test; that route can still add a plugin that was not there at all when the
process started, which `Options.plugins` cannot, and the symlink
indirection tried here was not tried on that route.) `Query` has no method that takes a plugin path: `reloadPlugins()` takes only
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
local path, at launch or mid-session, entirely through `settingSources: []`,
namespaced the same way as the `plugins` option, with an edit to its skill
picked up the same way too; but re-pointing an already-adopted one to a
different directory did not work.** `extraKnownMarketplaces` accepts a
marketplace whose own source is a local directory
(`code.claude.com/docs/en/settings-reference`: `"directory": { "source":
"directory", "path": "/opt/acme-corp/approved-marketplaces" }`, "path
required, the absolute path to a directory containing
`.claude-plugin/marketplace.json`"), and that marketplace's own plugin
entries can use a relative-path source inside it
(`code.claude.com/docs/en/plugins/marketplace-reference`, fetched live for
this proof, "Relative path plugin source": "A relative path resolves only
when Claude Code has the marketplace's files, so check the marketplace
source type: `github`, `git`, `file`, and `directory`: Claude Code has the
marketplace's files"; a different sentence on the same page, "`settings`:
relative paths are rejected outright", is about a marketplace whose own
source is `settings`, the inline-plugin-list form, not about a
`directory`-sourced one). None of this is filesystem settings, so
`settingSources` does not gate it (`sdk.d.ts`: `settingSources` "control[s]
which filesystem settings to load"; `query.applyFlagSettings()` and
`options.settings` are, per the same file, the same "inline `settings`
option of `query()`", one applied at launch and the other mid-session, and
neither is filesystem settings).

Two runs. `runs/2026-09-26T123446908126Z-skills-dir-settings-plugin`: a
marketplace directory held one plugin entry, `{"name": "proof12-mp-plugin",
"source": "./the-plugin"}`, `the-plugin/skills/proof12-mp-skill-j/SKILL.md`
inside it (the entry's `name` and the plugin directory's own name,
`the-plugin`, deliberately differ here). `query.applyFlagSettings({...})`
followed by `query.reloadPlugins()` both returned successfully mid-session,
and the very next turn's `skill_listing` (confirmed by timestamp) carried
`proof12-mp-plugin:proof12-mp-skill-j`: the prefix is the marketplace
entry's `name`, not the plugin directory's, so the prefix's text can be
chosen independently of the directory layout, though a plugin loaded this
way is still always namespaced, the same as `Options.plugins`.
`runs/2026-09-26T125133520695Z-skills-dir-settings-plugin-live` declared the
marketplace in `options.settings` at launch instead (the literal
"declared in config" form), then: edited the skill's description
mid-session (a `MARKER=V1`/`MARKER=V2` marker, as in the plugin
`skills/`-directory edit test above); the turn sent three seconds later,
no reload call, still carried `V1`, and `query.reloadSkills()` alone (no
`reloadPlugins()` needed) picked up `V2` on the next turn, the same result
as the direct `plugins`-option route. It then tried re-pointing the same
already-adopted marketplace at a second, unrelated directory (a different
skill, no relation to the first) via a second `query.applyFlagSettings()`
naming the new `path`, followed by `query.reloadPlugins()`. That reload's
own response still reported the plugin's path as the first directory
(`{"name":"proof12-live-plugin","path":".../marketplace-a/the-plugin",
...}`), and the following turn's `skill_listing`, checked by timestamp,
still carried only the first skill; the second one never appeared. Once
adopted under a given marketplace name, this route did not let the proof
change what directory that marketplace pointed at; `runs/...-settings-plugin`'s
own result (registering a marketplace and plugin that were not there
before) is adding new content mid-session, not changing existing content's
source, and only the first was shown to work.

Cost, relative to `Options.plugins`: that option's skill sits at
`<plugin-root>/skills/<name>/SKILL.md`; this route's sits one level deeper,
at `<marketplace-root>/<plugin-dir>/skills/<name>/SKILL.md`, plus
`.claude-plugin/marketplace.json` beside the plugin directory naming it by
a relative path, plus the settings/`enabledPlugins` declaration itself.
Doc-only, not tried: the marketplace-reference page's plugin-source table
says a relative-path entry of `"."` on its own means the marketplace root
itself, which would make the marketplace root and the plugin root the same
directory and remove that one extra level, leaving only the manifest file
as the added cost.

Safety check before relying on either result: `grep -rl proof12
~/.claude/plugins ~/.claude/settings.json ~/.claude.json` and `find
~/.claude -iname '*proof12*'`, run against Stephen's own, real `~/.claude`
(the harness's shared-login credential store; every run's settings and
plugin state go into its own `CLAUDE_CONFIG_DIR` instead, per the harness's
own isolation design above), found nothing from either run: registering the
marketplace and enabling the plugin did not write into Stephen's own Claude
Code configuration. Inside each run's own copied `config-dir`, the two
delivery mechanisms differ: `settings-plugin`'s mid-session
`applyFlagSettings()` left no `plugins/` directory, no marketplace file, and
no mention in `.claude.json`, so that layer appears to be in-memory for the
session only. `settings-plugin-live`'s launch-time `options.settings` did
persist state there: `config-dir/plugins/known_marketplaces.json` records
`{"proof12-live-marketplace": {"source": {"source": "directory", "path":
".../marketplace-a"}, "installLocation": ".../marketplace-a", ...}}`, and
`.claude.json` gained a `pluginUsage` key,
`proof12-live-plugin@proof12-live-marketplace`. Both are confined to that
run's own `CLAUDE_CONFIG_DIR`, both name the pre-re-point directory
(`marketplace-a`) even after the re-point attempt, matching the live
result above, and neither reaches `~/.claude`.

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
  than anything tried live in this proof: `code.claude.com/docs/en/sessions`
  ("Manage sessions"), "What a resumed session restores": "If the session
  depended on `--mcp-config`, `--settings`, `--plugin-dir`,
  `--fallback-model`, or directories added with `--add-dir`, pass them again
  when you resume." A resumed session can be handed a new `plugins` list, at
  the cost of the process restarting; that is a different shape from any of
  the live-changed-directory results above, all of which kept one process
  running throughout.
- The `canUseTool`-approval path to `register_repo_root`'s `addDirectories`
  `PermissionUpdate`: a different, more roundabout shape than "declare a
  directory in config" (see the choices below).
- A swap, rather than a re-point, on the settings-declared marketplace
  route: register directory B under a new marketplace name (same plugin
  entry `name` as A's), set A's plugin to `false` in `enabledPlugins`, call
  `reloadPlugins()`, and check by timestamp whether A's skill is gone and
  B's is present under the same namespace prefix. This is the untested
  variant that could still show the directory changing after the process
  starts, on this route, without keeping the same marketplace name; left
  untested for time, not because it looked unlikely to work.

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
- Chose the marketplace and plugin entry names in the settings scenarios
  (`proof12-marketplace`, `proof12-mp-plugin`, `proof12-live-marketplace`,
  `proof12-live-plugin`), and deliberately gave the plugin entry a
  different name from its own directory (`the-plugin`) in the first one, to
  tell which one the namespace prefix follows.
- The first settings run (`settings-plugin`) declared the marketplace
  mid-session with `query.applyFlagSettings()`; the second
  (`settings-plugin-live`) declared it in `options.settings` at launch
  instead, the literal "declared in config" form, then used
  `applyFlagSettings()` only for the re-point attempt.
- Fetched `code.claude.com/docs/en/plugins/marketplace-reference` live with
  `WebFetch` partway through this proof, rather than relying on the
  `extraKnownMarketplaces` shapes already in the scratchpad's settings-reference
  copy, once those turned out to leave the plugin-entry source shapes
  (relative paths inside a `directory`-sourced marketplace) unstated.
- The settings-scenario fixtures live under `/tmp` too, covered by the
  fixture-cleanup line above; the safety check against Stephen's own
  `~/.claude` (not a fixture, and not covered by that line) was run once,
  by hand, after both settings runs.

## Proof 19: skills from config-declared directories, without a prefix

The question: which routes load skills from a directory the participant's
config names, listed and invoked by their plain names (`p19-a1`, not
`x:p19-a1`), settable and re-pointable live, and loading nothing but skills.
Proof 12 covered the plugin routes (always prefixed); this one covers the
routes it left untested.

`proofs/skills-plain.mts <model> <scenario>` runs one route per process.
`proofs/private-etc.sh <command>` runs a command with a private `/etc` (user
and mount namespace, `/etc` overlaid with a throwaway upper directory, then
back to the caller's own uid); the `managed` scenario refuses to run without
it. The real `/etc/claude-code` does not exist before or after.

Every scenario uses the same fixtures. Declared directory A holds `p19-a1`,
`p19-hooked` (a skill whose frontmatter carries a `PostToolUse` hook), and
sentinels: `agents/`, `commands/`, `hooks/hooks.json`, `settings.json`,
`.mcp.json`, `CLAUDE.md` and a plugin-shaped entry `p19-pluginshaped/`
(`.claude-plugin/plugin.json`, a `skills/` child, the same sentinels).
Declared directory B holds `p19-b1`. The live sequence is:

1. list
2. invoke `/p19-hooked` by its bare name
3. add `p19-a2`, wait 8 s, list
4. edit `p19-a1`'s description, wait 8 s, list
5. re-point to B, wait 8 s, list
6. invoke `/p19-a1`, which exists only in A
7. `reloadSkills()`, list

Each run directory also holds:

- `debug.log`: the loader's "Loading skills from" and "Loaded N unique skills
  (managed: X, user: Y, ...)" lines, and the watcher's lines
- `api-bodies/`: every request body, searched for the sentinel markers
- `proof-stdout.txt`: the proof's own output, including `get_hooks_listing`
  and `list_permission_rules`
- `run.strace`: some runs only

Ground truth for names is the transcript's `skill_listing`. It is a delta:
after the first turn only changed skills are attached, and
`isInitial: true` marks a full list.

Opening a setting source is done in the proof, with
`extraArgs: {'setting-sources': ...}`. The CLI receives `--setting-sources=`
from the SDK and then the proof's flag, and the last one wins
(`claude/1/argv.json`). `run.json` still records `settingSources: []` for
those runs.

Sources in the 2.1.282 binary (minified names):

- `L$o`, the skill loader:
  - managed `<Ik()>/.claude/skills` loads as policySettings, with no
    settingSources gate, only `CLAUDE_CODE_DISABLE_POLICY_SKILLS`
  - user `<CLAUDE_CONFIG_DIR>/skills` is gated by `userSettings`
  - `--add-dir` and project dirs are gated by `projectSettings`
  - `--bare` reads only add-dirs, and only when `projectSettings` is on
- `X()`, the watcher: user, project and add-dir skill directories, if they
  exist when it starts. Not the managed one.
- `H5e`: adopts plugin-shaped entries of skill directories as plugins.
- `Ph()`/`HDr()`: the managed path. `HDr()` is a stub in this build, so
  nothing relocates it.

### Runs

| Scenario | Run |
| --- | --- |
| user-closed | `runs/2026-09-26T163003288077Z-skills-plain-user-closed` |
| user-open | `runs/2026-09-26T164112434281Z-skills-plain-user-open` |
| user-open-late | `runs/2026-09-26T163047630042Z-skills-plain-user-open-late` |
| user-open-links | `runs/2026-09-26T162826834004Z-skills-plain-user-open-links` |
| user-open-nosync | `runs/2026-09-26T163149619533Z-skills-plain-user-open-nosync` |
| managed | `runs/2026-09-26T164308135474Z-skills-plain-managed` |
| project-adddir | `runs/2026-09-26T164152394485Z-skills-plain-project-adddir` |
| project-config-root-open | `runs/2026-09-26T164021917994Z-skills-plain-project-config-root-open` |
| register-root-open | `runs/2026-09-26T164244797727Z-skills-plain-register-root-open` |
| canusetool-closed | `runs/2026-09-26T163355342755Z-skills-plain-canusetool-closed` |
| canusetool-open | `runs/2026-09-26T163503903272Z-skills-plain-canusetool-open` |
| bare-adddir | `runs/2026-09-26T163435067429Z-skills-plain-bare-adddir` |
| bare-adddir-closed | `runs/2026-09-26T163543082345Z-skills-plain-bare-adddir-closed` |

Earlier runs of the same scenarios, from before the removed-skill and
plugin-shaped checks were added, are kept alongside.

### Findings

**User skills directory (`<CLAUDE_CONFIG_DIR>/skills` as a symlink to the
declared directory, `userSettings` opened).**

- Under `settingSources: []` nothing loads (user-closed:
  `user: 0`, even after `reloadSkills()`).
- Opened, the names are plain, and `/p19-hooked` dispatched by its bare name.
- The watcher picked up each of these with no reload call:
  - a new skill
  - an edited description
  - a swapped symlink
- After the swap, `/p19-a1` was not dispatched. The listing only ever
  announced `p19-b1` as an addition; the full list came back only after
  `reloadSkills()`.
- Declaring the directory after start doesn't use the watcher.
  - Claude Code had already created `<CLAUDE_CONFIG_DIR>/skills/` itself,
    for `synced/`, so the proof linked skills into it.
  - Those links needed `reloadSkills()`, and later edits there were not
    picked up (user-open-late).
- Several declared directories work through per-skill symlinks in a real
  `skills/`. Adding and removing links were picked up live
  (user-open-links).
- Costs:
  - Opening `userSettings` loads the config directory's `CLAUDE.md`,
    `rules/`, `agents/`, `commands/` and `settings.json`, including its hooks
    and permission rules. All six sentinels showed up.
  - Claude Code's claude.ai skills sync wrote `synced/` into declared
    directory B, through the symlink. `syncClaudeAiSkills: false` in
    `options.settings` stopped that, and the account's skills stopped
    appearing (user-open-nosync).
  - `synced` is a reserved skill name.
  - The plugin-shaped entry was adopted as a plugin:
    - its skill was listed prefixed, `p19-pluginshaped:p19-inner`
    - its agent, command and MCP server loaded
    - its `hooks.json` hook ran
  - The declared directory's own top-level `agents/`, `commands/`, hooks,
    `.mcp.json` and `CLAUDE.md` did not load.

**Managed skills directory (`/etc/claude-code/.claude/skills`, private
`/etc`).**

- Loads under `settingSources: []` untouched (`managed: 2`), with plain names
  and bare-name dispatch.
- Not watched. With no reload call:
  - a new skill, an edit and a re-point never reached the listing
  - `/p19-a1` still dispatched after its directory was swapped away
  - after a body-only edit, `/p19-b1` injected the old body (`BODY-MARKER-V2`
    appears nowhere in the transcript)
- Every `reloadSkills()` attached another full listing (`isInitial: true`),
  even with nothing changed.
- No sentinel loaded, and the plugin-shaped entry was not adopted.
- In production the path is machine-wide and root-owned, so every Claude
  Code on the machine sees these skills. It is not per-process.

**`--add-dir` (`additionalDirectories` of a wrapper whose `.claude/skills`
links to the declared directory, `projectSettings` opened).**

- Plain names, bare-name dispatch.
- Watched: a new skill, an edit and a re-point were picked up with no
  reload, and `/p19-a1` was not dispatched after the swap.
- No sentinel loaded, and the plugin-shaped entry was not adopted.
- `projectConfigRoot` set to an empty directory kept the cwd's
  `.claude/skills` probe and `.claude/settings.json` (hook, permission rule)
  out.
- Cost: the wrapper becomes a working directory (`workspaceDirectories`,
  source `cliArg`), which grants file-tool access to it.

**`projectConfigRoot` as the source (`<root>/.claude/skills` linking to the
declared directory, `projectSettings` opened).**

- Same results as `--add-dir`: plain names, watched, removal effective on
  dispatch, no sentinel loaded, plugin-shaped entry not adopted.
- No `workspaceDirectories` entry.
- The loader walked up from the root and found only that one directory
  (`project=[.../pcr/.claude/skills]`).

**`register_repo_root`** (internal control request, `projectSettings`
opened, the registered directory a child of a launch `--add-dir`):

- Loads the child's `.claude/skills` on the next turn, with plain names.
- New skills and a re-point were then watched.
- Proof 12 found it loads nothing under `[]`.

**canUseTool `addDirectories`** (destination `session`):

- The directory was added (`workspaceDirectories`, source `session`).
- No skill loaded from it, with `projectSettings` opened or not, even after
  `reloadSkills()`.

**`--bare`:**

- With `projectSettings` opened it loaded the add-dir skills, plain names in
  `init` and in `reloadSkills()`.
- No turn ran ("Not logged in"), so there is no `skill_listing`. The shared
  login is not used in bare mode.
- Under `[]`: "[reduced mode] Skipping skill dir discovery".

**Every route:** `p19-hooked`'s frontmatter hook was registered as a session
hook when the skill was invoked, and it ran. No route keeps a skill's own
hooks out.

`project-*`, `register-root-open` and `bare-adddir` set
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`. With `projectSettings` open, the
CLAUDE.md ancestor walk would otherwise read above cwd, up through `$HOME`.
The strace of those runs shows the same `~/.claude` accesses as the
`[]`-only canusetool-closed run: `.credentials.json` and `state/`, from the
shared login.
