//! A conversation's working directory. Each served conversation owns one
//! live cell in `ServedCwds`; `chdir` is the only thing that ever moves one.
//! The instance's own default (what a spawn/adopt with no `cwd` takes) is a
//! separate value the caller owns and passes into `resolve_cwd` — this
//! module never reads the process's actual directory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use crate::expand_tilde;

/// Every conversation this instance serves, keyed to its own live cwd cell.
pub type ServedCwds = Arc<RwLock<HashMap<String, Arc<RwLock<PathBuf>>>>>;

/// A spawn/adopt's own `cwd` field: `None` takes `default`; a named path is
/// validated, not silently accepted — a typo here is cheaper to catch now
/// than as a confusing permission denial on the conversation's first tool
/// call.
pub fn resolve_cwd(raw: Option<&str>, default: &Path) -> Result<PathBuf, String> {
    match raw {
        Some(raw) => validate_dir(&expand_tilde(raw)),
        None => Ok(default.to_path_buf()),
    }
}

/// Canonicalize a path and confirm it's a directory. Also the instance-wide
/// `cwd` line's own check, since a named path there needs the same rule.
pub fn validate_dir(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path)
        .map_err(|e| {
            format!(
                "cwd {} does not exist or is unreadable: {e}",
                path.display()
            )
        })
        .and_then(|p| {
            if p.is_dir() {
                Ok(p)
            } else {
                Err(format!("cwd {} is not a directory", p.display()))
            }
        })
}

/// Why a `chdir` didn't move anything.
#[derive(Debug, PartialEq, Eq)]
pub enum ChdirError {
    NotFound,
    Invalid(String),
}

/// Move one served conversation's cwd cell. Leaves the cell untouched on an
/// invalid path.
pub fn apply_chdir(served: &ServedCwds, conv: &str, raw_cwd: &str) -> Result<PathBuf, ChdirError> {
    let cell = served
        .read()
        .unwrap()
        .get(conv)
        .map(Arc::clone)
        .ok_or(ChdirError::NotFound)?;
    let resolved = validate_dir(&expand_tilde(raw_cwd)).map_err(ChdirError::Invalid)?;
    *cell.write().unwrap() = resolved.clone();
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::{ChdirError, ServedCwds, apply_chdir, resolve_cwd};
    use std::collections::HashMap;
    use std::sync::{Arc, RwLock};

    fn scratch_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bridge-cwd-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        // Canonical, matching what resolve_cwd itself returns (macOS's
        // /tmp is a symlink into /private/tmp).
        std::fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn resolve_cwd_of_none_falls_back_to_the_given_default() {
        let expected = scratch_dir();
        let actual = resolve_cwd(None, &expected).unwrap();
        assert_eq!(actual, expected);
        std::fs::remove_dir(&expected).unwrap();
    }

    #[test]
    fn resolve_cwd_of_an_existing_directory_canonicalizes_it_ignoring_the_default() {
        let expected = scratch_dir();
        let unused_default = std::path::PathBuf::from("/does/not/matter");
        let actual = resolve_cwd(Some(expected.to_str().unwrap()), &unused_default).unwrap();
        assert_eq!(actual, expected);
        std::fs::remove_dir(&expected).unwrap();
    }

    #[test]
    fn resolve_cwd_of_a_missing_path_errors() {
        let missing =
            std::env::temp_dir().join(format!("bridge-cwd-missing-{}", uuid::Uuid::new_v4()));
        let actual = resolve_cwd(Some(missing.to_str().unwrap()), &std::env::temp_dir());
        assert!(actual.is_err());
    }

    #[test]
    fn resolve_cwd_of_a_file_not_a_directory_errors() {
        let file = std::env::temp_dir().join(format!("bridge-cwd-file-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"not a directory").unwrap();
        let actual = resolve_cwd(Some(file.to_str().unwrap()), &std::env::temp_dir());
        assert!(actual.is_err());
        std::fs::remove_file(&file).unwrap();
    }

    fn served_with(conv: &str, cwd: std::path::PathBuf) -> ServedCwds {
        let mut map = HashMap::new();
        map.insert(conv.to_string(), Arc::new(RwLock::new(cwd)));
        Arc::new(RwLock::new(map))
    }

    #[test]
    fn chdir_of_an_unserved_conversation_is_not_found() {
        let served = served_with("a", std::env::temp_dir());
        let expected = ChdirError::NotFound;
        let actual = apply_chdir(&served, "unknown", "/anywhere").unwrap_err();
        assert_eq!(actual, expected);
    }

    /// Two conversations served together, one moved by `chdir` — the fixture
    /// shared by the tests below, each proving one fact about the outcome.
    fn served_pair() -> (ServedCwds, std::path::PathBuf, std::path::PathBuf) {
        let dir_a = scratch_dir();
        let dir_b = scratch_dir();
        let served = served_with("a", dir_a.clone());
        served
            .write()
            .unwrap()
            .insert("b".to_string(), Arc::new(RwLock::new(dir_b.clone())));
        (served, dir_a, dir_b)
    }

    #[test]
    fn chdir_returns_the_new_resolved_path() {
        let (served, dir_a, dir_b) = served_pair();
        let expected = scratch_dir();
        let actual = apply_chdir(&served, "a", expected.to_str().unwrap()).unwrap();
        assert_eq!(actual, expected);
        for dir in [dir_a, dir_b, expected] {
            std::fs::remove_dir(&dir).unwrap();
        }
    }

    #[test]
    fn chdir_moves_the_named_conversations_cell() {
        let (served, dir_a, dir_b) = served_pair();
        let expected = scratch_dir();
        apply_chdir(&served, "a", expected.to_str().unwrap()).unwrap();
        let actual = served.read().unwrap()["a"].read().unwrap().clone();
        assert_eq!(actual, expected);
        for dir in [dir_a, dir_b, expected] {
            std::fs::remove_dir(&dir).unwrap();
        }
    }

    #[test]
    fn chdir_leaves_every_other_conversations_cell_untouched() {
        let (served, dir_a, expected) = served_pair();
        let new_dir = scratch_dir();
        apply_chdir(&served, "a", new_dir.to_str().unwrap()).unwrap();
        let actual = served.read().unwrap()["b"].read().unwrap().clone();
        assert_eq!(actual, expected);
        for dir in [dir_a, expected, new_dir] {
            std::fs::remove_dir(&dir).unwrap();
        }
    }

    #[test]
    fn chdir_to_an_invalid_path_errors() {
        let dir_a = scratch_dir();
        let served = served_with("a", dir_a.clone());
        let missing =
            std::env::temp_dir().join(format!("bridge-cwd-missing-{}", uuid::Uuid::new_v4()));

        let actual = apply_chdir(&served, "a", missing.to_str().unwrap()).unwrap_err();
        assert!(matches!(actual, ChdirError::Invalid(_)));

        std::fs::remove_dir(&dir_a).unwrap();
    }

    #[test]
    fn chdir_to_an_invalid_path_leaves_the_cell_untouched() {
        let expected = scratch_dir();
        let served = served_with("a", expected.clone());
        let missing =
            std::env::temp_dir().join(format!("bridge-cwd-missing-{}", uuid::Uuid::new_v4()));

        let _ = apply_chdir(&served, "a", missing.to_str().unwrap());
        let actual = served.read().unwrap()["a"].read().unwrap().clone();
        assert_eq!(actual, expected);

        std::fs::remove_dir(&expected).unwrap();
    }
}
