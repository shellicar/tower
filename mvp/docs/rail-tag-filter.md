# Rail tag filter

The decision record for the tag filter work on `fix/facet-value-list`. Read this to check
the code against what was actually agreed, and to write the changelog entries or a
`DECISIONS.md` line.

## Problem statement

The rail's filter row lists a tag key's values as selectable badges. Three defects, all
observed live.

The badges reorder between renders. Three values each holding a count of 1 come out in a
different order every time anything happens.

A selected value that drops to zero matching rows disappears from the list, so it cannot
be deselected. The rail goes on filtering by something with nothing on screen to turn off,
and it survives a reload because the config persists.

There is no way to filter to "conversations with no value for this key".

## Solution

One rule for what the list contains and how it is ordered, computed by a pure function
that a test can reach, in both frontends.

## Requirements

Each records something the Supreme Commander said or agreed. Anything in the code not
covered here was not agreed; see "What is mine".

1. **Count descending is not in question.** Only the tiebreak is being added, and it is
   alphabetical. His words on being asked what the order should be: "do you think i care?
   alphabetically, what other option is there? rng? ... nothing is questioning the count
   descending, only the badges dancing around for no reason."
2. **The list is the union of what is available and what is selected.** "the tags shown
   needs to be a set of what's set and what's available".
3. **A selected value with no matching rows shows as `(0)`.**
4. **There is an untagged entry**, shown when its count is above zero or when it is
   selected. "there's also no (untagged) for the filters, which should show if count
   untagged > 0 (or set as per the previous rule)".
5. **The absence of a value is null, not a string.** `(untagged)` is a presentation-level
   fact applied at the badge. "it should be null, (untagged) is a presentation level fact
   ... so if i created a tag named (untagged) they should not be combined. yes i know that
   means there'd be two entries."
6. **Sorting is logic, not presentation.** The null entry has no string of its own and
   must not borrow its rendered label to sort by. "they shouldnt be sorting on the string?
   thats my entire point ... sorting is *not* presentation." Strings compare
   lexicographically among themselves and null sorts after all of them, which puts a
   literal `(untagged)` early and the null entry last:

   ```
   (untagged)
   a
   b
   c
   (untagged)
   ```

7. **Logic does not live in the UI.** "the UI stuff should be presentation concerns, not
   logic". The value list and the row matching both move out of the render layer.
8. **Grouping is held to the same rule.** Sections were keyed by the rendered label, so a
   row with no value and a row genuinely tagged `(untagged)` merged into one. "the
   behaviour should be clear, they are not equivalent, (untagged) is a *presentation*-level
   fact, the end."
9. **The existing config is migrated** rather than reset.
10. **No changelog entry for the grouping fix.** "no, there's no user facing behaviour."
11. **Changelog entries are prose, action first, in the reader's terms.** They are too long
    otherwise, "facet filter" is not user-facing vocabulary, and describing the new state
    of the world is the wrong shape. The words that survived his review:

    - Allow filtering for conversations missing a tag.
    - Stop tags randomly changing order in the filter.
    - Allow clearing a filter that no conversations match.

## Decisions

**Absence is null throughout the logic.** A sentinel string lives in the same namespace as
real values, so the two become indistinguishable to every filter. The substitution used to
happen inside the matching predicate, which is why a row with no `repo` tag and a row
tagged `repo: (untagged)` matched the same selection.

**Null is never compared as a string.** This was arrived at the wrong way first. Having
made the null entry sort where its label would sort, the two entries then tied on both
count and rendered string, and the fix reached for was an arbitrary rule to break the tie.
The Supreme Commander's correction is the general one: ask what the thing actually is. A
null is not a string, so it was never in the lexicographic ordering, and the tie did not
exist. Ordering null after every string is total on its own and needs no special case.

**No migration for a persisted `"(untagged)"` selection.** Checked against the data rather
than reasoned about: the `tags` table holds 343 rows over 57 distinct values, none
containing `untagged` or a parenthesis. The string also could never have entered a saved
config, because no badge for it has ever existed to click.

**Both frontends move together.** `frontend-svelte` and `frontend-leptos` are held at
deliberate parity. `frontend-rs` has no view concern and never filters by tags, so it is
untouched.

## What is mine, not yours

Read this before trusting the code against the requirements above. Everything here was
decided by Claude and never put to the Supreme Commander.

- The module name, its placement, the function signature and the `FacetValue` shape.
- Distinguishing the flat group from the no-value group. Leptos carries a nested optional
  on `Section`; Svelte derives a separate section key because two sections can now render
  the same label. Both are the operator's calls.
- The scope boundary that grouping was excluded. The brief asserted "grouping needs no
  change" on the strength of a quick read that missed the label becoming the map key. It
  was wrong, and stating it as fact is what stopped the operator finding the defect.
  Caught in review, not by the brief.
- The rejected tiebreak described above. It is not in the code.

## Out of scope

Tab identity, per-tab config keying, `alwaysShow` becoming global, and allowing zero tabs.
Those are `rail-tabs.md`, and were deliberately kept out of this branch.

Browser test infrastructure. See `frontend-test-gaps.md`.

Rewriting the older changelog entries into the new style. That is a curation pass, not
this work.

## State

Branch `fix/facet-value-list`, pull request 74, an open draft at `6e0c4c6`. All checks
were green at that commit and it merged cleanly, but `main` has moved since, so it needs
merging again before it lands.

The Supreme Commander ran it and accepted the behaviour.

Two things outstanding:

- The pull request's title and body are stale. They still say "facet value list" and
  describe only the value list, not the grouping or the lifted matching. Neither Claude
  nor the operator can edit them: the structured GitHub tool cannot read its keychain
  credential. The `gh` CLI is authenticated, but the tool is the approval gate, so the CLI
  is not a route around it.
- Whether to lift grouping out of the view so its fix can be tested. The value list and
  the row matching are both covered; grouping is the one behaviour in this branch that
  ships on a reading of the diff. Lifting it follows the ruling in requirement 7. Whether
  it belongs in this branch or a later one is undecided.
