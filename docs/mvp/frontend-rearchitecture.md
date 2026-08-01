# Frontend re-architecture

Whether tower's frontends should move from concern-owned state to
component-owned state, and how that would be decided by measurement rather
than by argument.

Written 1 August 2026 from the Flightrac work, where the same three shapes
were built and compared. Nothing here is a proposal to act on yet: it is the
analysis and the experiment that would settle it.

## The shape today

`mvp/frontend-svelte/src/lib/concerns/` holds `rail`, `conversation`,
`approvals`, `usage` and `view`. Each is a module singleton that folds the
frames it cares about and exposes getters. Components import a concern and
read it: `ConversationPanel` reads `conversations.get(conv)`, the header badge
reads `approvals.pendingApprovals`, the rail reads `rail.staleConvs`.

The state is encapsulated: private fields, getters, methods. No component can
assign into a concern. So the failure mode is not corruption.

The failure mode is granularity. One reactive container read by many
components invalidates all of them together.

## The evidence, from this repo's own history

- `670a950` — "Give each open conversation its own reactive entry instead of
  one shared map." Typing a single character updated a shared map and every
  panel re-rendered. The fix splits the container so a write reaches one
  reader.
- `39140c9` — "Key the streaming render by segment." The same class of
  problem, one level down, inside a component.

Both are repairs to the consequence. The cause is that several components read
one container, and the container is what changes.

Note also that the Svelte and Leptos sides needed different remedies for the
same diagnosis: Svelte's keyed `{#each}` already isolates per item, so its
instance of the fault was the shared map alone. That difference is only
visible because both exist.

## What the alternative is

A component subscribes to the frames it cares about, folds them into state it
alone owns, and coordinates with other components by events.

```ts
// today
const oc = conversations.get(conv);

// the alternative
const oc = subscribeConversation(conv);  // this panel's own state
```

Concretely for tower:

- `ConversationPanel` subscribes to the frames for its own conversation. A
  keystroke's frame is delivered to that panel and to nothing else.
- `ApprovalsView`, the header badge and the rail marker each subscribe to
  `approval` frames and fold what they need. Three folds of the same stream,
  which cannot disagree, because frames arrive once in one order.
- The selected tab, the open conversations, and anything else that is "what
  the user just did" are events rather than stored state.

The things this makes harder are the derivations across the whole set: the
rail needs every row, stale counts span conversations. Each becomes a
component folding the whole stream for itself. That is more duplicated folding
than the concern shape, and whether it is acceptable is one of the things to
measure.

## Why not a rewrite

The bugs that motivated this were fixed. `670a950` reached per-conversation
granularity from the other direction, so the remaining benefit is prevention
of the next instance rather than repair of a current one. Against that: two
frontends, a working tool in daily use, and no new capability at the end.

The two shapes coexist. A component can subscribe to the transport directly
while the concerns remain for everything else. So the question is not whether
to rewrite but whether to build the next surface the new way, and migrate an
existing one to compare.

## How it would be evaluated

Tower has something Flightrac did not: a built-in control group. Two frontends
render the same data from the same socket. Migrate one, leave the other, and
every measurement has a paired comparison under identical conditions.

The axes, in the order they matter:

1. **Which components re-render when one frame arrives.** This is the whole
   argument. Everything else is secondary.
2. **CPU while typing**, with several conversations open. The original
   symptom.
3. **Memory**, since per-component folding duplicates state.
4. **What a component tells you when you read it.** Whether the frames it
   receives are visible at its top, or have to be traced through a concern.
5. **What it costs to add a surface.** One file, or a file plus a concern
   change.

## How it would be verified

Not by reasoning. By instrumenting the running app and reading numbers, the
same way the memory question was settled in Flightrac — where the first result
contradicted the prediction and turned out to be a framework property, not an
architectural one.

**Render counting.** Give every surface a small footer showing how many times
it has rendered and which frame it last handled. Open six conversations, type
one character into one of them, and read the counters.

- Today, the prediction is that every panel's counter advances.
- Under component-owned, one panel's advances.

That single measurement is the thesis, and it either holds or it does not.

**Frame delivery counting.** Count frames delivered per component, not just
renders. Distinguishes "the component was told and chose not to change" from
"the component was never told", which are different properties.

**CPU under load.** The existing idle CPU numbers in this repo (`5b6e6e1`)
give a baseline. Repeat under typing with N conversations open, before and
after, on both frontends. Migrate the Leptos side first and hold Svelte as the
control.

**Memory with N conversations open.** Per-component folding means several
components each holding a copy. In Flightrac this cost about 4 MB per
duplicate copy of a 20,000 sample document and was not a deciding factor.
Tower's conversations are larger and there are more of them, so this is the
measurement most likely to say no.

Be careful with this one specifically: in Flightrac the first memory numbers
pointed the wrong way entirely, and the cause was Svelte deep-proxying large
objects rather than anything architectural. One line of `$state.raw` moved
13 MB. Check that before concluding anything about the design.

**Reading the code.** Not a number, but do it deliberately and on the same
file in both shapes: open `ConversationPanel` before and after and ask what it
tells you about which frames it receives.

## What would falsify it

Worth writing down in advance, so the experiment can fail honestly.

- Render counts do not improve, because the concerns are already fine-grained
  enough after `670a950`.
- Memory grows unacceptably with conversations open, because the duplicated
  folds are large.
- The cross-set derivations (rail, stale counts) become materially worse to
  read than the single fold they replace.
- The two frontends diverge in shape, because the pattern turns out to be
  natural in one and awkward in the other.

## If it goes ahead

Migrate one surface, not the app. `ApprovalsView` is the candidate: it is
small, it has two other surfaces reading the same frames (the header badge and
the rail marker), so it exercises the duplicate-fold question immediately, and
it is not on the critical path if it goes wrong.

Measure before, migrate, measure after, on both frontends, with the
unmigrated one as the control.
