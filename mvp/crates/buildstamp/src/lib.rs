//! The stamp a binary answers "which commit am I?" with.
//!
//! Cargo already knows what a binary was compiled from: after a build,
//! `target/<profile>/<binary>.d` lists every local source file that went into
//! it, path dependencies and patched crates included. So the build computes
//! the stamp and hands it to a second build through the environment, and a
//! build script's whole job is to receive it.
//!
//! A stamp reads clean only when a `git status` ran and reported nothing over
//! that file list. An untracked file that is part of the build shows up as
//! `??` and counts; one that is not part of the build cannot change the
//! binary, so it does not.
//!
//! Cargo does not list `Cargo.lock` or the workspace manifest, which are
//! equally part of what compiles, so they are added to the checked set here.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Called by a binary crate's build script. Receives the stamp the build
/// handed it as `BUILDSTAMP_{prefix}`, and emits it as `{prefix}_GIT_HASH`.
pub fn emit(prefix: &str) {
    let handed_in = format!("BUILDSTAMP_{prefix}");
    println!("cargo:rerun-if-env-changed={handed_in}");

    let stamp = std::env::var(&handed_in)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(from_previous_build);

    println!("cargo:rustc-env={prefix}_GIT_HASH={stamp}");
    println!("cargo:rustc-env={prefix}_BUILD_TIME={}", build_time_utc());
}

/// The stamp for the binary that `dep_info` describes: cargo's
/// `target/<profile>/<binary>.d`, or the wasm target's own copy of it.
pub fn stamp(dep_info: &Path) -> String {
    // Absolute first: the walk up to the workspace root has to leave the
    // caller's working directory, and a relative path runs out of ancestors
    // before it gets there.
    let Ok(dep_info) = std::path::absolute(dep_info) else {
        return "unknown-dirty".to_string();
    };
    let dep_info = dep_info.as_path();
    let Some(workspace) = workspace_root(dep_info) else {
        return "unknown-dirty".to_string();
    };
    // Resolved, because git reports its own toplevel resolved: an unresolved
    // path through a symlinked parent reads as outside the repository, and
    // git rejects the whole status call rather than that one pathspec.
    let workspace = workspace.canonicalize().unwrap_or(workspace);
    let Some(hash) = git(&workspace, &["rev-parse", "--short", "HEAD"]) else {
        return "unknown-dirty".to_string();
    };
    let Some(repo) = git(&workspace, &["rev-parse", "--show-toplevel"]).map(PathBuf::from) else {
        return format!("{hash}-dirty");
    };
    match checked_paths(dep_info, &workspace, &repo) {
        Some(paths) if certified_clean(&repo, &paths) => hash,
        _ => format!("{hash}-dirty"),
    }
}

/// The files a `git status` has to answer for: what cargo recorded as
/// compiled, plus the lockfile and workspace manifest it does not record.
/// `None` when the dep-info is unreadable, which certifies nothing.
fn checked_paths(dep_info: &Path, workspace: &Path, repo: &Path) -> Option<Vec<PathBuf>> {
    let recorded = std::fs::read_to_string(dep_info).ok()?;
    // The list carries whatever build scripts declared, which can include
    // directories and paths outside the repository (a linked worktree's git
    // internals, for one). Git rejects the whole call over an outside path,
    // and a directory would drag in files that are not compiled.
    let mut paths: Vec<PathBuf> = compiled_files(&recorded)
        .into_iter()
        .map(|path| path.canonicalize().unwrap_or(path))
        .filter(|path| path.starts_with(repo) && !path.is_dir())
        .collect();
    paths.push(workspace.join("Cargo.lock"));
    paths.push(workspace.join("Cargo.toml"));
    Some(paths)
}

fn compiled_files(dep_info: &str) -> Vec<PathBuf> {
    dep_info
        .lines()
        .filter_map(dependency_list)
        .flat_map(split_escaped)
        .map(PathBuf::from)
        .collect()
}

/// The right-hand side of a dep-info line: `<output>: <file> <file>`. The
/// colon that ends the output is the one followed by whitespace, which the
/// colon in a Windows drive letter never is.
fn dependency_list(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let end = (0..bytes.len())
        .find(|&i| bytes[i] == b':' && bytes.get(i + 1).is_none_or(|c| c.is_ascii_whitespace()))?;
    Some(&line[end + 1..])
}

/// Whitespace separates paths, and a backslash before a space escapes it.
/// A backslash anywhere else is a Windows path separator, not an escape.
fn split_escaped(list: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut current = String::new();
    let mut chars = list.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&' ') => {
                current.push(' ');
                chars.next();
            }
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    paths.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        paths.push(current);
    }
    paths
}

/// The directory holding `Cargo.lock`, walking up from the dep-info file.
fn workspace_root(dep_info: &Path) -> Option<PathBuf> {
    dep_info
        .ancestors()
        .skip(1)
        .find(|dir| dir.join("Cargo.lock").is_file())
        .map(Path::to_path_buf)
}

/// Only a status that ran and reported nothing certifies clean.
fn certified_clean(repo: &Path, paths: &[PathBuf]) -> bool {
    let mut status = git_command(repo);
    status.arg("status").arg("--porcelain").arg("--");
    for path in paths {
        status.arg(path);
    }
    match status.output() {
        Ok(out) if out.status.success() => out.stdout.is_empty(),
        _ => false,
    }
}

/// Git, with the settings this check refuses to inherit.
///
/// `status.showUntrackedFiles=no` in a user's config would hide exactly the
/// files the design rests on noticing, and the stamp would then certify clean
/// over a file nobody committed. A claim about a commit must not depend on
/// settings on the machine that made it.
///
/// `--no-optional-locks` because a build script has no business writing the
/// index, which `git status` otherwise does to refresh it.
fn git_command(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        .arg("--no-optional-locks")
        .args(["-c", "status.showUntrackedFiles=normal"]);
    command
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git_command(dir).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// No stamp was handed in, so this is a bare `cargo build`. The previous
/// build's dep-info still names what this binary compiles, which is at worst
/// one build out of date and beats stamping nothing at all.
fn from_previous_build() -> String {
    match dep_info_beside_out_dir() {
        Some(dep_info) => stamp(&dep_info),
        None => "unknown-dirty".to_string(),
    }
}

/// `OUT_DIR` is `<profile-dir>/build/<pkg>-<hash>/out`, so the dep-info sits
/// three levels up under the binary's name.
fn dep_info_beside_out_dir() -> Option<PathBuf> {
    let out_dir = std::env::var_os("OUT_DIR")?;
    let profile_dir = Path::new(&out_dir).ancestors().nth(3)?;
    let package = std::env::var("CARGO_PKG_NAME").ok()?;
    Some(profile_dir.join(format!("{package}.d")))
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
mod compiled_files {
    use super::compiled_files;
    use std::path::PathBuf;

    #[test]
    fn reads_the_files_after_the_output() {
        let expected = vec![
            PathBuf::from("/repo/app/build.rs"),
            PathBuf::from("/repo/app/src/main.rs"),
        ];

        let actual =
            compiled_files("/repo/target/debug/app: /repo/app/build.rs /repo/app/src/main.rs\n");

        assert_eq!(actual, expected);
    }

    #[test]
    fn keeps_a_windows_drive_letter_out_of_the_split() {
        let expected = vec![PathBuf::from(r"C:\repo\app\src\main.rs")];

        let actual =
            compiled_files("C:\\repo\\target\\debug\\app.exe: C:\\repo\\app\\src\\main.rs\n");

        assert_eq!(actual, expected);
    }

    #[test]
    fn unescapes_a_space_in_a_path() {
        let expected = vec![PathBuf::from("/repo/my dir/main.rs")];

        let actual = compiled_files("/repo/target/debug/app: /repo/my\\ dir/main.rs\n");

        assert_eq!(actual, expected);
    }

    #[test]
    fn ignores_a_line_with_no_dependencies() {
        let expected: Vec<PathBuf> = Vec::new();

        let actual = compiled_files("/repo/app/src/main.rs:\n");

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
