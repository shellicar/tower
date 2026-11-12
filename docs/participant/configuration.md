# Configuration

## The principle: no ambient configuration

- **What a session gets is controlled.** Nothing comes from config files at
  conventional paths or from the user's own Claude Code setup. There is no
  hot reload: to change something, send it over stdio.
- **Claude Code doesn't read `~/.claude` unless the user explicitly allows
  it.** The participant runs Claude Code with its own `CLAUDE_CONFIG_DIR` and
  `settingSources: []`, which blocks settings files and CLAUDE.md on every
  route tried ([proof 11](../participant-findings/proof-11-context.md)). The
  login is the one thing read from the real home on Linux (below).
- **Config is declared.** A default counts as undeclared config.
- **Defaults are accepted one setting at a time.** The Allowed to default
  list, below, holds the defaults that are accepted; anything not on it is
  undecided.
- **What changes the outcome is declared** (model, effort, thinking and the
  like); what doesn't is left to Claude Code.
- **Bridge is the reference** where it makes sense. Things not changed at
  runtime (such as config directories) may be environment variables;
  anything that can be changed at runtime goes over stdio. The process starts
  without configuration and refuses to serve until configured.

### Why no ambient configuration

A controlled session can be compared with another: A/B testing across
sessions needs every input known. Config read from files became a
maintenance burden in claude-sdk-cli. A default can be changed by any
update, at any time, invisibly, so a default is config nobody declared.
Hot reload isn't needed, because launching or changing a session can be done
remotely anyway.

## The three cases

1. **Nothing configured is an error.** The participant won't launch a
   conversation (or publish `ready`) until every required setting is set.
2. **The required settings, once configured, are passed through** to Claude
   Code as the baseline.
3. **`claudeSettings` on top overrides them.** If `claudeSettings` sets
   `permissions.defaultMode`, `model`, `effortLevel`, a per-model
   `effortLevel` or `env.CLAUDE_CODE_MAX_OUTPUT_TOKENS`, its value wins over
   the required one. Required means it has to be set, not that it beats
   Claude Code's own settings
   ([foundation probes](../participant-findings/foundation-probes.md)).

The required fields exist so that nothing is left to a default or to the
ambient environment. Beating Claude Code's settings is not their job.

## Environment variables

Read once at start. Each is required with no default, and a missing one (or a
relative path where a path is expected) stops the process at start with exit
66.

| Variable | What it is |
|---|---|
| `NATS_URL` | The broker. |
| `PARTICIPANT_WORLD` | The world served, fixed for the process. |
| `PARTICIPANT_DURABLE_BUCKET` | The deployment's durable object store bucket. |
| `PARTICIPANT_CONFIG_DIR` | The agent's Claude Code config dir, absolute; the participant's identity (see [shutdown.md](shutdown.md)). |
| `HOME` | The real home, absolute. |
| `PARTICIPANT_LOGIN_DIR` | macOS only: the participant's own login dir, absolute, with the config dir's permission checks. Ignored on Linux. |

`PATH` is searched for `setpriv`. The driving script `start.ts` may default
the world, bucket and login dir; the participant itself fails without them.

These variables are plumbing: they have no bearing on how Claude Code
behaves, and the no-ambient-config rule is about the model and the agent.
`NATS_URL` has no default because an unset one would otherwise reach the live
broker.

## What Claude Code inherits

- **Claude Code's configuration variables are stripped** from the environment
  Claude Code inherits: those that would change a required value (the model,
  effort, thinking, max tokens, the system prompt, the permission mode).
  Claude Code ranks some of them above its settings, so an inherited one
  would silently replace a declared value. The list is in
  `src/startup.ts`. A value set on purpose goes through `claudeSettings.env`,
  which still wins
  ([foundation probes](../participant-findings/foundation-probes.md)).
- **A parent Claude Code session's variables are stripped too,** so a
  participant started from inside a Claude Code session doesn't hand them on.
- Everything else passes through, including `NATS_URL` and the
  `PARTICIPANT_*` variables, which therefore reach the commands Claude Code
  runs. The `settings` reply hides `NATS_URL`, which can carry credentials.
- Stripped variables don't reach the commands Claude Code runs either.

## The login and the private HOME

- **The user's own Claude Code and the participant both keep working,** with
  one login per machine, kept separate from settings.
- **Each participant process gets a fresh private `HOME`** in the system temp
  dir, so Claude Code's housekeeping, caches and logs never touch the real
  home. Old private homes are left to the temp dir's own clean-up.
  `CLAUDE_CODE_SHELL_PREFIX` gives Bash, hooks and stdio MCP servers the real
  `HOME` back ([proof 26](../participant-findings/proof-26-home.md)).
- **Known gaps of the private HOME:** Claude Code's Read and Write tools
  resolve `~` to the private home; the shell snapshot sources no rc files;
  Claude Code's git reads the private `.gitconfig`.
- **On Linux** the login stays in the real `~/.claude`, reached with an
  absolute `CLAUDE_SECURESTORAGE_CONFIG_DIR`, under one refresh lock shared
  with the user's own Claude Code. The variable is undocumented, and a
  `/logout` on the participant's side logs the user out everywhere.
- **On macOS** Claude Code keeps the login in the Keychain through
  `/usr/bin/security`, which finds no keychain under a private `HOME`. So:
  - `CLAUDE_SECURESTORAGE_CONFIG_DIR` is `PARTICIPANT_LOGIN_DIR`, one per
    machine and shared by every world. Its hash names the participant's own
    Keychain entry and refresh lock, separate from the user's own Claude Code
    and from bridge.
  - A `security` shim (`bin/real-home-security/security`), first on Claude
    Code's `PATH`, runs `/usr/bin/security` with the real `HOME`.
  - `pnpm claude-login` (`scripts/login.ts`) logs that entry in once, by
    running the SDK's own Claude Code as `auth login`.
  - `start.ts` defaults the login dir to
    `${XDG_DATA_HOME:-~/.local/share}/tower/login`; an optional `.env` in
    the app directory, or the environment, overrides it.
  ([macOS keychain research](../participant-findings/macos-keychain.md).)

The private HOME isn't about stopping the model reading the home. It keeps
the SDK and Claude Code from doing unwanted things there: a retention
clean-up in Claude Code is hard-coded to real-home paths.

## Control lines

The process reads JSON control lines on stdin and answers each with one JSON
line on stdout, in order, so a driver can pair replies with lines. Diagnostics
go to stderr only.

| Line | What it sets |
|---|---|
| `model` | `name`, `maxTokens`, `thinking`, `thinkingDisplay`, `effort`. Merges: sets the fields it names. |
| `system` | `{preset, text?}`: whether Claude Code's `claude_code` preset is sent, and optional own text after it or on its own. `preset` is required. |
| `permissionMode` | The permission mode. |
| `context` | Text added to the first user message of each conversation; `null` clears it. |
| `claudeSettings` | Claude Code's own settings.json shape, applied over the baseline. Replaces the whole value, arrays included; `null` clears it. To patch, read `settings`, merge, send the result. Provisional: replacing rather than merging. |
| `shutdownPolicy` | `gracefulMs` and `teardownMs`, both required, replaced together (see [shutdown.md](shutdown.md)). |
| `settings` | `{}` reads back everything the participant holds, with what's still missing. |

- **Strict validation, with zod.** A stray or misspelt key is refused.
- **No control line leaves a required value unset.** Refused, each with a
  test:
  - `null` on any required field: the `model` line's fields, `system`,
    `permissionMode`;
  - a `system` line without `preset` (text only);
  - `null` on the `claudeSettings` keys the participant acts on (`model`,
    `effortLevel`, `alwaysThinkingEnabled`, `permissions`,
    `permissions.defaultMode`);
  - a model name, on the `model` line or as `claudeSettings.model`, that is
    empty, only whitespace, or has leading or trailing whitespace. It is
    refused, not trimmed.

  `null` for the whole `claudeSettings` line clears it and leaves every
  required value set.
- **`claudeSettings` is checked only on the keys the participant acts on**
  (`model`, `effortLevel`, `alwaysThinkingEnabled`,
  `permissions.defaultMode`); everything else passes through as sent.
  Undecided: whether only those keys are checked.
- **One key per line:** a line carrying more than one key is refused whole.
  Undecided: whether a line may carry more than one key.
- **A blank line is answered `{"error":"unparseable"}`,** so every line gets a
  reply. Undecided: the reply to a blank line.
- **Pinned per conversation:** tools and the system prompt are fixed for a
  conversation's life. A changed setting applies to conversations launched
  after it.

Invalid config silently accepted is confusing rather than helpful, so
validation is strict. A trimmed model name isn't the one that was sent, so it
is refused rather than trimmed. Tools and the system prompt are pinned
because changing them changes the cache prefix, which is costly, and Claude
Code only takes them at start anyway
([proof 4](../participant-findings/proof-04-live-changes.md)).

## The required settings

- **Model:** required.
- **Max tokens:** required. Passed as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the only
  route. The SDK never reports the value actually sent, a value above the
  model's limit is capped silently, and an account experiment can move a
  model's default. No value is checked against a model's cap
  ([proof 6](../participant-findings/proof-06-max-tokens.md)).
- **Thinking:** `adaptive` or `disabled` only. The display (`summarized` or
  `omitted`) is required even when thinking is disabled. With no display
  declared Claude Code asks for `updates`, which returns no summary, so the
  display is passed explicitly (`extraArgs: {'thinking-display'}`). Claude
  Code substitutes the right shape per model (a budget on Haiku 4.5) without
  saying so. `alwaysThinkingEnabled: true` in `claudeSettings` turns thinking
  on even over a declared `disabled`.
- **Effort:** required. An account flag can move Claude Code's default; a
  declared value outranks it.
- **System prompt:** required: `preset` true or false, with optional `text`.
  Claude Code's preset is one of the choices. The SDK's one-line identity
  sentence isn't part of the config. If more presets appear, `preset` can
  become the preset's name.
- **Permission mode:** required. Other `permissions` are optional. The mode
  goes into the settings object merged with whatever `permissions`
  `claudeSettings` carries, and also as a launch option, because settings
  alone never apply it. `auto` is accepted at start and live
  ([proof 10](../participant-findings/proof-10-directories-permissions.md)).

A fixed thinking budget is deprecated and gives worse thinking, so only
`adaptive` and `disabled` are accepted. Checking max tokens against each
model's cap would need a hand-kept table, which goes stale silently, the same
failure as ambient config.

## Other settings

- **Account connectors are off by default:** the baseline sets Claude Code's
  `disableClaudeAiConnectors: true`, and `claudeSettings` can turn them back
  on. It is the setting, not the environment variable, so that a setting can
  re-enable them ([proof 18](../participant-findings/proof-18-connectors.md)).
- **Claude Code's sandbox** is set through `claudeSettings`
  (`sandbox.enabled`, `autoAllowBashIfSandboxed`). Undecided: whether the
  sandbox becomes a setting of its own; that depends on whether the SDK can
  say if it is active. If it can't start, Claude Code warns on stderr and
  runs Bash unsandboxed; `getSandboxDialog().enabled` (an internal SDK
  method) is the only running signal found
  ([sandbox under the SDK](../participant-findings/sandbox-under-sdk.md)).
- **Approvals:** Claude Code runs with `permissionPrompts: 'none'`, so whatever
  the mode, rules and hooks don't allow is denied (see
  [approvals.md](approvals.md)).
- **Allowed to default** (Claude Code's own value is accepted): switching
  model on a flagged request, tools and MCP, prompt-cache lifetime (cost
  only), the advisor tool (settable through `claudeSettings.advisorModel`),
  the session title (a separate Haiku call that never feeds back), the
  token-count reminder, the attribution header, tool-entry details, fast
  mode, temperature, context management, betas, output format
  ([defaults survey](../participant-findings/defaults-survey.md)).
- **Per-model overrides (agreed, not built, not in v0):** the `model` line's
  values are the default, plus an optional `overrides` map keyed by exact
  model or by family (a family is a name like `claude-haiku` or
  `claude-opus`, as distinct from each version), for example
  `"overrides": {"claude-haiku-4-5": {"maxTokens": 64000}}`. Each field
  resolves to the exact model's override, then the family's, then the
  default, and never to Claude Code's own default. The participant serves one
  model per conversation, so the override for that model applies.
- **Today** there is no `overrides` map: `ConversationLauncher.ts` sets
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from `model.maxTokens`, one value for the
  whole process.
- **`modelSettings`** is Claude Code's own per-model setting, mainly effort
  (for example `{"modelSettings": {"claude-opus-5-5": {"effortLevel":
  "high"}}}`). It passes through `claudeSettings` unchanged, and it has
  nothing for max tokens: Claude Code's max tokens is one flat value.

Max tokens is required because Claude Code's default varies silently: an
account experiment raised Sonnet's from 64,000 to 128,000, and only after a
start-up fetch had returned. One required value covers every model the
process serves until the `overrides` map is built.

## Bridge's control lines, for this participant

- **`context`:** as bridge; the text arrives verbatim in the first user
  message ([proof 11](../participant-findings/proof-11-context.md)).
- **`cwd`:** none. There is no default cwd; every `service` carries one.
- **`chdir`:** answered `unsupported`; it comes after the MVP (see
  [presence.md](presence.md)).
- **`retry`:** none. Claude Code's own retry behaviour is accepted until a
  real problem shows. Known from Claude Code's docs, not tested: only
  `CLAUDE_CODE_MAX_RETRIES` and `CLAUDE_CODE_RETRY_WATCHDOG` are settable,
  with no delay or total-wait setting, so a maximum wait would have to be
  enforced from `api_retry` messages.
- **`credentials`:** tool credentials (not the Claude login); not needed now.
- **`tools`:** needed later, to control tool config and which tools are
  enabled.
- **`skills`:** see [skills.md](skills.md).
- **`revise`:** not needed.

## Open

- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`** still passes through. Read from
  Claude Code's binary: it scrubs the environment of the commands Claude Code
  runs and isolates them with bubblewrap, and turning it off loses that
  subprocess isolation. Claude Code turns it on by itself when
  `GITHUB_ACTIONS` is set, unless it is explicitly off. The binary also
  states that it forces the permission mode to `default` ("Permission mode
  forced to default", naming `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` as set); read
  from the binary, not run. Strip it, keep it, or refuse loudly.
  (`src/startup.ts`, marked.)
- Whether variables that change a required value only indirectly belong on
  the strip list (`CLAUDE_CODE_MODEL_CATALOG` and `_URL`,
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`). `CLAUDE_CODE_FORK_SUBAGENT` also
  passes through.
- **The permission mode as a launch option** beats
  `claudeSettings.permissions.disableAutoMode`. (`src/ConversationLauncher.ts`,
  marked.)
- **Effort `max`:** Claude Code's settings can't carry it at any level (they
  drop it silently), so a declared `max` goes as a launch option and then
  beats every effort `claudeSettings` sets. (`src/ConversationLauncher.ts`,
  marked.)
- `thinkingDisplay: omitted` is accepted, though Claude Code turns an explicit
  `omitted` into `updates`.
- `bypassPermissions` is accepted as a mode, while the SDK gates it behind
  `allowDangerouslySkipPermissions`, which the participant never sets.
- Undecided: `syncClaudeAiSkills`. Left at Claude Code's default for now.
- Undecided: `systemPrompt.snapshot`. Left at the SDK default for now (Claude
  Code records the prompt once per conversation).
- Undecided: what `preset: false` with no `text` sends. It sends
  `systemPrompt: ''` for now, untested live.
- Undecided, each built one way for now: the `system` reply is always `set`;
  an empty `{"model":{}}` is accepted; the `settings` line refuses bridge's
  `include`.
