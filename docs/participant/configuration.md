# Configuration

## The principle: no ambient configuration

- **What a session gets is controlled.** Nothing comes from config files at
  conventional paths or from the user's own Claude Code setup. That makes A/B
  testing across sessions possible, avoids the maintenance burden config
  became in claude-sdk-cli, and removes hot reload: to change something, send
  it over stdio. Launching or changing a session can be done remotely anyway.
- **Claude Code doesn't read `~/.claude` unless the user explicitly allows
  it.** The participant runs Claude Code with its own `CLAUDE_CONFIG_DIR` and
  `settingSources: []`, which blocks settings files and CLAUDE.md on every
  route tried ([proof 11](../participant-findings/proof-11-context.md)). The
  login is the one thing read from the real home on Linux (below).
- **Config is declared, and a default counts as undeclared config:** a default
  can be changed by any update, at any time, invisibly.
- **Accepting a default is allowed, one setting at a time, as Stephen's
  decision.**
- **Declare what changes the outcome** (model, effort, thinking and the
  like); leave to Claude Code what doesn't.
- **Bridge is the reference** where it makes sense. Things not changed at
  runtime (such as config directories) may be environment variables;
  anything that can be changed at runtime goes over stdio. The process starts
  without configuration and refuses to serve until configured.

## The three cases

1. **Nothing configured is an error.** The participant won't launch a
   conversation (or publish `ready`) until every required setting is set.
2. **The required settings, once configured, are passed through** to Claude
   Code as the baseline.
3. **`claudeSettings` on top overrides them.** That is intended: if
   `claudeSettings` sets `permissions.defaultMode`, `model`, `effortLevel`, a
   per-model `effortLevel` or `env.CLAUDE_CODE_MAX_OUTPUT_TOKENS`, its value
   wins over the required one. Required means it has to be set, not that it
   beats Claude Code's own settings. The point of required fields is that
   nothing is left to a default or to the ambient environment
   ([foundation probes](../participant-findings/foundation-probes.md)).

## Environment variables

Read once at start. Each is required with no default, and a missing one (or a
relative path where a path is expected) stops the process at start with exit
66. They are plumbing: they have no bearing on how Claude Code behaves, and
the no-ambient-config rule is about the model and the agent.

| Variable | What it is |
|---|---|
| `NATS_URL` | The broker. No default: a default that pointed at the live broker is what caused trouble before. |
| `PARTICIPANT_WORLD` | The world served, fixed for the process so it can't switch worlds. |
| `PARTICIPANT_DURABLE_BUCKET` | The deployment's durable object store bucket. |
| `PARTICIPANT_CONFIG_DIR` | The agent's Claude Code config dir, absolute; the participant's identity (see [shutdown.md](shutdown.md)). |
| `HOME` | The real home, absolute. |
| `PARTICIPANT_LOGIN_DIR` | macOS only: the participant's own login dir, absolute. Ignored on Linux. |

`PATH` is searched for `setpriv`. The driving script `start.ts` may default
the world, bucket and login dir for convenience; the participant itself must
fail without them.

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
  runs. The `settings` reply hides `NATS_URL` because it can carry
  credentials.
- Side effect: stripped variables no longer reach the commands Claude Code
  runs either.

## The login and the private HOME

- **Stephen's own Claude Code and the participant both keep working,** with
  one login per machine, kept separate from settings.
- **Each participant process gets a fresh private `HOME`** in the system temp
  dir, so Claude Code's housekeeping, caches and logs never touch the real
  home. It isn't about stopping the model reading the home; it is about the
  SDK and Claude Code doing unwanted things there (a retention clean-up is
  hard-coded to real-home paths). There's no clean-up of old private homes;
  the temp dir takes care of that. `CLAUDE_CODE_SHELL_PREFIX` gives Bash,
  hooks and stdio MCP servers the real `HOME` back
  ([proof 26](../participant-findings/proof-26-home.md)).
- **Known gaps of the private HOME:** Claude Code's Read and Write tools
  resolve `~` to the private home; the shell snapshot sources no rc files;
  Claude Code's git reads the private `.gitconfig`.
- **On Linux** the login stays in the real `~/.claude`, reached with an
  absolute `CLAUDE_SECURESTORAGE_CONFIG_DIR`, under one refresh lock shared
  with Stephen's own Claude Code. The variable is undocumented, and a
  `/logout` on the participant's side logs Stephen out everywhere.
- **On macOS** Claude Code keeps the login in the Keychain through
  `/usr/bin/security`, which finds no keychain under a private `HOME`. So:
  - `CLAUDE_SECURESTORAGE_CONFIG_DIR` is `PARTICIPANT_LOGIN_DIR`, one per
    machine and shared by every world. Its hash names the participant's own
    Keychain entry and refresh lock, separate from Stephen's Claude Code and
    from bridge.
  - A `security` shim (`bin/real-home-security/security`), first on Claude
    Code's `PATH`, runs `/usr/bin/security` with the real `HOME`.
  - `pnpm claude-login` (`scripts/login.ts`) logs that entry in once, by
    running the SDK's own Claude Code as `auth login`.
  - `start.ts` defaults the login dir to
    `${XDG_DATA_HOME:-~/.local/share}/tower/login`; an optional `.env` in
    the app directory, or the environment, overrides it.
  ([macOS keychain research](../participant-findings/macos-keychain.md).)

## Control lines

The process reads JSON control lines on stdin and answers each with one JSON
line on stdout, in order, so a driver can pair replies with lines. Diagnostics
go to stderr only.

| Line | What it sets |
|---|---|
| `model` | `name`, `maxTokens`, `thinking`, `thinkingDisplay`, `effort`. Merges: sets the fields it names. |
| `system` | `{preset, text?}`: whether Claude Code's `claude_code` preset is sent, and optional own text after it or on its own. |
| `permissionMode` | The permission mode. |
| `context` | Text added to the first user message of each conversation; `null` clears it. |
| `claudeSettings` | Claude Code's own settings.json shape, applied over the baseline. Replaces the whole value, arrays included; `null` clears it. To patch, read `settings`, merge, send the result. |
| `shutdownPolicy` | `gracefulMs` and `teardownMs`, both required, replaced together (see [shutdown.md](shutdown.md)). |
| `settings` | `{}` reads back everything the participant holds, with what's still missing. |

- **Strict validation, with zod:** invalid config silently accepted is
  confusing rather than helpful. A stray or misspelt key is refused.
- **`claudeSettings` is checked only on the keys the participant acts on**
  (`model`, `effortLevel`, `alwaysThinkingEnabled`,
  `permissions.defaultMode`); everything else passes through as sent. Open:
  this rests only on a brief being sent.
- **One key per line:** a line carrying more than one key is refused whole.
  Open: this rests only on a brief being sent.
- **A blank line is answered `{"error":"unparseable"}`,** so every line gets a
  reply. Open: this rests only on a brief being sent.
- **No control line may leave a required value unset.** `null` is refused on
  every required field (the `model` line's fields, `system`,
  `permissionMode`). Tests that cover every line for this are on the unmerged
  branch `fix/required-settings-resolved`.
- **A model name that is only whitespace, or has leading or trailing
  whitespace, is rejected, not trimmed.** Built on the unmerged branch
  `fix/required-settings-review-fixes`; at HEAD such a name is accepted.
- **Pinned per conversation:** tools and the system prompt are fixed for a
  conversation's life (changing them changes the cache prefix, which is
  costly; Claude Code only takes them at start anyway,
  [proof 4](../participant-findings/proof-04-live-changes.md)). A changed
  setting applies to conversations launched after it.

## The required settings

- **Model:** required.
- **Max tokens:** required. Passed as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the only
  route. The SDK never reports the value actually sent, a value above the
  model's limit is capped silently, and an account experiment can move a
  model's default. Checking a value against each model's cap would need a
  hand-kept table that goes stale silently, so there isn't one
  ([proof 6](../participant-findings/proof-06-max-tokens.md)).
- **Thinking:** `adaptive` or `disabled` only. A fixed thinking budget is
  deprecated and gives worse thinking. The display (`summarized` or
  `omitted`) is required even when thinking is disabled. With no display
  declared Claude Code asks for `updates`, which returns no summary, so the
  display is passed explicitly (`extraArgs: {'thinking-display'}`). Claude
  Code substitutes the right shape per model (a budget on Haiku 4.5) without
  saying so. `alwaysThinkingEnabled: true` in `claudeSettings` turns thinking
  on even over a declared `disabled`.
- **Effort:** required; an account flag can move Claude Code's default, and a
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

## Other settings

- **Account connectors are off by default:** the baseline sets Claude Code's
  `disableClaudeAiConnectors: true`, and `claudeSettings` can turn them back
  on. The setting rather than the environment variable, so a setting can
  re-enable them ([proof 18](../participant-findings/proof-18-connectors.md)).
- **Claude Code's sandbox** is set through `claudeSettings` for now
  (`sandbox.enabled`, `autoAllowBashIfSandboxed`). Whether the sandbox should
  be a setting of its own depends on whether the SDK can say if it is active.
  If it can't start, Claude Code warns on stderr and runs Bash unsandboxed;
  `getSandboxDialog().enabled` (an internal SDK method) is the only running
  signal found ([sandbox under the SDK](../participant-findings/sandbox-under-sdk.md)).
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
- **Per-model values** use Claude Code's own `modelSettings` inside
  `claudeSettings`. An overrides table keyed by exact model or by family
  (exact model, then family, then the default) was accepted on 26 Sep for
  later; whether it survived the move to the generic `claudeSettings` is
  unclear.

## Bridge's control lines, for this participant

- **`context`:** as bridge; the text arrives verbatim in the first user
  message ([proof 11](../participant-findings/proof-11-context.md)).
- **`cwd`:** none. There is no default cwd; every `service` carries one.
- **`chdir`:** answered `unsupported` for now; it comes after the MVP (see
  [presence.md](presence.md)).
- **`retry`:** not now; Claude Code's own retry behaviour is accepted until a
  real problem shows. Only `CLAUDE_CODE_MAX_RETRIES` and
  `CLAUDE_CODE_RETRY_WATCHDOG` are settable; a maximum wait would have to be
  enforced from `api_retry` messages.
- **`credentials`:** tool credentials (not the Claude login); not needed now.
- **`tools`:** needed later, to control tool config and which tools are
  enabled.
- **`skills`:** see [skills.md](skills.md).
- **`revise`:** not needed.

## Open

- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`** still passes through. It forces the
  permission mode to `default`, but it also hardens the commands Claude Code
  runs. Strip it, keep it, or refuse loudly. (`src/startup.ts`, marked.)
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
- `syncClaudeAiSkills` is left at Claude Code's default; nobody chose it.
- Smaller builder choices nobody ruled on: the `system` reply is always
  `set`; an empty `{"model":{}}` is accepted; the `settings` line refuses
  bridge's `include`.
