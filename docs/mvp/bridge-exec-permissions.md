# Exec permissions: design considerations

Not yet built. This is the understanding reached working through what a
configurable permission system for the bridge's `Exec` tool needs to handle,
before writing any of it. Grounded in claude-sdk-cli's actual code
(`/Users/stephen/repos/@shellicar/claude-cli`) and a local Claude Code
checkout (`~/repos/chatgptprojects/claude-code`), not guessed.

## Terminology

`git -C <path>`, `tmux -L <socket>` are **global options** — flags that sit
outside the subcommand and change the program's frame of reference (cwd,
target socket/daemon) rather than being data the subcommand acts on. The
risk: a permission check that inspects a structured `cwd` field can be
silently bypassed if the raw command also carries a global option that
changes the effective cwd underneath it.

## What claude-sdk-cli actually has today (two separate mechanisms)

1. **`builtinRules`** (`packages/claude-sdk-tools/src/Exec/builtinRules.ts`) —
   static, hardcoded, position-blind. Every check is `.includes()`/`.some()`
   over the args array, never `args[0] === ...`. A worked example:
   `no-force-push` catches `git -C /path push --force` correctly *by
   accident* — `.includes()` doesn't care where in the array `'push'` or
   `'--force'` sits, so position-blind checks are already immune to the
   `-C`-shifts-position worry. A positional check (`args[0] === 'push'`)
   would be the actual failure mode; nothing here does that.
2. **`permissions.ts`** (`apps/claude-sdk-cli/src/permissions.ts`) — the real
   configurable system. A **zone × operation × action matrix**: zone is
   `default`/`outside` (is the effect inside cwd?), operation is
   `read`/`write`/`delete`/`escalate` (declared per tool), action is
   `approve`/`ask`/`deny`, config-driven and hot-reloadable. It operates on
   **structured tool calls, not parsed shell text** — it reads a tool's own
   declared `operation` and the marked path fields in its `input_schema`.
   No grammar to parse, because the tool's shape already states where the
   effect lands.

## Why `git -C`/`pnpm -C` are banned in `builtinRules`

Not primarily a danger-severity call — a **reviewability** one. A raw
`-C ../other-repo` hides the true cwd from whoever's reviewing the call.
Two ways to fix that:

- **Ban the flag** (what's actually shipped) — cheap, no per-program flag
  grammar needed. Costs: the model loses the ability to use `-C` for a
  legitimate one-off cwd change without going through the tool's own `cwd`
  field.
- **Translate it** — parse `-C <path>` out and rewrite the call into
  `{cwd: path, args: [...without -C]}` before anything evaluates or
  displays it. Then the *existing* zone matrix does its job unmodified: an
  outside-cwd path is `ask`, not auto-approved, because the translation
  stopped hiding the truth from the check that already exists. Preserves
  capability; costs real per-program parsing work (`git`'s `-C` takes
  exactly one value; other programs' equivalents differ).

Neither is obviously right; it's a real trade between capability and
implementation cost, not decided here.

## The risk spectrum is three-way, not binary

- **Destructive** — data loss. `rm`, `git reset --hard`, `git clean`,
  `git push --force`. Deny.
- **Irreversible but non-destructive** — nothing lost, but a permanent trace
  remains no matter what happens after. `gh pr create` (closeable, never
  un-creatable). Needs its own tier the current `builtinRules` don't model.
- **Reversible** — freely undoable, append-only. Plain `git push`, `git
  commit`. Fine.

`git push` isn't in the destructive tier; `--force` is what makes it
destructive, which is exactly why `no-force-push` exists as a separate rule
from a blanket git-push ban.

## `xargs`'s ban may not port to a structured `Exec`

Banned in `builtinRules` for the same reviewability reason as `-C` — one
opaque shell string is hard to review. But `ExecV3`'s flat command list
means each command is already reviewed as its own discrete string, not
folded into one shell blob. Worth re-testing against the bridge's `Exec`
rather than porting the ban forward unexamined.

## The strongest mechanism: scope the credential, don't parse the text

Real access control (Azure read-only vs Contributor role) beats detecting
danger by pattern-matching arbitrary CLI args. Precedent: splitting GitHub
tooling into a privileged tool (`GitHub_PullRequest_Create` and friends, its
own credential, approval required) and a non-privileged one (plain `Exec`
running `gh`/`git`, no privilege to create PRs or force-push at all,
regardless of what text reaches it). The dangerous action class becomes
structurally unreachable through the generic path — no parsing needed for
the actions worth the effort of a dedicated tool and a scoped credential.

Implication for the bridge: generic `Exec` stays permissive-but-honest
(structured, reviewable, deny only true local data-loss); the genuinely
irreversible/high-privilege actions (PR creation, force-push, cloud writes)
get their own purpose-built tools on their own scoped credentials — which is
also just the tool suite growing more tools, not a new mechanism.

## Two orthogonal risk axes, not one

Matches `tool-philosophy.md`'s own stated boundary, independently re-derived
here: *"Irreversible effects gated at the interface. Network, anything that
escapes the sandbox and cannot be undone... In Docker/ephemeral contexts
there is no reason to restrict anything... The restrictions that remain are
for real-host contexts and for the network boundary."*

- **Filesystem locality** — deployment-dependent. Host (live, shared, not
  disposable): deny/ask on anything destructive. Container (disposable):
  wide open, because blast radius dies with the environment.
- **Network reach** — deployment-*independent*, defaults strict regardless
  of host or container, because the effect escapes either way (destroying a
  container never undoes a real `git push` or a real cloud-resource
  deletion). Needs real per-program/subcommand awareness — `git commit` is
  local, `git push` isn't; same program, different subcommand, different
  axis.

**No hard denies baked into the bridge's code at all.** Even what
`builtinRules` treats as absolute (`rm`, `dd`, `mkfs`, `sudo`) is one
configurable matrix, because "safe" is a property of where the bridge runs
and what a command reaches, never of the command text alone. The bridge
ships **config profiles** as starting points, not compiled-in rules — e.g. a
`host` profile shaped like the CLI's current denies, a `sandbox`/`container`
profile that's wide open on the filesystem axis (network axis stays strict
in both).

## Sandboxing as a second layer (OS-level, not the bridge's own logic)

Claude Code layers an actual OS sandbox under the tool-level permission
model: `@anthropic-ai/sandbox-runtime`, wrapped by
`src/utils/sandbox/sandbox-adapter.ts`. What's verified from that adapter
(the actual profile-generation engine is a stubbed/internal package, not
available to read):

- **Config-driven, cwd-scoped by default.** `allowWrite` defaults to
  `['.', <claude-temp-dir>]` — cwd plus one specific temp dir, everything
  else denied. Additional writable dirs come from `--add-dir`/settings. A
  plain path allowlist, not hand-written platform-specific profiles.
- **Cross-platform, same config shape:** macOS (Seatbelt), Linux/WSL2+
  (bubblewrap `bwrap`). Real portability gotcha: **bubblewrap doesn't
  support glob patterns** — a rule that works on macOS can silently behave
  differently on Linux.
- **Specific hardening beyond the obvious:** denies writes to
  `.claude/settings.json` and `.claude/skills` (skills carry full-Claude
  privilege, same protection as commands/agents); defends against a bare-git
  -repo-plant attack (`anthropics/claude-code#29316` — planting
  `HEAD`/`objects`/`refs`/`config` in cwd can trick git's bare-repo
  heuristic into later running unsandboxed code) by denying those specific
  paths if present, scrubbing them if absent.
- Network is domain-allowlisted the same way, off `WebFetch` permission
  rules.

**Read of the trade-off:** the *configuration model* here (allow/deny path
lists, cwd-relative default, domain allowlist) is worth reusing conceptually
— it matches the shape already being designed for the bridge. The *engine*
underneath (dependency checks, cross-platform profile generation, WSL2
support, the Linux glob limitation) is a real subsystem Anthropic built and
hasn't open-sourced; reimplementing it to the same fidelity in Rust is a
large undertaking, not a quick add. **Docker containment is the practical
primary boundary for the bridge now; OS-level sandboxing is a plausible
second layer later, not instead of it.**

## Enumeration vs discovery — why no wildcards on `Delete`

From `docs/planning/error-reporting.md` (ported from claude-cli's own next-toolset
design, `composition-model.md`/`toolset-direction.md` alongside it): **who bounds the
scope, the caller or the tool, determines both the safety model and the
error-reporting model.**

- **Enumeration tools** (`Exec`, the merged `Delete`) — the caller names every item;
  the error count is bounded by the input. This is *why* explicit enumeration is what
  makes an action approvable at all: you can't approve `Delete *`, you don't know what
  it will do. The same choice that bounds the action bounds the error surface.
- **Discovery tools** (`Find`) — the tool discovers an arbitrary set; errors are
  unbounded. Read-only, so no approval question, but needs summary-by-default,
  detail-opt-in reporting or a single bad directory floods the result.

Two error layers apply to any structured tool: **request-level** (the operation can't
start at all — hard error, no results) vs **item-level** (one item within a started,
valid operation fails — collected and returned *with* the results, never silently
dropped, never suppressible). `Exec`'s per-command result array already is an
item-level error bag (`stderr`/`exitCode` per command); `Delete`'s per-item result
(from the earlier design decision) needs the same shape — an explicit `errors`/status
per path, not a single pass/fail for the whole batch.

## Open, not decided

- Ban vs translate for global-option flags (`-C`, `-L`, etc.) on the bridge's
  `Exec`.
- Whether the irreversible-non-destructive tier needs a formal third action
  level, or folds into `ask`.
- Whether `xargs` needs banning under structured `Exec` at all.
- The exact config profile shape (where it lives, how a profile is
  selected — env, spawn config, a stdio control line) and the network-reach
  classification data (which programs/subcommands count as "reaches
  outside").
