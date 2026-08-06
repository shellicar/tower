//! The stamp a binary answers "which commit am I?" with, computed at build
//! time from git and baked in as environment variables.
//!
//! A bare hash is only worth anything if it can be trusted, so `-dirty` is
//! appended unless a `git status` actually ran and reported nothing: an
//! untracked `.rs` compiles like any other file, and a git that could not be
//! run has certified nothing. The status is scoped to the directories the
//! crate really compiles (itself plus its path dependencies, transitively),
//! so an edit to a crate this binary does not depend on leaves it clean.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Emit the stamp for the crate whose build script calls this, as
/// `{prefix}_GIT_HASH` and `{prefix}_BUILD_TIME`.
pub fn emit(prefix: &str) {
    let manifest_dir = PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR")
            .expect("cargo sets CARGO_MANIFEST_DIR for a build script"),
    );
    let footprint = footprint(&manifest_dir);

    let hash = git_short_hash(&manifest_dir);
    let dirty = hash.is_none() || !certified_clean(&manifest_dir, &footprint);
    let stamp = format!(
        "{}{}",
        hash.as_deref().unwrap_or("unknown"),
        if dirty { "-dirty" } else { "" }
    );

    println!("cargo:rustc-env={prefix}_GIT_HASH={stamp}");
    println!("cargo:rustc-env={prefix}_BUILD_TIME={}", build_time_utc());

    // Naming any rerun-if-changed switches off cargo's default of re-running
    // this script whenever a file in the package changes. So the source
    // directories have to be named alongside the git paths, or an unstaged
    // edit recompiles the code without recomputing the stamp, which is the
    // exact case the dirty marker exists for.
    for dir in &footprint {
        println!("cargo:rerun-if-changed={}", dir.display());
        println!(
            "cargo:rerun-if-changed={}",
            dir.join("Cargo.toml").display()
        );
    }
    // Resolved, not assumed: this repo works in linked worktrees, where .git
    // is a file and the worktree's own HEAD and index live elsewhere.
    if let Some(git_dir) = git_dir(&manifest_dir) {
        println!("cargo:rerun-if-changed={}", git_dir.join("HEAD").display());
        println!("cargo:rerun-if-changed={}", git_dir.join("index").display());
    }
}

/// The directories this crate compiles: its own, plus every path dependency
/// reachable from it. Everything in this workspace is a path dependency, so
/// the manifests answer this without a `cargo metadata` subprocess.
pub fn footprint(manifest_dir: &Path) -> BTreeSet<PathBuf> {
    let root = manifest_dir
        .canonicalize()
        .unwrap_or_else(|_| manifest_dir.to_path_buf());
    let mut resolved = BTreeSet::new();
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
        if !resolved.insert(dir.clone()) {
            continue;
        }
        for dep in dependency_paths(&dir) {
            if let Ok(dep) = dep.canonicalize()
                && !resolved.contains(&dep)
            {
                pending.push(dep);
            }
        }
    }
    resolved
}

fn dependency_paths(manifest_dir: &Path) -> Vec<PathBuf> {
    let Ok(manifest) = fs::read_to_string(manifest_dir.join("Cargo.toml")) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    let mut in_dependencies = false;
    for line in manifest.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_dependencies = is_dependencies_header(header.trim());
            continue;
        }
        if !in_dependencies || line.starts_with('#') {
            continue;
        }
        if let Some(path) = path_value(line) {
            paths.push(manifest_dir.join(path));
        }
    }
    paths
}

/// `[dependencies]`, `[dependencies.wire]`, and the target-specific forms,
/// but never dev- or build-dependencies, which no shipped binary contains.
/// Their hyphen is what excludes them: only a `.` before `dependencies` is a
/// table separator.
fn is_dependencies_header(header: &str) -> bool {
    header == "dependencies"
        || header.starts_with("dependencies.")
        || header.ends_with(".dependencies")
        || header.contains(".dependencies.")
}

fn path_value(line: &str) -> Option<&str> {
    let mut rest = line;
    loop {
        let key = rest.find("path")?;
        let own_key = key == 0
            || !matches!(rest.as_bytes()[key - 1], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-');
        rest = &rest[key + "path".len()..];
        if !own_key {
            continue;
        }
        let Some(value) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let Some(quoted) = value.trim_start().strip_prefix('"') else {
            continue;
        };
        if let Some(end) = quoted.find('"') {
            return Some(&quoted[..end]);
        }
    }
}

fn certified_clean(dir: &Path, footprint: &BTreeSet<PathBuf>) -> bool {
    let mut status = Command::new("git");
    status
        .current_dir(dir)
        .arg("status")
        .arg("--porcelain")
        .arg("--");
    for path in footprint {
        status.arg(path);
    }
    match status.output() {
        Ok(out) if out.status.success() => out.stdout.is_empty(),
        _ => false,
    }
}

fn git_short_hash(dir: &Path) -> Option<String> {
    git(dir, &["rev-parse", "--short", "HEAD"])
}

fn git_dir(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--absolute-git-dir"]).map(PathBuf::from)
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// From Rust, not a `date` subprocess: `date -u` is not a program on Windows
/// outside a bash shell, and CI builds Windows binaries.
fn build_time_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let time = secs.rem_euclid(86_400);
    let (hour, minute, second) = (time / 3600, (time % 3600) / 60, time % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant's civil_from_days: days since the unix epoch to a proleptic
/// Gregorian year/month/day, no leap-second table and no dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_position + 2) / 5 + 1) as u32;
    let month = (if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    }) as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod is_dependencies_header {
    use super::is_dependencies_header;

    #[test]
    fn accepts_the_dependencies_table() {
        let expected = true;

        let actual = is_dependencies_header("dependencies");

        assert_eq!(actual, expected);
    }

    #[test]
    fn accepts_a_single_dependency_table() {
        let expected = true;

        let actual = is_dependencies_header("dependencies.wire");

        assert_eq!(actual, expected);
    }

    #[test]
    fn accepts_a_target_specific_dependencies_table() {
        let expected = true;

        let actual = is_dependencies_header("target.'cfg(target_arch = \"wasm32\")'.dependencies");

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_dev_dependencies() {
        let expected = false;

        let actual = is_dependencies_header("dev-dependencies");

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_target_specific_dev_dependencies() {
        let expected = false;

        let actual = is_dependencies_header("target.'cfg(unix)'.dev-dependencies");

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_build_dependencies() {
        let expected = false;

        let actual = is_dependencies_header("build-dependencies");

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_an_unrelated_table() {
        let expected = false;

        let actual = is_dependencies_header("package");

        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod path_value {
    use super::path_value;

    #[test]
    fn reads_the_path_of_an_inline_table_dependency() {
        let expected = Some("../wire");

        let actual = path_value("wire = { path = \"../wire\" }");

        assert_eq!(actual, expected);
    }

    #[test]
    fn reads_the_path_when_other_keys_precede_it() {
        let expected = Some("../ws-types");

        let actual = path_value("ws-types = { version = \"0.1\", path = \"../ws-types\" }");

        assert_eq!(actual, expected);
    }

    #[test]
    fn reads_a_bare_path_key_of_a_single_dependency_table() {
        let expected = Some("../bridge");

        let actual = path_value("path = \"../bridge\"");

        assert_eq!(actual, expected);
    }

    #[test]
    fn ignores_a_key_that_merely_ends_in_path() {
        let expected = None;

        let actual = path_value("search-path = \"../elsewhere\"");

        assert_eq!(actual, expected);
    }

    #[test]
    fn ignores_a_dependency_without_a_path() {
        let expected = None;

        let actual = path_value("serde = { version = \"1\", features = [\"derive\"] }");

        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod civil_from_days {
    use super::civil_from_days;

    #[test]
    fn day_zero_is_the_unix_epoch() {
        let expected = (1970, 1, 1);

        let actual = civil_from_days(0);

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_into_the_month() {
        let expected = (1970, 2, 1);

        let actual = civil_from_days(31);

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_a_common_year() {
        let expected = (1971, 1, 1);

        let actual = civil_from_days(365);

        assert_eq!(actual, expected);
    }

    #[test]
    fn counts_a_leap_year() {
        let expected = (1973, 1, 1);

        let actual = civil_from_days(1096);

        assert_eq!(actual, expected);
    }

    #[test]
    fn resolves_a_leap_day() {
        let expected = (1972, 2, 29);

        let actual = civil_from_days(789);

        assert_eq!(actual, expected);
    }
}
