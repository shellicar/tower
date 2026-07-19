# A third frontend: Leptos

## Read first

- `docs/mvp/frontend-architecture.md` — the architecture both existing frontends
  hold constant: transport, concerns (rail, conversations, approvals, view),
  fan-out vs subscribe, the read/write split. This build holds it constant too.
- `docs/mvp/frontend-comparison.md` — the Svelte-vs-egui write-up, merged to
  `main`. Read the whole thing before starting; this plan assumes its four
  axes and doesn't restate them.
- `docs/mvp/tower-ws-spec.md` — the wire contract to build against.
- `mvp/crates/ws-types` — the shared `ServerMsg`/`ClientMsg` types. Reuse
  verbatim; do not hand-roll a parallel type file (that's the mistake the
  Svelte side lives with).

`feature/rust-wasm` is merged to `main` — `frontend-rs`, `ws-types`, and the
docs above are all on `main` now. Do this build in its own worktree branched
from `main`, not inside the existing `frontend-rs` worktree.

## Why a third build

The Svelte-vs-egui comparison isolated what the architecture buys from what
egui costs (Axis 3: no DOM, immediate-mode repaint, tofu glyphs, heavier idle
footprint) — and named that axis swappable, not fundamental. Leptos was
independently vetted as the stronger of the DOM-capable Rust options
(fine-grained signals like Svelte 5 runes, not a vdom; more active repo, more
current docs and examples, an explicit `ARCHITECTURE.md`/`COMMON_BUGS.md` to
ground against). This build tests whether a DOM-based Rust renderer keeps
Axes 1 and 2 (compiler-enforced isolation, shared wire types) while fixing
Axis 3.

## Scope: the same slice, again

Match what `frontend-rs` built, nothing more — the comparison is only valid if
the slice is held constant a third time:

- the staleness rail
- one conversation panel: read messages, say, cancel, attach
- the approvals view: answer, dismiss

Do not add tabs/multi-open (Svelte has it, egui doesn't) unless comparing that
specifically becomes the point — decide and note it, don't drift into it.

## Concern shape to carry over

Same four concerns, same contract, ported to Leptos signals instead of
`$state` runes or plain structs:

- `Transport` — owns the socket only. `web-sys`/`gloo-net` WebSocket (or
  Leptos's own wrapper if one exists — check, don't assume) instead of
  `ewebsock`. Still no domain state.
- `Rail`, `Conversations`, `Approvals` — each a struct of signals, each folding
  its own slice of `ServerMsg` via the same `apply(&mut self, &ServerMsg)`
  shape the other two builds use. Whether Leptos's ownership model
  (`RwSignal`/`ReadSignal`+`WriteSignal`, scopes) forces a different shape than
  egui's plain `&mut self` is itself a finding worth writing down — don't
  fight the framework to force a literal match.
- Composition root — Leptos's top-level component, wiring transport +
  concerns, same fan-out-not-subscribe question the egui build already
  answered (worth re-checking whether Leptos's reactive graph changes that
  answer, since unlike egui it primitively supports fine-grained subscription).

## What to measure, matching the existing comparison's axes

1. **Enforcement** — does Leptos's ownership model still make cross-concern
   reach a compile error, or does the signal system's shared-handle nature
   reopen the god-store risk the Svelte rearchitecture and the egui build both
   closed?
2. **Shared wire types** — confirm `ws-types` drops in unchanged. Should be a
   non-finding (a repeat of Axis 2, not a new one) — call it out only if it
   isn't.
3. **Render surface** — the one axis expected to move. Real DOM: does browser
   find/select/right-click/inspect come back? Idle CPU/memory against the
   egui numbers in `frontend-comparison.md` (~175MB/several % CPU) and the
   Svelte numbers (~55MB/near-zero). Tofu-glyph problem should simply not
   exist (real text nodes) — confirm.
4. **Survival under careless extension** — same build-in-sequence method:
   add conversation, then approvals, then upload, each as "a concern + wiring
   in the root," and note where the compiler catches a mistake versus where it
   doesn't.

## Concrete first steps

1. `cargo add leptos` (check current version — v0.9 is in alpha per the repo
   clone at `~/repos/leptos-rs/leptos`, decide 0.8 stable vs 0.9 alpha
   deliberately, don't default silently).
2. Scaffold `mvp/frontend-leptos` alongside `frontend` and `frontend-rs`,
   `trunk`-based like `frontend-rs` (check whether Leptos's own CSR-only
   tooling differs from trunk before assuming reuse).
3. Port `Transport` first, test it decodes real `ServerMsg` frames against the
   existing fixtures the wire crate already has.
4. Port `Rail` second — it's the smallest concern and the one both other
   builds used to prove the fold pattern first.
5. Only then conversation, approvals, upload.

## Write the finding, not just the code

The existing `frontend-comparison.md` is the model: axis by axis, with
verdicts, not a build log. Whatever gets written after this build should sit
next to it (`docs/mvp/frontend-comparison-leptos.md` or folded into the
existing doc as a third column) — Stephen reads these to decide what Tower
actually ships with, so the reasoning matters more than the code.
