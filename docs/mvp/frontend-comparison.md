# Svelte vs Rust-WASM: what the language bought

The frontend was built twice against one architecture (docs/mvp/frontend-architecture.md):
the refactored Svelte app (`mvp/frontend`, the control) and a Rust-WASM twin
(`mvp/frontend-rs`). Holding the architecture constant was the point: it isolates what
the *language* buys from what the *design* buys. This is the read on the four axes the
architecture doc named, plus two findings that only surfaced in the building.

Both apps implement the same slice: the staleness rail, one conversation panel with say
and attachment upload, and the approvals view. The Rust side is egui/eframe over
ewebsock, folds tested natively, render built to wasm with trunk.

## The shape that emerged: fan-out, not subscriptions

The Svelte control dispatches typed events and each concern subscribes to the ones it
cares about. The Rust twin does not subscribe. Each frame, the transport drains the
socket into an owned `Vec<ServerMsg>`, and the app offers every frame to every concern's
`apply(&mut self, &ServerMsg)`. Each concern's own `match` decides what it folds.

This inverts the intuition you carry from Svelte, and the reason is the borrow checker.
The frontend is single-threaded wasm: there is no concurrency between concerns. A
subscription table (callbacks each holding `&mut` to a different concern, stored
centrally) does not compile without `Rc<RefCell<...>>`, and that defers the borrow check
to runtime, where a double-borrow panics. That is the god-store hazard reborn in a new
wrapper: a fault reaching across a shared mutable surface, caught late. Fan-out has none
of it. So the seam that *looks* thinner (subscriptions) is the trap here; fan-out is the
idiomatic single-thread shape.

## Axis 1: enforcement (the thesis)

Can a careless author make one concern reach into another's state? In Rust, no, and not
by discipline: by the type. `apply(&mut self, &ServerMsg)` hands a concern a mutable
borrow of *only itself* and a read-only frame. To touch a sibling it would need a
reference to that sibling, and it holds none. The violation is not caught in review; it
cannot be written.

The composition root (the app) is the exception, and correctly so. It owns every concern
as a field and wires them, because someone must. The Supreme Commander's framing held:
the hand is allowed to know the fingers; the fingers must not know each other. Fan-out
gives exactly that split, and gives it for free, because a concern is never handed the
reference in the first place.

The Svelte control removed the shared store, so the *design* prevents the reach. But the
prevention is module boundary plus convention: a concern *could* import another's store
and mutate it, and it would compile. The original freeze (a `$state` write mutated across
an `await`) was this class of fault. The rearchitecture makes it unlikely; Rust makes the
category unrepresentable.

Verdict: the clearest language win. It is the thesis, and it holds.

## Axis 2: shared wire types

Rust shares the WS contract as a crate, `mvp/crates/ws-types`. towerd serialises
`ServerMsg` and parses `ClientMsg`; the frontend does the mirror. There is one definition.
A change on either side that the other does not match is a compile error, not a runtime
surprise.

We lived this, not hypothetically. Two things proved it:

- Extracting the contract forced the `outcome` fields and `WsAgent.kind` from
  `&'static str` to `String`, because a type that must *deserialise* on the frontend
  cannot borrow a static. The shared type turned a latent asymmetry into a correctness
  fix the compiler demanded.
- While the branch was open, the usage/cost work landed on main and added a `usage`
  frame to towerd's `ws.rs`. The rebase conflict could only be resolved by moving the
  usage types (`WsUsage`, the `Usage` variant) *into* ws-types. Both sides picked them up
  at once; the frontend folds that do not care about usage ignore it through their `_ =>`
  arm. Drift was not avoided by care. It was impossible by construction.

The Svelte control mirrors the same contract by hand in `types.ts`. It can drift silently:
rename a field in towerd, forget the copy, and it still compiles and breaks at runtime.

Verdict: a decisive win, and notably *not* about rendering. It is a shared crate versus a
hand copy. A Rust frontend earns it because towerd is also Rust; a TypeScript frontend
cannot import a Rust crate, so the copy is the price of the language split, not of Svelte.

## Axis 3: render surface

egui is immediate mode: the render pulls every frame, there is no reactive graph, and a
concern is plain owned data folded by value. That is what makes the isolation cheap. It
also sets the costs.

- Idle cost is immediate-mode's. The app repaints on a cadence (`request_repaint_after`,
  100ms) rather than only on change. The POC measured the order of it: an egui tab near
  175MB and several percent CPU at idle against an SPA at ~55MB and a fraction of a
  percent.
- DOM affordances are lost: browser-native find, right-click, links, an inspectable DOM,
  and the full nuance of text selection. Tower is text-heavy, so these matter for a real
  build, not a demo.
- A concrete instance surfaced: the rail's status glyphs (the heat dot, the liveness
  diamond, the pending warning) render as tofu boxes in egui's default font. The colour
  comes through, the glyph does not. That is free in the DOM and a real (small) task in
  egui: draw shapes, or ship a glyph font.

The important qualifier: the architecture is render-agnostic. The concern-to-render seam
is "the render reads the concerns." egui makes that a pull each frame; a retained DOM or
reactive Rust renderer would make it a push. So the render surface is a swappable choice
that sits *below* the thesis, not part of it. egui is the fast way to prove the
separation, not necessarily the renderer a shipped Tower would keep.

Verdict: a cost, but a contained and swappable one. It weighs on "would you ship this
renderer," not on "does the architecture work."

## Axis 4: survival under careless extension

The build itself was the experiment: three concerns and their surfaces were added in
sequence (conversation, approvals, upload), each as "a struct, an `apply`, and wiring in
the app." Two things recurred.

- The compiler caught every cross-concern mistake loudly. When `rail.row` was trimmed and
  the panel later read it, the build failed at the exact call. A concern touching a
  sibling was never even written, because the type did not offer the reference. Careless
  extension fails closed.
- One trap is a build-configuration gap, not an architecture one, and it is worth naming
  because it bites: `app.rs` and `uploads.rs` are `#[cfg(target_arch = "wasm32")]`, and
  the native `main` is a stub, so native `clippy` and `test` do not check them. Only
  `trunk build` does. Green native is not green. An LLM extending the render can pass
  every native check and still have a broken wasm build.

There is an honest cost against Svelte's legibility. Because the render only reads and may
not mutate, actions (open, say, cancel, answer) are gathered during the render and applied
after it, to satisfy the borrow checker. A careless author who writes
`self.conversations.say(...)` inside a render closure gets a borrow error and must learn
the deferred-action pattern. The compiler is enforcing correctness, but at a step of
indirection that Svelte's direct event handlers do not pay.

Verdict: the boundary survives careless extension in Rust because violations do not
compile; the price is a less direct render and a wasm-only check surface to remember.

## The finding that was not on the list: the maxim, exactly twice

"Do not communicate by sharing memory; share memory by communicating" is a concurrency
idiom, and the frontend has exactly two concurrency boundaries. Both use channels, and
nothing else does.

- The socket. ewebsock already models it the idiom's way: a channel pair, drained by
  `try_recv` each frame. The library hands us the maxim for free.
- The attachment upload (`mvp/frontend-rs/src/uploads.rs`). The async work (file pick via
  rfd, HTTP POST via ehttp) is spawned, and its result returns to the app over an
  `mpsc` channel, drained each frame and folded into the conversation concern like any
  wire frame.

Between concerns there is no concurrency, so the idiom does not apply there: it is
ownership, not channels. Forcing channels between concerns would cargo-cult towerd's
backend idiom into a place that lacks towerd's problem (towerd has real threads; the
frontend does not).

This matters most at the upload, which was the Svelte crash-site: an async `addFiles` that
mutated `$state` across an `await`. In immediate mode the upload result arrives as a
*message*, not a shared write, and there is no reactive flush to abort. The freeze cannot
recur. That is the exact hazard the experiment was set up to test, and the architecture
makes it structurally absent rather than merely unlikely.

## The read/write asymmetry

Rust splits access by reference kind, and that resolves the architecture's hardest
decision cheaply. Writes isolate in `apply` (`&mut self`); reads are free (`&`), so the
render holds `&` to every concern at once and reads several while drawing. The panel reads
`rail.row(conv)` for its header while drawing the conversation concern: two concerns read
together, both shared borrows, no shared store.

So Decision 2 (shared versus owned, and its "annotations shared" hard case) is largely
moot for reads in Rust. The Svelte hazard was reads and writes travelling through one
mutable reactive surface; Rust separates them by the type of borrow, and only writes need
the discipline, which the compiler supplies.

## The balance

What Rust bought, holding the architecture constant:

- Concern isolation the compiler enforces (Axis 1), the thesis, confirmed.
- A shared wire contract that cannot drift (Axis 2), because towerd is Rust too.
- The async-freeze class made structurally impossible (the maxim finding).
- The shared-versus-owned decision reduced to a non-issue for reads (the asymmetry).

What it cost:

- A heavier, less browser-native render surface (Axis 3), swappable but real.
- More ceremony in the render (deferred actions) and a wasm-only check surface to
  remember (Axis 4).
- A language the SC is less fluent in than TypeScript, which weighs on the axis no
  benchmark measures: which codebase he most wants to read and reshape.

What stays contextual, not settled here: which app is more legible, and whether egui is
the renderer a shipped Tower would keep or just the fastest way to prove the separation.
The architecture is render-agnostic by design, so that last question can be answered later
without disturbing anything above it.
