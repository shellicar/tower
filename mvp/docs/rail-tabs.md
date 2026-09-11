# Rail tabs

The decision record for giving tabs an identity and allowing none of them. Fully
specified with the Supreme Commander, and not started: no branch, no code.

## Problem statement

A tab has no identity. It is addressed by its position in an array for which one is
active, and by its name for its filter configuration. Both change under you, and every
defect below is a symptom of that one cause.

A tab named `main` never loads its saved filters. The view concern is built with a
placeholder tab called `main` carrying a default config, before the socket connects and
before anyone knows whether the fleet has tabs. When the real layout arrives, the fold
re-attaches configuration by name and prefers what is already in memory, so the
placeholder's defaults win for any tab of that name and the loader is never called. The
settings are written on every edit and never read back.

Renaming a tab orphans its config under the old name. Creating a tab can inherit a config
saved by an unrelated tab that happened to share an auto-generated name. Two tabs with the
same name share one entry.

Which tab is in front is stored as an array index, so another client closing a tab in
front of yours silently moves you to a different one.

Separately: what a conversation row displays is per tab when it should not be, and the
last tab cannot be closed.

## Solution

Mint a stable id for a tab and key everything off it. Move the display settings out of tab
state. Delete the placeholder and let a tab set be empty.

## User stories

1. As someone with no tabs open, I want the rail still to list conversations, so that I
   can see what is there before deciding to open anything.
2. As someone with no tabs open, I want clicking a conversation to create a tab holding
   it, so that I do not have to create an empty one first.
3. As someone who has closed every tab, I want my filters still set when I make the next
   one, so that closing a tab is not also throwing away how I had the rail sliced.
4. As someone renaming a tab, I want its filters to stay with it, so that naming a working
   view does not reset it.

## Requirements

Each records something the Supreme Commander said or agreed.

1. **Tabs need an identity.** "jesus, yes tabs need an identity".
2. **The placeholder goes and zero tabs is legal.** "does having a placeholder add any
   value? personally, i dont like the fact in browsers, that you *need* a tab, and this is
   basically the same feature."
3. **With no tabs the rail still lists conversations, and clicking one creates a tab.**
   "here is where a placeholder actually makes sense, you *click* a conversation with no
   tab, it creates the tab."
4. **The filter and group controls work with no tabs.** The configuration exists whether
   or not a tab does. "yes they should work, as soon as you create a tab, it would use
   that. the auto create main was a workaround for this very issue."
5. **The configuration model**, in his own framing:
   - Selecting a tab loads that tab's configuration as the current one.
   - Editing the configuration updates it.
   - Selecting a different tab loads that tab's.
   - Closing every tab leaves the configuration as it is, not cleared.
   - Creating a tab copies the current configuration onto it.
6. **`show` is global, not per tab.** "whatever i want to see on the conversations, doesnt
   change per tab, but the filter is for that tab only."
7. **`groupKey` is per tab**, and `hideUntagged` follows it. "groupKey could go either, but
   that affects *how* the rail is laid out, so i think per-tab."
8. **Where the configuration is stored is settled and is not being reopened.** It is local
   to the viewer, decided 19 July. "i dont really care about where this is stored, you are
   asking the wrong question, why do we need to change it?"
9. **The existing configuration is migrated** rather than reset.

## Decisions

**Per tab, keyed by tab id:** `filters`, `liveOnly`, `unreadOnly`, `groupKey`,
`hideUntagged`. **Global, one key:** `alwaysShow`.

**Which tab is active is tracked by id, not index.** It stays local to the viewer, on the
same footing as before; only its key changes.

**Removing the placeholder alone would fix the `main` defect.** Verified in both
frontends: with no default tab the held map is empty on the first fold, so every tab falls
through to the loader. This is why the two pieces below could be ordered either way.

**Order: identity first, then zero tabs.** Both rewrite the same functions in the view
concern, so splitting them costs more than doing them together would. Identity first means
the zero-tabs create-and-copy semantics are built against a key that is not about to
change, and the migration is only needed once identity lands.

## What is mine, not yours

- The split into two pieces of work and their order. The Supreme Commander accepted it
  rather than deciding it: "the order made sense to me, it doesn't bother me as long as
  you thought it through." The reasoning in the decision above is Claude's.
- Everything about how an id is minted, where it is stored, and how it travels on the
  wire. The layout is already an opaque JSON blob on the server, so nothing there needs a
  schema change, but that is an observation and not an agreed design.
- The claim that splitting these two costs more than combining them. It was assessed after
  the empty-state behaviour was specified, and never re-put to him.
- The section order and every phrasing in this document.

## Out of scope

The tag filter itself, which is `rail-tag-filter.md`.

Anything about the rail's conversation-id search, which landed separately on `main`.

## State

Nothing built. No branch, no worktree, no brief written. The specification above is
complete enough to brief an operator from.

One thing to check before starting: the `main` defect is described against the code as it
stood on 2 September. Confirm it still reproduces, because the view concern has been
touched since.
