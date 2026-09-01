// core/facets.ts — the facet value list for one expanded tag key, pure so it
// tests without a render. The absence of a value is `null` all the way
// through the logic; `(untagged)` is a label the view applies, so a row with
// no `repo` tag and a row tagged `repo: (untagged)` stay distinguishable.

import type { RowState } from '../types';

/** A tag's value on a row, or `null` when the row carries no such tag. */
export function tagOf(row: RowState, key: string): string | null {
  return row.tags?.[key] ?? null;
}

export interface FacetValue {
  value: string | null;
  count: number;
}

/** Strings lexicographically, the no-value entry after all of them. */
function compareValues(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * The selectable values for `key`: the union of the values present in the
 * counted rows and the values currently selected, so a selection that no
 * longer matches anything shows with a count of 0 rather than stranding
 * itself out of reach.
 *
 * Counts honour the OTHER keys' filters and the caller's state filters
 * (live/unread), which is why `stateMatches` is passed in rather than read.
 */
export function facetValues(
  rows: readonly RowState[],
  key: string,
  filters: Record<string, readonly (string | null)[]>,
  stateMatches: (conv: string) => boolean,
): FacetValue[] {
  const counts = new Map<string | null, number>();
  for (const selected of filters[key] ?? []) counts.set(selected, 0);
  for (const row of rows) {
    if (!stateMatches(row.conv)) continue;
    const othersMatch = Object.entries(filters).every(
      ([k, vs]) => k === key || vs.length === 0 || vs.includes(tagOf(row, k)),
    );
    if (!othersMatch) continue;
    const value = tagOf(row, key);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || compareValues(a.value, b.value));
}
