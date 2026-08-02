# Frontend re-architecture

## Why this exists

In July you asked for one frontend architecture and got another. Claude argued
you out of it and you accepted the argument.

This works out whether you were right, by reading the code that exists in both
frontends. It is not a proposal, and nothing needs to be built to answer it.

## What you asked for

Two things, in your words:

1. "Which components receive these deltas" should be answerable by looking at
   the component.
2. A component and its subtree own their data, their logic and their
   rendering.

You also said the alternative "keeps the god-store shape in smaller pieces".

## What you got

Both frontends have the same five concerns, each folding the frames it cares
about, with components reading from them. `lib/concerns/` in Svelte,
`src/concerns/` in Leptos.

You got the second thing you asked for, mostly. `approvals` folds only
approvals. Nothing stores a shared derived value: the badge, the view and the
panel each ask for a different slice and each recomputes it.

You did not get the first thing, in either. Here is the top of
`ApprovalsView.svelte`:

```svelte
import { approvals, rail, view } from './app';
```

and the Leptos equivalent in `ui/approvals.rs`:

```rust
rail.with(|r| r.row(&c).and_then(|row| row.title.clone()))
```

Neither tells you which frames drive the component. To find out you open the
concern and read that it folds `approvals` and `approval`, that "void" is
computed against a clock this client owns, and that answering sends a request
whose result comes back as an ordinary `approval` event.

Under what you asked for, that would be at the top of the component.

## What it would cost to change

Most of it costs nothing, and that is the finding. It holds in both frontends,
which is what makes it worth acting on rather than a quirk of one.

I grepped every rail use in both. Two kinds:

**Reads one row.** In Svelte, `ApprovalsView` uses `rail.row(conv)?.title` and
`ConversationPanel` uses `rail.row(oc.conv)` and `rail.setTitle`. In Leptos,
`ui/approvals.rs` and `ui/conversation.rs` do the same through `r.row(&c)`.

**Reads the whole set.** Two surfaces, the same two in both frontends:

- `RowList.svelte` uses `ordered`, `pendingByConv`, `tagKeys`, `attachedOnly`,
  `staleConvs`, and `verdict(conv)` per row. `ui/rail.rs` uses the same six.
- `UnreadView.svelte` uses `staleRows`. `ui/unread.rs` uses `stale_rows()`.

Everything that reads one row already declares what it needs. Moving those to
component-owned state changes nothing about how much work happens; the
component asks for a conversation instead of reaching into a map for it.

So the entire cost of the change lands on two surfaces, and since it has to
happen in both frontends, on four components: `RowList.svelte`,
`UnreadView.svelte`, `ui/rail.rs` and `ui/unread.rs`.

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

`RowList` today:

```svelte
const rows = $derived(rail.ordered);
const pending = $derived(rail.pendingByConv);
const stale = $derived(rail.staleConvs);
```

Three getters over state the rail already holds. The rail folds `list`, `row`,
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
against row presence. That is `rail.svelte.ts` lines 42 to 60 and 138 to 147,
about forty lines, and it is the cost.

`UnreadView` needs two of the same folds, because `staleRows` is stale
conversations joined to rows. So those forty lines exist twice, in each
frontend.

Two copies of the row set in memory. A `RowState` is small — conv id, title,
timestamps, a tag record — so at two thousand conversations that is a few
hundred kilobytes, twice.

There is a middle option. The rail keeps folding once, and a component asks for
the slice it wants:

```svelte
const rows    = rail.subscribeOrdered();
const pending = rail.subscribePending();
```

No duplicated folding, and each subscriber invalidates on its own. `670a950`
already moved conversations part of the way here, for a different reason.

But be clear about what it does not give you. You asked in July that a component
tell you which deltas reach it. `fold('list', 'row')` says that literally.
`rail.subscribeOrdered()` says which slice the component wants, and to learn
that `ordered` is driven by `list` and `row` you still open the rail.

So the middle buys the invalidation and a declaration of appetite. It buys some
of the legibility and not all of it.

## What this says

You asked for two properties. One is present. The other is missing, and getting
it costs two components changing shape, either by folding for themselves or by
asking the rail for a slice.

Nothing in the code argues against it. The thing that would have, the whole-set
derivations, lives in two of the four components that touch the rail in each
frontend.

What is left is a choice between two prices:

- **Component-folded.** About forty lines of folding duplicated across two
  surfaces in each frontend, and a second copy of the row set. In exchange the
  component names the frames that drive it, which is what you asked for.
- **The middle.** No duplication and no second copy. The component declares
  which slice it wants, but not which frames produce it, so half the legibility
  you asked for.

In Leptos the middle buys something extra that it does not buy in Svelte: a
subscription per slice instead of `rail.with` subscribing the reader to the
whole rail. That removes the hazard the comment at `ui/rail.rs:337` is working
around by hand.

Read that as a reason to weigh the middle for both, never as a reason to split
them. Whichever shape wins has to win in both frontends, for the same reason the
change itself does: they are only diagnostic while they are the same design.

Read the two versions of `RowList` above and decide which of those you are
buying.

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
