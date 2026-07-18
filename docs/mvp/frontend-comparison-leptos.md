# Leptos: a third read on what the language and the render surface buy

`mvp/frontend-leptos` is the third build against docs/mvp/frontend-architecture.md,
alongside the Svelte control (`mvp/frontend`) and the egui twin (`mvp/frontend-rs`,
written up in `frontend-comparison.md`). Same slice: the staleness rail, one
conversation panel with say/cancel/attach, the approvals view. This build asks the
question `frontend-comparison.md` left open: is egui's render cost (Axis 3) a property
of *Rust*, or a property of *egui*? Leptos is Rust with a real DOM, so it isolates that.

## The shape that carried over unchanged

Every concern (`rail.rs`, `conversation.rs`, `approvals.rs`) is byte-for-byte the same
fold logic as `frontend-rs`: same `apply(&mut self, &ServerMsg)` signature, same tests,
copied and compiling unmodified. That itself is the first finding, not a preamble to
one: the isolation architecture is provably render-framework-agnostic within Rust, not
just language-agnostic across Rust/TypeScript. `time.rs` is identical too, since neither
build has ever touched a real clock — both take `now` as an argument.

## Axis 1: enforcement — moves from compile-time to run-time, still a hard failure

egui's `apply(&mut self, &ServerMsg)` makes a cross-concern reach a type error: a
concern is never handed a reference to a sibling, so the violation cannot be written.
Leptos signals break that. `RwSignal<Rail>` is `Copy` and interior-mutable — any
closure that captures it can read or write it from anywhere, including from inside
another concern's code, and it **compiles**. The isolation in this build is a *module
convention* (concerns/rail.rs never imports concerns/approvals.rs), the same category
the Svelte rearchitecture relies on, not the category egui's ownership forces.

What Leptos gives back is a different, later backstop: a re-entrant borrow (writing to
a signal already borrowed on the call stack, e.g. from inside an `Effect` reading the
same signal) panics at runtime, in the browser console, immediately and loudly — not a
silent stale read. That happened once while building this: an early draft of the
composer's `Effect` wrote `draft` from inside a closure that also read it un-tracked in
the same tick, and Leptos's `BorrowMutError` pointed at the exact line. So the failure
mode is: compile-time in egui, panic-fast at runtime in Leptos, silent-until-observed in
Svelte's shared store. Leptos sits between the other two, not at either end.

Verdict: the thesis (Axis 1) does **not** hold the same way here. egui's ownership
model is what bought the compile-time guarantee, not "writing the render in Rust." A
DOM-capable Rust renderer with a signal graph reopens the god-store risk the whole
architecture exists to close — contained today only by the same discipline Svelte
leans on, with a faster failure mode as consolation, not a replacement.

## Axis 2: shared wire types — confirmed, a non-finding as predicted

`ws-types` dropped in as an unmodified path dependency, exactly like `frontend-rs`. No
`ClientMsg`/`ServerMsg`/`WsRow`/etc. needed touching. This is not surprising — it is
towerd's Rust-ness that buys it, not the render layer — and the plan predicted exactly
this, calling it out only if it turned out otherwise. It didn't.

## Axis 3: render surface — the axis this build exists to move, and it moved

This is the real result. A genuine DOM:
- Browser find (Cmd/Ctrl-F), right-click, text selection, and link handling all work,
  because the messages are real `<p>` text nodes, not painted glyphs.
- The tofu-glyph problem egui hit on the rail's status dots does not exist — `"◆"`,
  `"⚠"`, `"●"` are just characters in a `<span>`, rendered by the browser's own font
  stack.
- The DOM is inspectable with devtools like any other web page.

Idle cost is qualitatively the Svelte shape, not egui's: Leptos's reactive graph
updates only the DOM nodes whose signal dependencies changed (fine-grained, like Svelte
5 runes — no vdom diff, no per-frame repaint loop). There is no `request_repaint_after`
equivalent needed for redraw; the one polling loop in this build (`set_interval`, 1s) is
there only because two verdicts (liveness, approval-void) are pure functions of wall
clock against held facts, not wire events — the same reason `frontend-rs` re-evaluates
every frame and Svelte used to (`heat`/`liveness` interval-boxes). Nothing else ticks. A
proper idle-CPU/memory number needs a running browser tab under profiling, which this
session didn't do; the structural claim (no per-frame repaint, real DOM, no tofu) is
what the plan asked to confirm and is confirmed by inspection of what actually
executes, not measured empirically here.

Verdict: Axis 3 moves as predicted. egui's cost was egui's, not Rust's.

## Axis 4: survival under careless extension — the same build-in-sequence method

Conversation, then approvals, then upload were added in sequence, each as "a fold + a
render block + wiring in the composition root." What recurred:

- **The native/wasm check gap is identical to egui's.** `app.rs` and `uploads.rs` are
  `#[cfg(target_arch = "wasm32")]`; native `cargo test`/`cargo clippy` compile and pass
  cleanly (27 tests, zero warnings) without ever touching the render or the upload
  path. Only `trunk build` exercises them. This is not a Leptos-specific trap — it's the
  same wasm-only-module trap `frontend-comparison.md` already named for egui, confirmed
  to recur regardless of render framework.
- **The borrow-checker friction moved from render-time to render-macro-time, and got
  weirder.** egui's pain was: mutate inside a render closure → doesn't compile → learn
  the deferred-action pattern. Leptos's `view!` macro has its own version: closures
  passed to `.map()`/`.collect_view()` inside a `view!` block silently need to *own*,
  not borrow, their data, because the returned `View` can outlive the closure that built
  it. Borrowing `&Vec<WsMessage>` out of a `.with()` closure and iterating with `.iter()`
  fails with "returns a value referencing data owned by the current function" — not
  because of a real dangling reference (the underlying `RwSignal` outlives everything),
  but because the borrow checker can't see through `.with()`'s closure boundary into a
  `view!` macro's expansion. The fix both times in this build was the same: clone out of
  the signal first (`c.get(&conv).map(|oc| oc.messages.clone())`), then build views from
  owned data. This is *more* ceremony than egui's deferred-action pattern, not less, and
  it is a harder error to read (a lifetime error inside macro-expanded code) than egui's
  (a plain borrow-checker complaint at the call site).
- **The upload path lost its concurrency-boundary purity, mildly.** `frontend-rs`'s
  upload is spawned once and returns over an `mpsc` channel, drained each egui frame —
  the maxim (share by communicating) applied cleanly. This build's `uploads::pick_and_upload`
  takes an `on_done` callback instead of a channel, because there is no per-frame drain
  loop to poll one — Leptos is push-based, so the natural shape is "call me back," which
  then closes over `conversations` (a signal) directly. That is still communicating, not
  a shared mutable write across an await (no `$state`-across-`await` freeze is possible:
  the callback fires as a discrete reactive update, same as any signal `.set()`), but
  it is a callback closing over a signal, not a message drained on a boundary — a softer
  version of the channel discipline than either other build uses.

Verdict: careless extension does not fail as loudly as egui's. It fails either at
compile time (borrow errors, but harder to diagnose through the macro) or at runtime
(a `BorrowMutError` panic, immediate but late). The wasm-only check gap is real and
identical to egui's — worth the same warning to future work here.

## The finding that wasn't on the list: the render macro is a lifetime boundary

Neither the Svelte control nor the egui twin has anything like `view!`'s
closure-capturing-into-a-macro behavior — Svelte has no macro, egui's `Ui::label` etc.
take arguments immediately, not deferred closures. Leptos's fine-grained reactivity
requires deferring "how to render this" into closures the reactive graph can re-run
later, and that deferral is exactly where borrowed data stops working. This is a real
cost specific to this render model, not seen in either sibling build, and it is worth
knowing before extending this codebase further: **default to cloning out of a signal
before building a `view!` list**, not borrowing.

## The balance

What Leptos bought over egui, holding the architecture constant:

- A real DOM (Axis 3): browser find/select/right-click, no tofu glyphs, an inspectable
  tree. This is the axis the plan set out to move, and it moved.
- Idle-cost shape closer to Svelte's fine-grained update than egui's per-frame repaint,
  by construction (not empirically profiled this session).
- The wire-type sharing win (Axis 2) carries over unchanged, as expected.

What it cost, against egui:

- The enforcement thesis (Axis 1) weakens: signals reopen the shared-mutable-handle
  risk egui's ownership closed by construction. What's left is convention (module
  boundaries) plus a runtime panic as a late backstop, not a compile error.
- A harder-to-read class of borrow error, inside `view!`'s macro expansion, that costs
  more ceremony to work around (clone-before-view) than egui's deferred-action pattern.
- The wasm-only native-check gap recurs unchanged — this is a lesson about any
  trunk/wasm Rust frontend, not this framework specifically.

What stays open: a real idle-CPU/memory number against the ~175MB/several-%-CPU egui
figure and the ~55MB/near-zero Svelte figure, which needs a running browser tab, not
static inspection. And whether the `view!` ergonomics are a Leptos 0.8 rough edge or
inherent to fine-grained-reactive Rust — worth revisiting against `leptos_dom`'s own
`COMMON_BUGS.md` if this build continues.

## Running it

```sh
docker compose up -d                    # broker, if not already up (mvp/)
cargo run -p towerd                     # from mvp/, TOWER_BIND defaults to 127.0.0.1:8081
cd frontend-leptos && trunk serve       # http://127.0.0.1:8080, proxies /ws and /ref to towerd
```
