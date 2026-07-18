# Bridge agent-parity plan: what's needed for daily use

What the bridge needs to replace claude-sdk-cli as a daily-driver agent.
Evidence: `investigation-agent-gap-findings.md` and
`investigation-agent-tools-findings.md` (repo root).

## Gap vs claude-sdk-cli's "Agent must" list

| Item | Status |
|---|---|
| spawn-with-config, audit log, approval flow, attachments, stdio bridge, standalone | have |
| Tool registry | wrong shape — `Bash` is raw shell (rejected shape), `Read` is naive, 4 of 5 tool families have nothing |
| Token refresh | missing — expired token just fails the turn |
| `Memory` / `History` | missing, not on the must-list at all (found by the unfiltered tool pass) |
| Output paging (`Ref`) | missing — 100 KB hard-truncate, silently discards |

## Decisions this session

| Decision | Why |
|---|---|
| Keep `Bash`, add `Exec` alongside | not a replacement — bash is bash, exec is exec |
| No auto-approve, no compaction | explicitly off the list |
| Merge `DeleteFile`+`DeleteDirectory` into one `Delete` | per-item auto-detect file/dir (visible discriminator); non-recursive — dir only deletes if empty, so a tree-delete means every path enumerated in leaf-first order, no hidden fan-out; ordered, per-item results, no wildcards for v1 |

## Ordered build

| Phase | Item | Shape | Gate |
|---|---|---|---|
| 1 | Token refresh | `anthropic.rs`: `Auth` reads `expiresAt`, refreshes + rewrites credentials on expiry | n/a |
| 1 | ~~`fts5` on rusqlite~~ | not needed — checked: `libsqlite3-sys`'s bundled build sets `-DSQLITE_ENABLE_FTS5` unconditionally (`build.rs:129`), no cargo feature gates it | n/a |
| 2.1 | `Exec` | ExecV3 shape: flat `commands`, `program`/`args`/`cwd`/`env`/`redirect`, forward-`op`, structured result, no shell | same as `Bash` |
| 2.2 | Composable read family | `Find`, `Match`, `Head`, `Tail`, `Range`, `Pipe`, `ReadFile`; retires naive `Read` | none |
| 2.3 | Binary read | `ReadFile` + `mimeType` for PDF/images → attachment block (`objects.rs`) | none |
| 2.4 | Paging (`Ref`) | context-window safety valve for tool output; not the same as towerd's `refs.rs` (that's wire/browser, this is model-context) | none |
| 3 | Edit family | `EditFile` (content-anchored), `CreateFile`, `AppendFile`, merged `Delete` | same as `Bash`/`Exec` |
| 4 | `Memory` | `WriteMemory`/`ReadMemory`/`SearchMemory`/`DeleteMemory`/`MemoryTypes` against `~/.claude/memory.db` (already multi-process safe: WAL, `busy_timeout`, shared with the CLI) | write ops mutating, read ops none |
| 4 | `History` | **blocked on a design question** — bridge has no local session log; either it ingests its own conversations into `history.db` like the CLI does, or `History` becomes a request to towerd. Tower-architecture decision, not a tool port. | n/a |

## Out of scope

Auto-approve, compaction, background bash, plan mode, hooks, vim mode (per
`feature-comparison.md`'s NO list). TypeScript LSP family — confirmed
TS-specific, not generalisable; the bridge serves arbitrary repos.
