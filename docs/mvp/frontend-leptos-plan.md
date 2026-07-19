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

## Scope: two questions, one build

This build answers two things, not one — decided explicitly (2026-07-19),
reversing the earlier "match frontend-rs's slice, nothing more" scoping:

1. **The narrow axis comparison** — does a DOM-based Rust renderer keep the
   compile-time isolation and shared-wire-types wins while fixing egui's
   render costs (Axis 3)? This is what the original scope (below, the
   frontend-rs slice) answers on its own, and the four axes in "What to
   measure" still apply unchanged.
2. **Is Leptos a real candidate to actually replace Svelte** — which needs
   the *current* Svelte feature set covered, not the older frontend-rs slice.
   Svelte has grown a fifth concern and real features since this plan was
   first scoped (tabs/multi-open now shared fleet state on the wire, tags,
   usage/cost tracking, attachments, server-persisted dismiss) — none of
   which the original scope touched.

So the actual build target is Svelte's current full concern set, not the
frontend-rs slice:

- the staleness rail
- conversation panels: read messages, say, cancel, attach — **multiple, in
  tabs**, matching Svelte's current shared/durable layout (moved onto the
  wire, not local UI state)
- the approvals view: answer, dismiss
- **usage** — the fifth concern (`usage.svelte.ts` + `pricing.ts` in Svelte):
  per-conversation cost tracking, not in the original four-concern list
- **tags** — flat key:value annotations, group-by, filtering, coloured keys
- **attachments** — paste-to-attach, multi-file chips, upload
- **dismiss** — persisted server-side, a real annotation not local state

The four-axis measurement still runs against this fuller build unchanged —
more concerns is more material for Axis 4 (survival under careless
extension), not a different framework.

## Concern shape to carry over

Five concerns now, same contract, ported to Leptos signals instead of
`$state` runes or plain structs (Svelte's own shape — `concerns/rail.svelte.ts`,
`conversation.svelte.ts`, `approvals.svelte.ts`, `usage.svelte.ts`,
`view.svelte.ts` — is the reference for what each one owns):

- `Transport` — owns the socket only. `web-sys`/`gloo-net` WebSocket (or
  Leptos's own wrapper if one exists — check, don't assume) instead of
  `ewebsock`. Still no domain state.
- `Rail`, `Conversations`, `Approvals`, `Usage`, `View` — each a struct of
  signals, each folding its own slice of `ServerMsg` via the same
  `apply(&mut self, &ServerMsg)` shape the other two builds use. `View` owns
  tabs/layout (shared, durable, on the wire now, not local storage) — the one
  concern with no egui-side precedent to check against, since frontend-rs
  never built it; Svelte's `view.svelte.ts` is the only prior reference.
  Whether Leptos's ownership model (`RwSignal`/`ReadSignal`+`WriteSignal`,
  scopes) forces a different shape than egui's plain `&mut self` is itself a
  finding worth writing down — don't fight the framework to force a literal
  match.
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
5. Then `Conversations` (read, say, cancel, attach) and `Approvals` (answer,
   dismiss) — the frontend-rs slice; Axis-1-through-3 findings can be written
   up as soon as these land, without waiting for the rest.
6. Then `View` (tabs/layout), `Usage`, tags, attachments — the part that
   answers question 2 (a real Svelte replacement, not just the axis
   comparison). `View` first among these: `Conversations`/`Approvals` render
   inside tabs, so it's the natural next dependency, not an independent add-on.

## Write the finding, not just the code

The existing `frontend-comparison.md` is the model: axis by axis, with
verdicts, not a build log. Whatever gets written after this build should sit
next to it (`docs/mvp/frontend-comparison-leptos.md` or folded into the
existing doc as a third column) — Stephen reads these to decide what Tower
actually ships with, so the reasoning matters more than the code.
