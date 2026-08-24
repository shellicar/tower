# Trigger matrix

`tests/stamp.rs` is the proof. It drives cargo against a scratch repository
and asserts what the built binary says it is: clean, after editing a compiled
file, after adding an untracked file a module references, after editing a file
nothing compiles, after a commit, and with no stamp handed in at all. Run it
with `cargo test -p buildstamp`.

What that test cannot reach is this workspace: four real binaries, two of them
sharing crates, one built by trunk for a different target, and the two-build
flow that `just` runs. Those are the rows below, and they are worth walking
after anything touches the build.

## Running it

```sh
cd mvp
just build
NATS_URL=nats://127.0.0.1:1 ./target/debug/bridge 2>&1 | head -1
```

The unreachable NATS port is deliberate: bridge names its build before it
dials a broker, so it says what it is and then exits without touching one.
towerd takes `TOWER_DB=/tmp/scratch.db` alongside. helm holds the terminal, so
read its stamp with `strings target/debug/helm | grep <hash>` instead.

## Last run

macOS, 2026-08-24, in a linked worktree, at `352de0a`.

| what you do | expected | observed |
| --- | --- | --- |
| `just build` on a committed tree | every binary names the commit | `352de0a` for bridge, towerd, helm, leptos |
| leave an untracked `.rs` in `crates/bridge/src` that no module declares | clean, since nothing compiles it | `352de0a` |
| edit a file bridge compiles | bridge dirty | `352de0a-dirty` |
| ... and read towerd in the same build | towerd untouched, and not even recompiled | `352de0a`, its build time unchanged |
| revert the edit, `just build` | clean again | `352de0a` |
| `just build` twice over, nothing changed | no crate recompiles | both builds 0.13s, nothing compiled |
| `just frontend` (trunk, wasm target) | the wasm carries the stamp | `352de0a`, found in `dist/*.wasm` |
| release two-pass, as CI runs it | the release binary names the commit | `352de0a` |

## Why two builds

The first build is what makes cargo write `target/<profile>/<binary>.d`, the
list of files that binary was compiled from. The stamp is computed from that
list, and the second build bakes it in.

Both builds are handed a stamp, and the first is handed whatever the previous
build left behind. That is not decoration: a variable that flips between set
and unset is a change like any other, so handing a stamp to only the second
build recompiles every stamped crate on every build. Measured before the fix,
each pass cost 1.7s with nothing changed; after it, 0.13s.

A bare `cargo build` is still stamped. With nothing handed in, the build script
falls back to the dep-info the previous build left, which is at worst one build
stale, and never silently unstamped.
