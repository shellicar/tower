# Frontend test gaps

Findings, not a plan. Nothing here has been decided or acted on. They were turned up on
1 and 2 September while working out the testing strategy for the rail work, and they are
recorded so they are not found again from scratch.

## A test that has never run since the day it was written

`frontend-leptos/tests/row_measurement.rs` pins a real invariant: the row-height cache is
seeded from `getBoundingClientRect().height` and updated from the ResizeObserver's
`borderBoxSize`, and the two must agree or the cached height flaps on every mount. The
same invariant holds in `VirtualList.svelte`, which was checked directly rather than taken
from the test's own comment.

It runs nowhere.

The file is gated to `wasm32`, so a native `cargo test` compiles it to an empty binary.
CI's `checks` job runs `cargo test` on the native target only. The one job that builds for
wasm runs `trunk build`, which is a build and not a test. No workflow installs a browser
driver.

It only executes under `cargo test --target wasm32-unknown-unknown` with the runner and
chromedriver present, and no recipe does that. Whether it currently passes is unknown.

The commit sequence that introduced it says why plainly: a test written to prove a defect
existed, the runner configured so it could be run locally, then the defect fixed. It did
its job in that session and was left in the tree looking like a regression guard.

**The part that outlasts the one file.** A `#![cfg(target_arch = "wasm32")]` test file
reports `running 0 tests / test result: ok. 0 passed; 0 failed; 0 ignored` on a native
run. Green, exit zero, and not even the ignore count sees it. Nothing would stop the next
one being equally invisible.

## The Leptos `ui` module is compiled by nothing that checks it

`main.rs` gates `mod ui` behind `wasm32`. So `cargo test` does not compile it and
`cargo clippy` does not lint it, on a developer machine or in CI. Only `trunk build`
compiles it, which catches a compile error and nothing else.

This is why moving logic out of the render layer is worth more than it first appears: it
moves code from the part of the tree nothing checks into the part CI actually runs. An
operator working in `ui/` needs the wasm target installed to have verified anything, and
`rust-toolchain.toml` already declares it, so that part is automatic.

## No browser automation

There is `wasm-bindgen-test` with a Chrome driver on the Leptos side, used by the one file
above. There is no Playwright and no vitest browser mode, and `vite.config.ts` sets no
test environment at all, so the Svelte tests run under Node with no DOM. A layout test
cannot be written on the Svelte side without new infrastructure.

The Supreme Commander's position, given while scoping the rail work: he does not want that
infrastructure built as part of a feature branch, and tests the UI himself.

## Running the pieces separately

Not a gap, but it was worked out at the same time and is easy to lose. `just dev` runs
`dev.sh`, which sets three environment values before starting all three processes. Run
separately, from `mvp/`:

```sh
TOWER_DB=tower-v2.db cargo run -p towerd
```
```sh
cd frontend-leptos && trunk serve
```
```sh
TOWER_BIND=127.0.0.1:8081 WEB_PORT=5174 pnpm --dir frontend-svelte dev
```

Two of those matter and neither fails loudly. Without `TOWER_DB`, towerd falls back to
`tower.db`, which does not exist, so it creates an empty one and serves a blank Tower.
Without `TOWER_BIND`, vite proxies to 8080 instead of 8081 and the socket never connects.
Leptos needs nothing: `Trunk.toml` fixes its port and its proxy target.

There is no `just` recipe for any of them individually, and `just run` is the trap above:
bare `cargo run -p towerd` with no `TOWER_DB`.
