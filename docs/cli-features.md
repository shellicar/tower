# claude-sdk-cli — Feature Backlog

## Always show model name in status line (#94)

The model name only appears when overridden via `/model`. It should always be visible.

- Normal: `⚡ sonnet`
- Overridden: `⚡ sonnet*`

Small change, high signal value.

---

## Show conversation history on startup/resume (#97)

When resuming a session the screen starts blank. Show the last N messages so the user
has context for where they left off.

- Configurable N (default ~10)
- Condensed view: user messages + assistant text, tool calls optional
- Visual separator between history and new input (e.g. `── resumed ──`)
- Audit log has all the data needed

Note: Step 1b of the architecture refactor (`replayHistory`) replays the full history
into the block display. This issue is about a condensed summary view, not full replay.

---

## Tool output viewer (#96)

Inline tool output is truncated. Claude has the full output in context and refers to it;
the user sees 10 lines. Add a way to open the full output in a scrollable alternate buffer.

- Accessible from command mode (e.g. `ctrl+/` then `t`)
- Full scrollable view, keyboard navigation, `q`/`Esc` to return
- Support selecting which tool output to view when multiple tools were called

---

## Alt/history view for block navigation (#179)

A secondary view mode for reviewing the conversation history block by block, without
disrupting the live feed.

- Block-aware navigation (thinking, tool call, response are discrete units)
- Collapsible/expandable blocks (collapse a 2000-line tool result to one summary line)
- Primary view continues undisturbed while in history mode
- Switching back returns to the live view at the current position

---

## Show session ID at end of response (#164)

The session ID is printed at startup but scrolls out of the alternate buffer. After each
response completes, include it in the result summary area alongside cost/duration/context.

---

## Configurable default submit mode (#130)

A `submitMode` config setting:
- `"newline"`: Enter inserts newline, modifier+Enter sends (current default)
- `"send"`: Enter sends, modifier+Enter inserts newline

Provides an escape hatch when keybinds are broken and command mode is unreachable.

---

## Configurable keybinds (#128)

Keybinds are hardcoded. Different terminals send different escape sequences for the
same logical key. Move keybind mappings to `cli-config.json` so users can override
raw sequences and map them to actions.

Defaults match current behaviour, no breaking change.

---

## Configurable settingSources (#105)

`settingSources` is hardcoded to `['local', 'project', 'user']`. Exposing it in
`cli-config.json` lets users opt out of user-scoped settings for specific use cases
(e.g. a Skill Manager agent needs a clean context without loading the skills it audits).

Schema: `z.array(z.enum(['local', 'project', 'user'])).default(['local', 'project', 'user'])`

---

## Exec: structured permission model (#101)

A rule-based permission model for the Exec tool. Rules match on `program`, `args`,
`params`, `cwd` with AND between fields and OR within. Action priority: deny > ask > allow.

Design detail in issue #101. Depends on command normalisation (#104).

---

## Exec: command normalisation (#104)

Resolve raw command input to a canonical form before permission rules evaluate it.
Three-layer pipeline: program resolution (full path + basename), tool-aware parsing
(git, pnpm, sed, mv, cp, rm), permission evaluation against canonical form.

Design detail and POC notes in issue #104. Prerequisite for #101.


---

## CLAUDE.md loading (#226)

Load `CLAUDE.md` files from standard locations and inject their content as system
prompts, so project-specific and user-specific context is available to the agent
without hardcoding it in `systemPrompts.ts`.

**Load order (lower overrides higher):**
- `~/.claude/CLAUDE.md` — user-scoped, always loaded
- `<project>/.claude/CLAUDE.md` — project-scoped, local to the repo
- `<project>/CLAUDE.md` — project root, visible to all tools

All files that exist are read and appended as separate system prompt entries (same
behaviour as the current `systemPrompts` array). Missing files are silently skipped.

**Hot reload:** watch both project-level paths (same debounce + idle-only pattern
as `SdkConfigWatcher`). Home file is loaded once at startup — changes there require
a restart.

**Config opt-out:** a `claudeMd.enabled` flag (default `true`) in `sdk-config.json`
lets users disable loading entirely (e.g. for a sandboxed agent run).