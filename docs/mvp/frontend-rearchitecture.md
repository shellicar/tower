# Frontend re-architecture

## Why this exists

In July one frontend architecture was chosen and a different one was built.
This works out whether there is still a reason to prefer the one that was
chosen, given what exists now, by reading the code in both frontends. It is not
a proposal, and nothing needs to be built to answer it.

## What was asked for

Two properties:

1. "Which components receive these deltas" should be answerable by looking at
   the component.
2. A component and its subtree own their data, their logic and their
   rendering.

The alternative was described as keeping "the god-store shape in smaller
pieces".

## What was built

Both frontends have the same five concerns, each folding the frames it cares
about, with components reading from them. `lib/concerns/` in Svelte,
`src/concerns/` in Leptos.

The second property is present, mostly. `approvals` folds only
approvals. Nothing stores a shared derived value: the badge, the view and the
panel each ask for a different slice and each recomputes it.

The first is absent in both. The top of `ApprovalsView.svelte`:

```svelte
import { approvals, rail, view } from './app';
```

and the Leptos equivalent in `ui/approvals.rs`:

```rust
rail.with(|r| r.row(&c).and_then(|row| row.title.clone()))
```

Neither names the frames that drive the component. Finding that out means
opening the concern and reading that it folds `approvals` and `approval`, that
"void" is computed against a clock this client owns, and that answering sends a
request whose result comes back as an ordinary `approval` event.

Under the property that was asked for, that would be at the top of the
component.

## What it would cost to change

Most of it costs nothing, and that is the finding. It holds in both frontends,
which is what makes it worth acting on rather than a quirk of one.

I grepped every rail use in both. Two kinds:

**Reads one row.** In Svelte, `ApprovalsView` uses `rail.row(conv)?.title` and
`ConversationPanel` uses `rail.row(oc.conv)` and `rail.setTitle`. In Leptos,
`ui/approvals.rs` and `ui/conversation.rs` do the same through `r.row(&c)`.

**Reads the whole set.** Three surfaces, the same three in both frontends,
though they do not read the same slices:

- `RowList.svelte` uses `ordered`, `pendingByConv`, `tagKeys`, `attachedOnly`,
  `staleConvs`, and `verdict(conv)` per row. `ui/rail.rs` uses the same six.
- `UnreadView.svelte` uses `staleRows`. `ui/unread.rs` uses `stale_rows()`.
- `App.svelte` uses `staleConvs` for the per-tab unread count and `staleRows`
  for the global unread toggle. `ui/tabs.rs` reads `stale_convs()` only; the
  Leptos global toggle lives in `ui/rail.rs` instead, inside the first surface.

Everything that reads one row already declares what it needs. Moving those to
component-owned state changes nothing about how much work happens; the
component asks for a conversation instead of reaching into a map for it.

So the entire cost of the change lands on three surfaces, and since it has to
happen in both frontends, on six components: `RowList.svelte`,
`UnreadView.svelte`, `App.svelte`, `ui/rail.rs`, `ui/unread.rs` and
`ui/tabs.rs`.

### Leptos has the sharper version of the problem

In Svelte the rail holds several separate `$state` fields, so reading `ordered`
tracks `#rows` and nothing else. In Leptos the whole rail is one signal, and
`rail.with(...)` subscribes the reader to all of it.

There is a comment in `ui/rail.rs` at line 337 saying so:

```rust
let pending = rail.with(|r| r.pending_by_conv(now.get()));
// Computed once per render, then a plain lookup per row
// below — not a fresh `rail.with()` closure per row, which
// would re-subscribe every row to the WHOLE rail signal
// and recompute on any unrelated mutation (an agent pulse...)
```

That is the granularity problem, written down by whoever hit it, worked around
by hand, in the surface that would carry the cost of changing. Nothing enforces
that workaround: the next person writing a row renderer can reintroduce it by
putting a `rail.with` where it reads naturally.

## The two components, written both ways

`RowList` today, verbatim from lines 28 and 32, with `staleConvs` read inline in
the template at line 236:

```svelte
const visible = $derived(rail.ordered.filter(matches));
const pendingByConv = $derived(rail.pendingByConv);
```

Getters over state the rail already holds. The rail folds `list`, `row`,
`agents`, `agent`, `approvals`, `approval`, `stale_conversations`,
`stale_conversation` and `attachment_dismissed` once, for everyone.

`RowList` folding for itself:

```svelte
const rows    = fold('list', 'row');                    // a Map, sorted
const pending = fold('approvals', 'approval');          // a Set of conv ids
const stale   = fold('stale_conversations', 'stale_conversation');
const agents  = fold('agents', 'agent', 'attachment_dismissed');
const tagKeys = fold('list');                           // tagKeys rides on list
```

Do not read that as five lines against three. Each `fold` above stands for the
body the rail runs today: `list` replaces the map, `row` upserts by conversation
and preserves fields the frame omits, `agent` has to reconcile attachment
against row presence. The five folds the sample declares span `rail.svelte.ts`
lines 42 to 155, about a hundred and fourteen lines, and that is the cost.

`UnreadView` needs the rows and stale folds, lines 42 to 60 and 138 to 147,
about thirty of those lines. `App.svelte` needs the same thirty; `ui/tabs.rs`
needs the stale fold alone, about ten. So the stale fold exists three times in
each frontend, the rows fold three times in Svelte and twice in Leptos, and the
rest once, in the rail surface alone.

Three copies of the row set in memory in Svelte, two in Leptos. A `RowState` is
small (conv id, title, timestamps, a tag record), so at two thousand
conversations that is a few hundred kilobytes each time.

There is a middle option. The rail keeps folding once, and a component asks for
the slice it wants:

```svelte
const rows    = rail.subscribeOrdered();
const pending = rail.subscribePending();
```

No duplicated folding, and each subscriber invalidates on its own. `670a950`
already moved conversations part of the way here, for a different reason.

Be clear about what it does not give. The July property was that a component
states which deltas reach it. `fold('list', 'row')` says that literally.
`rail.subscribeOrdered()` says which slice the component wants, and learning
that `ordered` is driven by `list` and `row` still means opening the rail.

So the middle buys the invalidation and a declaration of appetite. It buys some
of the legibility and not all of it.

## What this says

Two properties were asked for. One is present. The other is missing, and getting
it costs two components changing shape, either by folding for themselves or by
asking the rail for a slice.

Nothing in the code argues against it. The thing that would have, the whole-set
derivations, lives in two of the four components that touch the rail in each
frontend.

What is left is a choice between two prices:

- **Component-folded.** The stale fold written three times in each frontend, the
  rows fold three times in Svelte and twice in Leptos, the rest once, and three
  copies of the row set in Svelte. In exchange the component names the frames
  that drive it, which is the property that was asked for.
- **The middle.** No duplication and no extra copies. The component declares
  which slice it wants, but not which frames produce it, so half the legibility
  that was asked for.

In Leptos the middle buys something extra that it does not buy in Svelte: a
subscription per slice instead of `rail.with` subscribing the reader to the
whole rail. That removes the hazard the comment at `ui/rail.rs:337` is working
around by hand.

Read that as a reason to weigh the middle for both, never as a reason to split
them. Whichever shape wins has to win in both frontends, for the same reason the
change itself does: they are only diagnostic while they are the same design.

The two versions of `RowList` above are what each price buys.

## What is not in this

Performance. `670a950` and `39140c9` fixed the two instances where one shared
container re-rendered everything, and neither is an argument for changing
anything now.

Behaviour. The domain objects do not change. Same rows, same conversations,
same frames on the wire, same folds over them. Only where they live changes.

Doing one frontend and not the other. Parity is architectural, not visual. Two
frontends are worth having because they are the same design in two languages,
which is what makes a difference between them diagnostic: it tells you whether
a problem is the framework or the design. Re-architect one and that is gone.

So this is a change to both or to neither.
