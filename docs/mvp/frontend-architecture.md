# Tower frontend architecture — message-passing, owned concerns

Step 0 of the rearchitecture: the design both builds implement — the refactored
Svelte app and the Rust-WASM app. **Language-neutral on purpose.** Holding the
architecture constant across both is what lets the side-by-side isolate *what the
language buys* (enforcement, shared wire types) from *what the architecture buys*
(isolation). Decisions are recorded as decisions, with the road not taken named.

Nothing here changes behaviour or touches towerd. It is boundaries, not
behaviour — the investigations found propagation already correct (push, via
frames); the only sin is that every concern shares one mutable reactive surface
on one thread, so a fault anywhere freezes everything (the async-`$state`
incident). This doc removes the sharing.

## The principle

Share by communicating, not by sharing memory. Each concern owns its state;
concerns learn of change through **events**, never by reaching into a shared
store. The deeper reason is authorship: distributed discipline has no external
corrector, and once LLMs write the bulk, the easy path wins. So the *structure*
must carry the isolation — as much as the language will enforce, and by module
boundary where it won't — so neither a human nor an LLM has to remember it.

## The shape

- **Transport** — the one shared thing. Owns the socket, decodes each frame into
  a typed **event**, dispatches events, owns request/response correlation (the
  pending-id maps) and connection state. It is the *only* thing that touches the
  wire, and it holds **no domain state**.
- **Events** — the wire frames, already typed (the `wire` crate / `types.ts`).
  Turning bytes into typed events is the transport's whole job; events are the
  vocabulary between transport and concerns.
- **Concerns** — each owns its state, subscribes to the events it cares about,
  folds its own state, and exposes a read-only view to its component(s). A
  concern never reads another concern's state. The concerns:
  - **rail** — rows + staleness sort + annotations (title/tag display).
  - **conversation** (one per open conv) — messages, streaming, queryState,
    liveQuery, pendingSay.
  - **approvals** — the asks.
  - **agents** — instances + attachments; liveness inputs.
  - **view** — tabs (name + open set) and whether the approvals view is
    showing. Tabs are shared, durable fleet state as of 19 Jul (`layout`/
    `set_layout` on the wire, towerd's `layout` table) — the tmux-attach
    model: every connected client sees the same tabs, live. Filters/grouping
    (`ViewConfig`) and which tab is active stay localStorage, deliberately:
    facts about the viewer, not the shared workspace.
- **Components** — render a concern's view. A component reads one concern (or a
  few), holds only its *own* local UI state (draft, scroll anchor, edit/upload
  buffers), and never reaches into the transport or another concern.
- **Clock** — an injected time source, separate from the re-render ticker (see
  Decision 1).

## Data flow

```
wire bytes → Transport.decode → typed Event → dispatch
           → each Concern folds its OWN state → Component renders the concern's view

request:  Component → concern action → Transport.send (id-correlated)
        → response Event → routed back to the originating concern
```

## The three decisions

### Decision 1 — the clock is an injected seam; tickers stay per-concern

Time is **core, not trivial**: the two hardest folds — liveness (alive/stranded,
`now` vs 3×pulse interval) and approval void (`now` vs lastPulse) — are time
verdicts against the client's own clock. That is the "whose inputs" answer: the
only fresh input is the clock.

**Decision:** a `Clock` (a `now()` source) is injected into the concerns that
compute time verdicts, so those verdicts are testable deterministically — the
same reason you inject a clock for TDD. Separately, the re-render **ticker** (how
often a view recomputes) is a per-concern cadence detail (rail ~30s, approvals
~1s) and stays local to each concern.

*Not taken:* reading `now()` inline (today's `Date.now()` in getters) — the
verdicts become untestable. A single shared global clock — a thread back through
the walls, and unnecessary since the cadences already differ per concern. The
split matters: **ticker = cadence (local); clock = the value the verdict reads
(injected, testable).**

### Decision 2 — every concern is an owned store fed by events; sharing is a deliberate risk

Data enters the frontend exactly one way: the transport dispatches typed events,
and any state is built by folding them (the only other input is local user
action — draft, tabs). So a concern *is* a small owned store that folds its own
events; "events" and "a store" are not rival options — events are how any store
is fed. The only real axis is whether a store is **shared** by more than one
component (the hazard — a fault in the shared surface reaches every reader) or
**owned** by one (contained).

**Decision:** default to owned. Each concern folds its own events into its own
state; no store is shared across concerns by default. Sharing is not banned — it
is a **deliberate risk**, taken only where the cost of *not* sharing (duplicated
folds, consolidation debt) clearly outweighs the blast-radius risk, and named
when taken. The question is never "share or not" as dogma; it is "is this one
worth the risk?".

*Why the default is owned — the reversibility argument (the strongest reason):*
the two directions are not equally cheap to undo. Consolidating N owned folds
into one shared store is additive — they already fold the same events, you lift
the fold to one place and have them read it. Splitting a shared store is the hard
direction — find every reader, untangle who reads what, break the surface — which
is *literally this refactor*. So start owned: if it proves to be too much
duplication, consolidating is cheap; the expensive direction is the one we are
living now. That asymmetry sets the bar: share up front only with a reason strong
enough to outweigh giving up the cheap escape hatch.

*The strongest temptation to share is approvals* — the badge, the rail marker, a
conversation panel, and the approvals view all need it (four readers). Under the
default, each folds only what it needs: badge a count, rail the set-of-convs,
panel its own conv, view the full list. Honest cost recorded: the view
reconstructs the full map privately — events remove the *sharing*, not the
*data*. Accepted, because sharing is the hazard, not holding — and if that
duplication ever bites, consolidating those four into one approvals store is the
cheap reverse.

*Not taken:* a shared approvals store as the default — simpler today, but it
keeps a shared reactive surface (narrow, but the exact category we are removing)
and it is the expensive direction to undo. "Four readers" alone does not clear
the bar, because the reverse is cheap; the risk would need a reason we do not yet
have.

### Decision 3 — no DI container; the transport is the one singleton

DI earns its keep when async services multiply at a composition root — in
CircuitBreaker: auth, Apollo, App Insights, async in a sync world, wired at the
root. Tower's frontend has one WS transport and no async-service soup, so DI's
trigger does not fire. And with events as the communication there is no shared
service graph to wire, so DI has nothing to do.

**Decision:** the transport is a single constructed instance; concerns are
constructed and subscribe; components read concerns. A plain module singleton is
sufficient — no container, no `I`-interfaces yet.

*Not taken:* interfaces + DI (the CB house style) — correct there for the reasons
above, ceremony here. Revisit **when** async services arrive (auth, a second
transport), not before — tower's own rule: a seam appears at the second
implementation. The question was never "do we need DI," it is "*when*."

## Ownership rules — the invariants that carry the isolation

These are what the structure must enforce (in Rust: the compiler; in Svelte:
module boundaries plus the LLM-extension test below):

1. Only the **transport** touches the wire.
2. A concern owns its state; **no concern reads another concern's state** —
   cross-concern needs travel as events.
3. A component reads its concern(s) and owns only local UI state; it never
   reaches into the transport or another concern.
4. Time verdicts read the injected **clock**; nothing reads a global `now()`
   inline.
5. **Optimism** is confined: a concern may echo an *owned-fact* ahead of
   confirmation (pendingSay, tag/title) and MUST reconcile it against the
   authoritative event (the committed `message`, the next `list`). Never
   optimistically compute a *fold*.

## Held constant (not changing)

Propagation stays push (frames); no refetch is introduced; the client-side folds
stay client-side because their inputs are the client's own (liveness, void,
queryState — design doc: "liveness is a fold, never declared"; ws-spec: "query
state is the client's knowledge"). towerd is untouched. Behaviour is preserved.

## The slice for the side-by-side

Build only this, in both: **the rail + one conversation panel (with the say and
attachment-upload flow) + the approvals view.** The cut carries every shape *and*
the actual hazard:

- **every fold family** — server-fact (rows), client-clock verdict (liveness),
  own-history fold (queryState), optimistic reconcile (pendingSay), open-gated
  content (messages/streaming);
- **the shared-via-events hard case** — the approvals *view*, not just the badge.
  The badge is a trivial count; the view is where "each folds its own → the view
  privately rebuilds the whole map" actually bites, so it *exercises* Decision 2
  rather than merely asserting it;
- **the thing that crashed the app** — the attachment-upload flow: async
  `addFiles`, a local buffer, an optimistic write. The freeze was here (a
  `$state` write across an `await`). A slice that omits it tests everything
  except the hazard we are building walls against — so if the architecture
  cannot structurally stop that recurring, it has not earned itself.

Everything else in the app is more of these same shapes.

## The comparison axes (why we build it twice)

- **Enforcement** — try to make an LLM violate a boundary (a component reaching
  into another concern's state). Does it *compile*? This is the thesis test.
- **Shared wire types** — Rust shares the `wire` crate (drift impossible); does
  the Svelte `types.ts` drift from the spec?
- **Render surface** — idle cost and DOM affordances (retained-mode either way;
  the render path for Rust — DOM-from-Rust vs own canvas graph — is decided at
  Rust-build time and does not affect this architecture).
- **LLM-extension** — add a small feature to each finished slice carelessly, and
  see how well the boundary survives.

## Open / deferred

- The Rust render path (DOM-from-Rust vs canvas render graph) — a Rust-build
  decision, orthogonal to this architecture.
- How a "concern" is rendered per language (object, module, task) — a per-language
  detail; the doc stays neutral: a concern owns its state and folds its own events.
