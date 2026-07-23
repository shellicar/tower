//! The path-scoped permission matrix (permissions-spec): an ordered list of
//! location patterns, each naming an operation → verdict table. First match
//! wins — same discipline as a firewall's rule chain, not a fixed
//! inside/outside grid — so a deploy can carve out anything (`~/.ssh/**`)
//! ahead of the general rules without a schema change. The list is expected
//! to end in a `*` catch-all; if it doesn't, an unmatched path resolves to
//! `Ask`, never `Allow` — absence of a match is never evidence of safety.
//!
//! One action can touch more than one path (`Delete`'s array); `resolve_set`
//! folds the whole set to its strictest verdict, one path or many, same
//! mechanism either way.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

/// `Allow < Ask < Deny` by derive order — `Ord::max` across a set picks the
/// strictest verdict without a bespoke comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    Ask,
    Deny,
}

/// One rule: a location pattern, an optional blanket `default` for any
/// operation it doesn't name explicitly, and whatever named operations
/// (`read`, `write`, `delete`, `exec`, ...) it wants to override. Operation
/// is an open label, never a fixed enum — a new tool just introduces a new
/// key, nothing here constrains what exists.
#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    #[serde(rename = "match")]
    pub pattern: String,
    pub default: Option<Verdict>,
    #[serde(flatten)]
    pub operations: HashMap<String, Verdict>,
}

/// The whole ordered list, as delivered by a `permissions` control line —
/// one scoped blob, sent whole, replacing whatever was there. No partial
/// edits: whoever configures this already holds the full list.
#[derive(Debug, Clone, Deserialize)]
pub struct PermissionSet(pub Vec<Rule>);

impl PermissionSet {
    /// Before any `permissions` line ever arrives: the strictest possible
    /// baseline, identical to bridge's behavior before this matrix existed
    /// — every gated operation asks. Not a guessed convenience default;
    /// bridge legitimately needs *some* verdict for every call, and "ask"
    /// is the only one that never silently permits or silently blocks.
    pub fn strict_default() -> Self {
        PermissionSet(vec![Rule {
            pattern: "*".to_string(),
            default: Some(Verdict::Ask),
            operations: HashMap::new(),
        }])
    }

    /// Expand `$PWD`/`$HOME`/a leading `~` in a rule's own pattern, then
    /// test whether `path` falls under it. A trailing `/**` matches any
    /// depth below; otherwise the expanded pattern is a plain prefix —
    /// enough for `$PWD`, `$HOME`, `~/.ssh/**`, `*` without a glob crate.
    /// Tilde expands against the SAME `home` parameter as `$HOME`, never a
    /// fresh env lookup (`crate::expand_tilde` reads the real `$HOME`
    /// directly, which would silently disagree with a caller-supplied
    /// `home` — exactly the bug a test caught: one consistent notion of
    /// "home" for every token, or none of this is testable in isolation).
    fn matches(pattern: &str, path: &Path, cwd: &Path, home: &Path) -> bool {
        if pattern == "*" {
            return true;
        }
        let expanded = pattern
            .replace("$PWD", &cwd.to_string_lossy())
            .replace("$HOME", &home.to_string_lossy());
        let expanded = if let Some(rest) = expanded.strip_prefix("~/") {
            home.join(rest)
        } else if expanded == "~" {
            home.to_path_buf()
        } else {
            std::path::PathBuf::from(expanded)
        };
        let base = expanded.to_string_lossy();
        let base = base.strip_suffix("/**").unwrap_or(&base);
        path.starts_with(base)
    }

    /// One (path, operation) check. The first matching rule governs
    /// entirely — its named operation, or its own `default`, or (a
    /// misconfigured rule naming neither) `Ask`. A rule matching but not
    /// covering this operation does NOT fall through to a less specific
    /// rule; that would break first-match-wins the same way a firewall
    /// rule chain would if a matched rule could be silently skipped.
    pub fn resolve_one(&self, path: &Path, operation: &str, cwd: &Path, home: &Path) -> Verdict {
        for rule in &self.0 {
            if Self::matches(&rule.pattern, path, cwd, home) {
                return rule
                    .operations
                    .get(operation)
                    .copied()
                    .or(rule.default)
                    .unwrap_or(Verdict::Ask);
            }
        }
        // No rule matched at all (a list with no catch-all): unmatched
        // must resolve to the strictest option, never Allow.
        Verdict::Ask
    }

    /// The full set an action touches, folded to its strictest verdict —
    /// `Delete`'s path array, or a single-path tool's one-item set, same
    /// mechanism either way.
    pub fn resolve_set<'a>(
        &self,
        paths: impl Iterator<Item = &'a Path>,
        operation: &str,
        cwd: &Path,
        home: &Path,
    ) -> Verdict {
        paths
            .map(|p| self.resolve_one(p, operation, cwd, home))
            .max()
            .unwrap_or(Verdict::Ask)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn cwd() -> PathBuf {
        PathBuf::from("/home/stephen/repos/proj")
    }
    fn home() -> PathBuf {
        PathBuf::from("/home/stephen")
    }

    fn parse(json: &str) -> PermissionSet {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn an_unconfigured_set_asks_for_everything() {
        let set = PermissionSet::strict_default();
        let verdict = set.resolve_one(&cwd().join("a.rs"), "read", &cwd(), &home());
        assert_eq!(verdict, Verdict::Ask);
    }

    #[test]
    fn the_first_matching_rule_governs_even_when_it_omits_this_operation() {
        // $PWD matches first; it says nothing about "delete" and has no
        // default, so this must be Ask, never fall through to `*`'s deny.
        let set = parse(
            r#"[
                { "match": "$PWD", "read": "allow" },
                { "match": "*", "default": "deny" }
            ]"#,
        );
        let verdict = set.resolve_one(&cwd().join("a.rs"), "delete", &cwd(), &home());
        assert_eq!(verdict, Verdict::Ask);
    }

    #[test]
    fn default_covers_unnamed_operations_within_a_rule() {
        let set = parse(r#"[{ "match": "$PWD", "default": "allow", "delete": "ask" }]"#);
        let inside = cwd().join("a.rs");
        assert_eq!(
            set.resolve_one(&inside, "write", &cwd(), &home()),
            Verdict::Allow
        );
        assert_eq!(
            set.resolve_one(&inside, "delete", &cwd(), &home()),
            Verdict::Ask
        );
    }

    #[test]
    fn a_carve_out_ahead_of_pwd_wins_over_it() {
        let set = parse(
            r#"[
                { "match": "~/.ssh/**", "default": "deny" },
                { "match": "$PWD", "default": "allow" },
                { "match": "*", "default": "ask" }
            ]"#,
        );
        let ssh_key = home().join(".ssh/id_ed25519");
        assert_eq!(
            set.resolve_one(&ssh_key, "read", &cwd(), &home()),
            Verdict::Deny
        );
    }

    #[test]
    fn outside_cwd_falls_to_the_catch_all() {
        let set = parse(
            r#"[
                { "match": "$PWD", "default": "allow" },
                { "match": "*", "read": "allow", "write": "ask", "delete": "deny" }
            ]"#,
        );
        let elsewhere = PathBuf::from("/tmp/other/file.txt");
        assert_eq!(
            set.resolve_one(&elsewhere, "delete", &cwd(), &home()),
            Verdict::Deny
        );
    }

    #[test]
    fn a_multi_path_action_resolves_to_its_strictest_member() {
        let set = parse(
            r#"[
                { "match": "$PWD", "default": "allow" },
                { "match": "*", "default": "deny" }
            ]"#,
        );
        let paths = [cwd().join("a.rs"), PathBuf::from("/tmp/b.rs")];
        let verdict = set.resolve_set(
            paths.iter().map(PathBuf::as_path),
            "delete",
            &cwd(),
            &home(),
        );
        assert_eq!(verdict, Verdict::Deny);
    }
}
