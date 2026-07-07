# POC workspace

A cargo workspace: `fake-model`, `agent`, `tui`, `tower/backend`.
(`tower-wasm/` is its own workspace, deliberately excluded. `tower/frontend`
is a vite webapp — node's world, not a crate.)

## Expected on the machine

- **rustup** — owns the toolchain. `rust-toolchain.toml` pins the version;
  rustup reads it on entry, so no manual switching.
- **just** — the repo's named verbs: `cargo install just`.
- **docker** — for the NATS broker, which nothing here starts for you.

## Verbs

`just` with no argument lists them.

```sh
just build            # cargo build --workspace
just test             # cargo test --workspace
just check            # clippy + fmt --check
just dev              # fake-model + two agents + tower backend + vite (dev.sh)
just tui              # attach the terminal client (default agent-one)
just tui agent-two    # ...or by id
```

The verbs are thin: cargo is the whole build system, and the justfile only
names commands. The one real script is `dev.sh` — multi-process bring-up is
the single job cargo doesn't do.

## Dependencies

Shared versions live in `[workspace.dependencies]` in the root `Cargo.toml`;
crates inherit them with `foo.workspace = true`. Bump a version in one place
only. Crate-specific dependencies stay in their own crate.
