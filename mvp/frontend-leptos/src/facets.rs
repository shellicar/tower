//! The facet value list for one expanded tag key, pure so it tests without a
//! render — mirroring mvp/frontend-svelte's core/facets.ts. The absence of a
//! value is `None` all the way through the logic; `(untagged)` is a label the
//! view applies, so a row with no `repo` tag and a row tagged
//! `repo: (untagged)` stay distinguishable.

use std::cmp::Ordering;
use std::collections::HashMap;

use ws_types::WsRow;

/// A tag's value on a row, or `None` when the row carries no such tag.
pub fn tag_of<'a>(row: &'a WsRow, key: &str) -> Option<&'a str> {
    row.tags.get(key).map(String::as_str)
}

/// OR within a key, AND across keys — tags are flat. A selected `None`
/// matches a row carrying no value for that key, and nothing else.
pub fn matches(row: &WsRow, filters: &HashMap<String, Vec<Option<String>>>) -> bool {
    filters
        .iter()
        .all(|(k, vs)| vs.is_empty() || vs.iter().any(|v| v.as_deref() == tag_of(row, k)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FacetValue {
    pub value: Option<String>,
    pub count: usize,
}

/// Strings lexicographically, the no-value entry after all of them.
fn compare_values(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (Some(x), Some(y)) => x.cmp(y),
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
    }
}

/// The selectable values for `key`: the union of the values present in the
/// counted rows and the values currently selected, so a selection that no
/// longer matches anything shows with a count of 0 rather than stranding
/// itself out of reach.
///
/// Counts honour the OTHER keys' filters and the caller's state filters
/// (live/unread), which is why `state_matches` is passed in rather than read.
pub fn facet_values(
    rows: &[&WsRow],
    key: &str,
    filters: &HashMap<String, Vec<Option<String>>>,
    state_matches: impl Fn(&str) -> bool,
) -> Vec<FacetValue> {
    let mut counts: HashMap<Option<String>, usize> = HashMap::new();
    if let Some(selected) = filters.get(key) {
        for value in selected {
            counts.entry(value.clone()).or_insert(0);
        }
    }
    for row in rows {
        if !state_matches(&row.conv) {
            continue;
        }
        let others_match = filters.iter().all(|(k, vs)| {
            k == key || vs.is_empty() || vs.iter().any(|v| v.as_deref() == tag_of(row, k))
        });
        if !others_match {
            continue;
        }
        *counts
            .entry(tag_of(row, key).map(str::to_owned))
            .or_insert(0) += 1;
    }
    let mut values: Vec<FacetValue> = counts
        .into_iter()
        .map(|(value, count)| FacetValue { value, count })
        .collect();
    values.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| compare_values(a.value.as_deref(), b.value.as_deref()))
    });
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(conv: &str, tags: &[(&str, &str)]) -> WsRow {
        WsRow {
            conv: conv.to_owned(),
            last_event: 0,
            last_kind: "message".to_owned(),
            title: None,
            tags: tags
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
        }
    }

    fn value(v: &str, count: usize) -> FacetValue {
        FacetValue {
            value: Some(v.to_owned()),
            count,
        }
    }

    fn no_value(count: usize) -> FacetValue {
        FacetValue { value: None, count }
    }

    fn filters(entries: &[(&str, &[Option<&str>])]) -> HashMap<String, Vec<Option<String>>> {
        entries
            .iter()
            .map(|(k, vs)| {
                (
                    (*k).to_owned(),
                    vs.iter().map(|v| v.map(str::to_owned)).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn admits_a_row_whose_value_is_selected() {
        let expected = true;

        let actual = matches(
            &row("1", &[("repo", "a")]),
            &filters(&[("repo", &[Some("a"), Some("b")])]),
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_a_row_whose_value_is_not_selected() {
        let expected = false;

        let actual = matches(
            &row("1", &[("repo", "c")]),
            &filters(&[("repo", &[Some("a"), Some("b")])]),
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn ignores_a_key_whose_filter_selects_nothing() {
        let expected = true;

        let actual = matches(&row("1", &[("repo", "a")]), &filters(&[("repo", &[])]));

        assert_eq!(actual, expected);
    }

    #[test]
    fn admits_a_row_with_no_value_for_the_key_when_none_is_selected() {
        let expected = true;

        let actual = matches(&row("1", &[]), &filters(&[("repo", &[None])]));

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_a_row_tagged_untagged_when_none_is_selected() {
        let expected = false;

        let actual = matches(
            &row("1", &[("repo", "(untagged)")]),
            &filters(&[("repo", &[None])]),
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_a_row_with_no_value_for_the_key_when_untagged_is_selected() {
        let expected = false;

        let actual = matches(&row("1", &[]), &filters(&[("repo", &[Some("(untagged)")])]));

        assert_eq!(actual, expected);
    }

    #[test]
    fn requires_every_key_to_match() {
        let expected = false;

        let actual = matches(
            &row("1", &[("repo", "a"), ("world", "y")]),
            &filters(&[("repo", &[Some("a")]), ("world", &[Some("x")])]),
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn breaks_a_tie_on_the_value_lexicographically() {
        let expected = vec![value("a", 1), value("b", 1), value("c", 1)];
        let rows = [
            row("1", &[("repo", "b")]),
            row("2", &[("repo", "c")]),
            row("3", &[("repo", "a")]),
        ];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn sorts_the_no_value_entry_after_every_string_at_an_equal_count() {
        let expected = vec![value("a", 1), value("z", 1), no_value(1)];
        let rows = [
            row("1", &[]),
            row("2", &[("repo", "z")]),
            row("3", &[("repo", "a")]),
        ];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_rows_with_no_value_for_the_key_under_the_no_value_entry() {
        let expected = vec![no_value(2), value("a", 1)];
        let rows = [row("1", &[]), row("2", &[]), row("3", &[("repo", "a")])];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn keeps_a_selected_value_with_no_matching_rows_at_a_count_of_zero() {
        let expected = vec![value("a", 1), value("gone", 0)];
        let rows = [row("1", &[("repo", "a")])];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[("repo", &[Some("a"), Some("gone")])]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn keeps_the_no_value_entry_when_it_is_selected_and_nothing_matches_it() {
        let expected = vec![value("a", 1), no_value(0)];
        let rows = [row("1", &[("repo", "a")])];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[("repo", &[None])]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_a_literal_untagged_value_separately_from_the_no_value_entry() {
        let expected = vec![value("(untagged)", 1), value("zeta", 1), no_value(1)];
        let rows = [
            row("1", &[("repo", "(untagged)")]),
            row("2", &[("repo", "zeta")]),
            row("3", &[]),
        ];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_only_rows_matching_the_other_keys_filters() {
        let expected = vec![value("a", 1)];
        let rows = [
            row("1", &[("repo", "a"), ("world", "x")]),
            row("2", &[("repo", "b"), ("world", "y")]),
        ];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[("world", &[Some("x")])]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn ignores_the_expanded_keys_own_filter_when_counting() {
        let expected = vec![value("a", 1), value("b", 1)];
        let rows = [row("1", &[("repo", "a")]), row("2", &[("repo", "b")])];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[("repo", &[Some("a")])]),
            |_| true,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_only_rows_the_state_filters_admit() {
        let expected = vec![value("a", 1)];
        let rows = [row("1", &[("repo", "a")]), row("2", &[("repo", "b")])];

        let actual = facet_values(
            &rows.iter().collect::<Vec<_>>(),
            "repo",
            &filters(&[]),
            |conv| conv == "1",
        );

        assert_eq!(actual, expected);
    }
}
