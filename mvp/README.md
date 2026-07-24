# mvp

Setup instructions for building and running `towerd`, `bridge`, and `helm`.
See the root [`CLAUDE.md`](../CLAUDE.md) for architecture and the `just`
verbs; this file only covers getting a working toolchain per platform.

## Rust toolchain

`rust-toolchain.toml` pins the compiler version (currently 1.96.1) and adds
the `wasm32-unknown-unknown` target the two web frontends need. Once
`rustup` is on your machine, entering `mvp/` picks the pinned toolchain up
automatically — nothing else to configure.

### macOS

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Or via Homebrew: `brew install rustup-init && rustup-init`.

### Windows (native, not WSL2)

helm and bridge are built to run as native Windows binaries — this is not
about the WSL2 path, which is just Linux and needs nothing beyond the macOS/
Linux instructions above inside the WSL2 shell.

1. Install the MSVC build tools first. The default Windows toolchain
   (`x86_64-pc-windows-msvc`) links with `link.exe` from Visual Studio, not
   with anything `rustup` provides — skipping this step is the most common
   way a native Windows Rust build fails at the link stage, not the compile
   stage, which makes the error harder to place if you don't know to expect
   it.
   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools"
   ```
   (Or via the Visual Studio Installer GUI: the "Desktop development with
   C++" workload.)
2. Install `rustup`:
   ```powershell
   winget install --id Rustlang.Rustup
   ```
   Or via Scoop: `scoop install rustup`.
3. Open a fresh terminal (so `PATH` picks up `cargo`/`rustc`) and confirm:
   ```powershell
   rustc --version
   ```

### Linux

Same command as macOS (`rustup.rs`), or your distribution's package manager
(`rustup` is preferred over a distro-packaged `rustc`, since the pinned
toolchain file needs `rustup` present to act on it).

## Building

```sh
cd mvp
cargo build --workspace      # or: just build, if you have just installed
cargo test --workspace       # or: just test
```

`just` itself is optional — a convenience over the same `cargo` commands,
listed in [`justfile`](justfile). Install it with `cargo install just`,
or your platform's package manager (`winget install --id Casey.Just` on
Windows).

## Frontends and the broker

See the root `CLAUDE.md`'s Build and verify section for `just dev`, the
Svelte/Leptos frontend builds, and the NATS broker (`docker compose up -d`)
they need running.

## Windows support status

The `helm`/`bridge` attach channel (the local duplex pipe between them) was
ported off Unix-only `fork`+`dup2` onto `interprocess::unnamed_pipe`
specifically so this runs natively on Windows — verified by reading source
and by tests on macOS, not yet run on real Windows hardware. If you hit
something building or running there, that seam is the first place to look.
