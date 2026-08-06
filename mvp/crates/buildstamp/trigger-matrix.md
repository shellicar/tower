# Trigger matrix

What buildstamp resolves is unit tested. What cargo does with the
`rerun-if-changed` lines it emits is not: whether a build script re-runs is
cargo's own behaviour, and the only way to know is to build, edit, build again
and read the stamp. That is this checklist.

A stamp that says clean when the tree was not is the failure worth catching,
and the two rows that catch it are the unstaged edit (rows 2 and 3, where the
code recompiles and a script naming only the git paths would still report the
old stamp) and the edit to an unrelated crate (row 4, where a stamp scoped to
the whole repo would report dirty for work this binary does not contain).

## Running it

Against bridge, from a clean tree at a commit whose short hash is H. Each row
starts from that clean state, so undo the previous row's edit first.

```sh
cd mvp
cargo build -p bridge
NATS_URL=nats://127.0.0.1:1 ./target/debug/bridge 2>&1 | head -1
```

The unreachable NATS port is deliberate: the banner prints before the broker is
dialled, so bridge names its build and then exits without touching a real
broker.

## Last run

macOS, 2026-08-02, in a linked worktree (`.git` is a file), H = `0ec2a77`.

| what you do | expected stamp | observed |
| --- | --- | --- |
| build clean | `H` | `0ec2a77` |
| edit a file in bridge itself, do not stage, rebuild | `H-dirty` | `0ec2a77-dirty` |
| edit a file in a path dependency (`wire`), do not stage, rebuild | `H-dirty` | `0ec2a77-dirty` |
| edit a file in a crate bridge does not depend on (`towerd`), rebuild | `H` | `0ec2a77` |
| add an untracked `.rs` inside bridge, rebuild | `H-dirty` | `0ec2a77-dirty` |
| edit a file outside `mvp/` (a doc), rebuild | `H` | `0ec2a77` |
| stage any of the dirty rows above, rebuild | `H-dirty` | `0ec2a77-dirty` |
| revert everything, rebuild | `H` | `0ec2a77` |
| commit a change, rebuild touching nothing else | the new hash, clean | recorded below |

The last row moves H, so it is recorded after the fact: committing this file
took the tree to `dffdf7f`, and the next `cargo build -p bridge`, with nothing
else touched, stamped `dffdf7f` clean. That commit touched no file bridge
compiles, so the rebuild came from the worktree's own `HEAD` alone, which is
the path a hardcoded `.git/HEAD` would have missed here.
