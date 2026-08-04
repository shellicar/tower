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

15 commits, in order. Each buildable, green, and independently useful the moment
it lands — not one-per-tool where tools share a real dependency or are trivially
simple together.

| Phase | # | Commit | Why here | Gate |
|---|---|---|---|---|
| 1 | ✅ | Token refresh | Done (`01bab20`). `anthropic.rs`: `Auth` reads `expiresAt`, refreshes + rewrites credentials on expiry | n/a |
| 1 | — | ~~`fts5` on rusqlite~~ | Resolved as a non-issue — `libsqlite3-sys`'s bundled build sets `-DSQLITE_ENABLE_FTS5` unconditionally (`build.rs:129`), no cargo feature gates it. No commit needed. | n/a |
| 2.1 Exec | 1 | `Exec` core | Schema (`program`/`args`/`cwd`/`env`), single-command run, structured result. Reuses `Bash`'s existing process machinery (group-kill, pipe draining, cancellation) — the new part is the structured shape, not process handling. | same as `Bash` |
| 2.1 Exec | 2 | Forward-`op` chaining | `;`/`&&`/`\|\|`/`\|`, `redirect` — genuinely separable from "run one program safely": a flat list joined by an operator. | same as `Bash` |
| 2.2 Read family | 3 | `Find` + engine plumbing | Simplest tool — a pure `SOURCE` (args→`File[]`), no stream input to accept, so it defines the engine's shape (stream types, source/stage/terminal roles, `pipe` `in`/`out`) while being useful standalone. Nothing else can build without this. | none |
| 2.2 Read family | 4 | `Read` (composable stage) | First `STAGE` — `File[]→Line[]`. Retires the naive `Read` from this session. | none |
| 2.2 Read family | 5 | `Match` | First tool dispatching on two stream types (`File[]` path-match vs `Line[]` content-match) — needs `Read` to exist to produce a content stream to test against. | none |
| 2.2 Read family | 6 | `Head`/`Tail`/`Range` together | Nearly identical shape — slice by position, same files-grain-vs-content-grain rule three ways. One shared helper, three thin tools, one commit. | none |
| 2.2 Read family | 7 | `Pipe` | Last, deliberately — the orchestrator validates and chains the others' `in`/`out` types, so it needs every other tool's contract to already exist. | none |
| 2.3 Binary read | 8 | `ReadFile` | MIME-sniffed, PDF/image → attachment block (`objects.rs`). Its own standalone tool, not part of the pipe family — separate from composable `Read`. | none |
| 2.4 Paging | 9 | `Ref` tool + content-addressed store | The fetch-by-id/paged mechanism itself; not the same as towerd's `refs.rs` (that's wire/browser, this is model-context). | none |
| 2.4 Paging | 10 | Auto-invoke over large tool outputs | The "walk and replace what's too big" wiring — depends on 9 existing, and on 2.1/2.2 being the tools that'll actually trip the size threshold. | none |
| 3 Mutation | 11 | `CreateFile` + `AppendFile` together | Both whole-file writes, no diffing — simplest pair, one commit. | same as `Bash`/`Exec` |
| 3 Mutation | 12 | `EditFile` | Content-anchored line/text edits, diff generation — the complex one, its own commit. | same as `Bash`/`Exec` |
| 3 Mutation | 13 | Merged `Delete` | Design already settled (auto-detect file/dir, non-recursive, ordered, per-item results, no wildcards — see Decisions above). | same as `Bash`/`Exec` |
| 4 Memory | 14 | Shared-db engine | Port `SqliteMemoryEngine`'s schema/FTS5/migrations, open `~/.claude/memory.db` (already multi-process safe: WAL, `busy_timeout`, shared with the CLI). No tool value without this existing first. | n/a |
| 4 Memory | 15 | The five `Memory` tools | `WriteMemory`/`ReadMemory`/`SearchMemory`/`DeleteMemory`/`MemoryTypes`, wired to the engine from 14. | write ops mutating, read ops none |
| 4 History | — | Not committable yet | **Blocked on a design question** — bridge has no local session log; either it ingests its own conversations into `history.db` like the CLI does, or `History` becomes a request to towerd. Tower-architecture decision, not a tool port. | n/a |

## Out of scope

Auto-approve, compaction, background bash, plan mode, hooks, vim mode (per
`feature-comparison.md`'s NO list). TypeScript LSP family — confirmed
TS-specific, not generalisable; the bridge serves arbitrary repos.
