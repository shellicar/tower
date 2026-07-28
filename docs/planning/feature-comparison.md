# Feature comparison: claude-sdk-cli vs the tower apps

Rewritten 28 Jul 2026, replacing the 12 Jul version (which compared
claude-sdk-cli against Claude Code and set the original MVP scope; its
decided NO list carries forward below). The live comparison is now
claude-sdk-cli against the four tower apps: bridge, towerd, helm, and the
two frontends.

Method: read from code, not docs. CLI side: the DI container
(`setup/container.ts`), the config schema (`cli-config/schema.ts`), the CLI
flags (`help.ts`), the tool registration (`createAppTools.ts`), and a survey
of every branch/worktree. Tower side: bridge's control lines and tool
dispatch (`main.rs`, `agent.rs`), the WS spec, helm's module docs, and
`docs/mvp/frontend-parity.md` for the two frontends. Anything not read is
marked unverified.

**The lens: bridge started as a side tool; it is now intended as the SC's
main agent at work (node projects).** This doc exists to state the gap
accurately so the MVP / nice-to-have call can be made on proper
information. Earlier documented rulings (the 12 Jul NO list, the parity
plan's exclusions) were made when bridge was not meant to be the main
agent: they are historical context, never settled scope, and treating one
as settled hides exactly the information the decision needs. The only
standing rulings are the SC's, dated inline.

Scope legend: **must** / **want** (only where the SC has ruled, dated) /
**undecided** (needs a ruling; not guessed here) / **historical** (a past
ruling recorded for context, open for re-decision). "have" in a CLI/bridge
cell means present and read in code this pass.

---

## 1. Agent core

| Feature | claude-sdk-cli | bridge | Scope for bridge |
|---|---|---|---|
| OAuth token refresh | have | have: same credentials file, refreshed in place, either process picks up the other's refresh | must (done) |
| API key auth | ✗ (OAuth only) | have: `ANTHROPIC_API_KEY` wins over the file | n/a |
| Keychain credential storage | have (keychain-native, macOS arm64 optional dep) | ✗ (file only) | undecided |
| Model default + live switch | `--model`, command-mode selector backed by a model catalog | `BRIDGE_MODEL` + `model` control line (free string, no catalog) | catalog: undecided |
| max_tokens | config, default 32,000 | fixed 8,192 (`anthropic.rs::MAX_TOKENS`) | undecided (cheap to raise) |
| Extended thinking | enabled + effort enum (max…low), cycled live from command mode | budget number via `BRIDGE_THINKING_BUDGET` at boot; no live control | undecided |
| Compaction | opt-in config, default off (`compact.enabled`) | ✗ | undecided (historical NO, 12 Jul) |
| Session persistence / resume | sessions.db + auto-resume, `--resume <id>`, `--no-resume`, recover-by-directory, bound system identity survives resume | the record is JetStream; `adopt` replays any conversation by id | different mechanisms, both continuity; parity n/a |
| Turn robustness | mid-turn network-drop survival, capped abortable retries, dangling tool_use self-heal (load + request time), cancel shows immediately | cooperative cancel, turn endings always published; retry/self-heal **unverified** | undecided (audit bridge first) |
| Multi-conversation hosting | one conversation per process | N conversations per instance; supersession per agent spec | bridge has it; CLI side undecided |
| Audit | audit jsonl + AuditStats (incl. subagent-aware rollup on branch) | the JetStream record is the audit | have both |
| Wake lock during requests | have (caffeinate, opt-out) | ✗ | undecided |
| Account-limit notice | have | ✗ | undecided |
| Deployment | SEA single executable, `--verify`, npm platform packages | cargo binary, native Windows support | n/a |

## 2. Config and runtime control

CLI: one schema'd config file (`sdk-config.json`) with hot reload; an
independent watch for `tools.rules` so a broken rules edit can't block
unrelated reloads; `--config` JSON overrides; `--init-config`; generated
JSON Schema for editor autocomplete. Flags: `--file`, `--name`, `--model`,
`--prompt`, `--system`, `--claudeMd`, `--system-identity`, `--resume`,
`--no-resume`, `--config`.

Bridge: env vars plus stdio control lines, batched (`-c`) and live, one
grammar: `spawn`, `adopt`, `skills`, `system`, `context`, `model`, `cwd`,
`chdir`, `permissions`, `revise`, `settings`. This is the original
"config: bootstrap + dynamic update" primitive realised.

| Capability | claude-sdk-cli | bridge | Scope for bridge |
|---|---|---|---|
| Live config source | file watch + reload notices | control lines | equivalent by design |
| `disabledTools` (hide tools live) | have, with flip notices | ✗ | undecided |
| `requiredSkills` (tool gated on a prior Skill load) | have (failed-load fix on branch) | ✗ | undecided |
| Move a running conversation's cwd | have (command mode cd, re-pointed watches) | have (`chdir`, publishes `moved`) | done |
| Revise a committed message | ✗ | have (`revise`, append-only record) | bridge-only |
| Settings snapshot query | effective-config display | `settings` control line | done |

## 3. Tool surface

Shared and equivalent (both sides read this pass): Pipe with
Find/Read/Match/Head/Tail/Range stages, ReadFile (PDF/images, sips
conditioning), EditFile (line + text edits, numbered diff), CreateFile,
AppendFile, Ref with automatic externalising of oversized outputs (CLI
50 KB threshold, persistent store; bridge temp-dir store), the five Memory
tools, SearchHistory/ReadHistory, Skill with catalogue + delta reminders.

**Memory and history are one store, not two:** bridge defaults to the CLI's
own `~/.claude/memory.db` and `~/.claude/history.db`, same schema. A memory
written in either process is visible in the other. (CLI additionally runs a
jittered background history dedup sweep; bridge doesn't. Minor.)

Differences:

| Tool / behaviour | claude-sdk-cli | bridge | Scope for bridge |
|---|---|---|---|
| Paths (explicit-path pipe source) | have | ✗ (Read takes paths directly) | undecided (minor) |
| Delete | DeleteFile + DeleteDirectory | unified `Delete`, auto-detect, non-recursive | no gap (bridge's merged shape covers both) |
| Exec | ExecV3: op-chaining, redirect, cwd/env, `stdin`, `timeout`, `stripAnsi`, `durationMs`, configurable safety rules + blockedCommands, credential-stripping env provider | `Exec`: op-chaining, redirect, cwd/env; no stdin/timeout/stripAnsi/duration; **no safety rules, no credential stripping** | rules/stripping: undecided; field parity: undecided |
| TS tools (TsDiagnostics/Hover/References/Definition) | have, on-demand tsserver | ✗ | **want** (ruled 28 Jul: good, not a deal breaker; the parity plan's exclusion is historical) |
| GitHub PR suite + gh reader/escalated split | have | ✗ | **must** (ruled 28 Jul) |
| ADO PR suite (multi-account, cached az sessions) + AzCli/EscalatedAzCli | have | ✗ | **must** (ruled 28 Jul: needed for work) |
| Escalation model (reader by default, holder identity behind approval, certs/tokens from Keychain read per call, never in env) | have | ✗ (no equivalent concept) | **must** (ruled 28 Jul, with the Az/GitHub suites it carries) |
| Web search / web fetch (server tools, versioned, ZDR-aware allowedCallers) | have | ✗ | undecided |
| Advanced tool use (deferred loading via search tool, programmatic tool calls from code execution) | have | ✗ | undecided |
| Bash (raw shell) | ✗ | kept in-tree, not offered | n/a |
| MCP servers (mcp-memory/history/typescript/exec expose subsystems to other MCP clients) | have (sibling packages) | ✗ (the wire is bridge's answer) | undecided |
| Subagent | branch only (see §9) | ✗ | **must** (ruled 28 Jul; CLI-side it lives on `feature/subagent-v2`, not main) |
| Git_* named tools | branch only (see §9) | ✗ | undecided |

## 4. Approvals and permissions

| Capability | claude-sdk-cli | bridge |
|---|---|---|
| Model | zone matrix: default/outside cwd × read/write/delete → approve/ask/deny | path-scoped `PermissionSet`: allow/deny/ask per action and path, one blob, live repoint |
| Exec safety | ExecV3 rule config (replace/remove/add named rules) + blockedCommands, validated on its own watch | ✗ (the matrix gates the Exec tool as a whole; **per-command rules absent**) |
| Wire approvals | approval.v1 raise/answer, local UI races the wire | approval.v1 to all clients |
| Batch behaviour | concurrent tool batches; batch-cancel and wrong-tool-settled bugs fixed (#480/#482) | per-turn sequential dispatch (**concurrency unverified**) |
| Auto-approve | zones can approve silently | none (historical ruling, 12 Jul) |
| Offered-set gate | n/a (registry owns) | tool_use for anything not offered this turn is rejected, not executed |
| Notifier hook | `hooks.approvalNotify` (command + delay) | ✗ (historical NO, 12 Jul) |

In flight: `feature/orchestrate`'s unified Policy resolver (ordered
first-match rules over tool/input/path, strictest-wins folding, an
`escalate` operation tier that can never be pre-trusted, live watch with
notices) replaces both the zone matrix and the rules config on that branch.
**Policy-grade permissions are needed (ruled 28 Jul). How they land in
bridge (port Policy, grow PermissionSet to match, or share one
implementation) is undecided.**

## 5. Model-facing context

| Capability | claude-sdk-cli | bridge | Scope for bridge |
|---|---|---|---|
| CLAUDE.md auto-load | four sources, per-source toggles, cached assembled prefix, `--claudeMd` | ✗; the spawner supplies `context`, committed at birth | undecided: may be deliberate (spawner owns context) |
| SYSTEM.md / system prompt | file sources + config text + `--system` | `system` control line, read fresh each turn | equivalent |
| Skills catalogue + per-say delta | have | have | done |
| Clock stamp on the user's turn | have (persisted, ordering bugs fixed) | ✗ | undecided |
| Cwd reminder | have | ✗ | undecided |
| Git delta reminder (incl. ahead/behind) | have (GitStateMonitor) | ✗ | undecided |
| Injected-marker XML wrapping | have | have (`<system-reminder>` on context/skills) | done |

## 6. Wire contract status (CLI ↔ tower specs)

The CLI conformed to conv v2 + agent v1 on 19 Jul (#445): serves
say/cancel, raises/answers approvals, speaks ready/pulse/attached/
service/drain/chdir. The spec moved after that date. All three moves rode
spec-first PRs (the repo's rule), so this is deliberate sequencing with the
CLI-side close outstanding, not silent drift:

| Spec change | Tower side | CLI side |
|---|---|---|
| Attachment claims moved onto the conversation's own tree (#20, 28 Jul) | bridge publishes on the conv tree | still publishes `agent.v1.{world}.telemetry.attached/detached` — outstanding |
| Supersession: singular claim, unconditional takeover, exactly-once conduct (#19, 27 Jul) | bridge implements | CLI rejects `service` for a second conversation (`already_attached`) per the older model — outstanding |
| `moved` as a fact about the standing claim (not a re-`attached`) | bridge publishes `moved` | CLI re-publishes `attached` on cwd change, now the named violation shape — outstanding |
| Attachment buckets: servicer resolves against the block's named bucket, rejects bucket-less (22 Jul) | bridge resolves and rejects | CLI has **no object-attachment resolution in wire says at all** (no code found in `conv/`); unclear if deferral or gap |

Not drift (verified): the old NATS tap events are retired into the
conforming bus; `$ref` externalisation is towerd's WS-apply concern and
deliberately not on the NATS wire (CLAUDE.md names it interim).

## 7. Client surfaces

Three user surfaces against the CLI's TUI. S = frontend-svelte,
L = frontend-leptos. The S↔L internal gap list (markdown, height
prediction, visual rulings) lives in `docs/mvp/frontend-parity.md` and is
not duplicated here.

| Affordance | CLI TUI | helm | frontends |
|---|---|---|---|
| Conversations visible | one | one (spawns its own bridge) | the fleet: rail by staleness, tabs, unread view, potential conversations, dismissal |
| Streaming text | have | have | have |
| Thinking display | have (configurable) | have (click to expand) | have |
| Markdown | have, streaming, OSC-8 links | have (pulldown-cmark twin: tables, link href preview in status line) | S: marked+DOMPurify; L: not yet (parity doc #5) |
| Tool call collapse/expand | have | click on block | have (S shape ruled the standard) |
| Scrollback | sealed blocks flush to native scrollback (#483) + mouse wheel + a history view over past blocks | alt-buffer only, wheel scroll, exact click hit-map; no history view | virtual list (S windowed+predicted, L windowed) |
| Approvals | Y/N any phase, flash timer, arrow nav between pending | Ctrl+Y/N oldest; y/n in command mode | dedicated panel + inline card, all conversations |
| Attachments | paste text/file/image, remove, preview toggle | t/i/f chips, d drop, clipboard image (pngpaste) | upload + send with say |
| Command mode | attach, preview, cd submode, new session, model submode (catalog selector, thinking/effort cycling) | attach, drop, approval, model (free text), cwd, config JSON editor (any bridge control line rides through) | n/a (direct UI) |
| Status | model, version, tokens in/out split, cost, ctx %, turns, user/tools/claude time split, conversation id | usage line: tokens, cost, ctx (derived locally from per-turn frames) | usage line + per-model pricing, per-conversation model/name/version |
| Session ops | new/resume/move-dir live | fresh spawn per run; adopt **unverified** (config passthrough may reach bridge's `adopt`) | open/read/say into any conversation, incl. adopted ones |
| Title/tag | `--name` label | ✗ | title editing wired; tag editing is dead plumbing both sides (parity doc) |
| Refs (`$ref`) paging | n/a (Ref tool is model-facing) | n/a (full content arrives over the attach fd) | have (RefView, ranged fetch) |
| Reconnect | n/a (local) | n/a (child pipes) | S: backoff reconnect; L: fixed (parity doc) |

## 8. towerd (no CLI equivalent)

The serving layer the CLI user simply doesn't have: WS fan-out with
open-gated content and unconditional row/staleness events (staleness is the
product), `$ref` externalisation at four fixed nodes with `GET /ref` Range
paging (the WS never carries megabytes), `POST /attachment` with
towerd-stamped buckets, unread tracking (readId), layout persistence,
agent-facts fold (liveness derived client-side, never a verdict column),
potential conversations, sqlite views + JetStream cursor committed in one
transaction. The CLI participates on the wire as an agent (#411), so its
conversations can in principle be towed; nothing here needs porting *into*
the CLI.

## 9. In-progress work (claude-cli branches, surveyed 28 Jul)

| Branch | State | What it holds |
|---|---|---|
| `feature/orchestrate` | ~70 commits, active 28 Jul | Tools V2: orchestrate-core engine (typed streams, lazy stages), V2 ports of essentially the whole tool surface (file tools, Ref, Memory, History, Skill, TS, GitHub/ADO/Az), a `Program` leaf at ExecV3 parity, the unified Policy resolver (§4), `escalate` operation, per-block DI scope replacing blockLifetime. Bypasses V1's registry and permission matrix on its path. The single biggest change in flight. |
| `feature/subagent-v2` | 12 commits, active 28 Jul | Subagent tool on a DI scope shadowing the root: one-shot, cwd-scoped, approvals through the parent's matrix and the wire, live cost rollup in the parent's status line and transcript. Supersedes `feature/subagent`. |
| `feature/git-tool` | 13 commits, 22 Jul | Named per-action `Git_*` tools replacing raw git: worktree/merge/cherry-pick/revert/clone/submodule coverage, credential redaction, argument-injection hardening, raw git blocked in ExecV3. Orchestrate notes its Git migration is blocked on this landing. |
| `feature/advanced-tool-use` | 2 commits | Skill-gate fix: a failed Skill load no longer counts as satisfying `requiredSkills`. Near-mergeable. |
| `feature/release-1.0.0-beta.24` | 1 commit | Version bump, pending. |
| `feature/read-only-mode`, `feature/exec-pipe-into-group`, `feature/disable-gh-pr` | worktrees at main, zero commits | Intent markers, no work yet. |
| merged-PR source branches (`az-auth-hardening` #484, `approvals-eating-inputs` #480, `bad-tool-result` #482, `bad-tool-result-2` #485, `buffer-flush` #483, `system-reminder-corruption`, `azcli-login`) | merged | Pre-squash history only. |
| `feature/history-search-poc`, `review*`, `docs/*`, pre-June fixes | stale | Superseded or historical. |

Tower side in flight: attachment claims/supersession just landed (#19,
#20); frontend-parity porting order stands in `docs/mvp/frontend-parity.md`.

## 10. Scope summary

**Done since the 12 Jul doc** (was must/want, now shipped in bridge): token
refresh, structured Exec, the composable read family, ReadFile, Ref with
auto-externalise, CreateFile/AppendFile/EditFile/Delete, Memory, History,
Skill + catalogue, permission matrix, per-conversation cwd + chdir, adopt,
revise, settings, live model.

**Historical NO list** (12 Jul, made when bridge was a side tool; recorded
for context, none re-affirmed, each open for re-decision): compaction,
auto-approve, background bash, plan mode, hooks, ApprovalNotifier, auto
memory, vim mode, voice, @-file mentions, slash-commands-as-input,
/memory, /init.

**Ruled 28 Jul (the SC):**

- must: the escalated/AzCli credential model and ADO suite (work).
- must: the GitHub PR suite.
- must: Subagent.
- must: Policy (the orchestrate permission/rules model).
- want: TS tools (good, not a deal breaker).

**Undecided, needing a ruling:**

- How each must lands: ported into bridge, or those conversations served
  by the CLI over the wire.
- Exec hardening in bridge: safety rules, blocked commands, credential
  stripping; stdin/timeout/stripAnsi field parity.
- Model-facing reminders in bridge: clock, cwd, git delta.
- Live tool governance in bridge: disabledTools, requiredSkills.
- max_tokens raise and effort-style thinking control in bridge.
- Web search/fetch and advanced tool use in bridge.
- Model catalog in bridge/helm.
- CLAUDE.md auto-load in bridge vs spawner-owned context.
- Keychain credential storage in bridge.
- Everything on the historical NO list, if wanted at all.
- CLI side: wire-say attachment resolution; the three outstanding
  attachment-spec conformance items (§6).
- The permission model convergence question (§4).
- Turn-robustness audit of bridge (retry/self-heal) before deciding
  whether there's a gap at all.
