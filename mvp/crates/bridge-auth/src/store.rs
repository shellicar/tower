//! Where the credential record lives.
//!
//! The store is chosen once, from the platform, before any I/O happens, and
//! never changes afterwards. That is the whole design: a Keychain that is
//! locked, a prompt that was declined and an item that is absent are all
//! failures to be reported, never reasons to go and read a file instead.
//! Answering an unreachable Keychain with a file would serve a credential
//! nobody checked was current, and on the write side it would split one
//! record across two stores on a machine that has both.
//!
//! Platform capability is a different question, settled before any of that:
//! off macOS there is no Keychain to be locked or unlocked, so the file is
//! simply the store.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde_json::Value;

#[derive(Debug, Clone)]
pub enum Store {
    Keychain { account: String },
    File { path: PathBuf },
}

impl Store {
    /// The store this machine uses. One decision, taken from the platform.
    pub fn for_platform(account: &str, file: impl Into<PathBuf>) -> Store {
        if bridge_secrets::keychain_supported() {
            Store::Keychain {
                account: account.to_string(),
            }
        } else {
            Store::File { path: file.into() }
        }
    }

    /// Where the record is, in words, for an error message that has to tell
    /// an operator where to go and look.
    pub fn describe(&self) -> String {
        match self {
            Store::Keychain { account } => {
                format!("the keychain ({}/{account})", bridge_secrets::SERVICE)
            }
            Store::File { path } => path.display().to_string(),
        }
    }

    /// The stored document, or `None` when nothing has been stored yet.
    /// Absent is not an error here because it has an answer an operator can
    /// act on; anything else is, because it does not.
    pub fn read(&self) -> anyhow::Result<Option<Value>> {
        let text = match self {
            Store::Keychain { account } => match bridge_secrets::read(account) {
                Ok(text) => text,
                Err(bridge_secrets::SecretError::NotFound { .. }) => return Ok(None),
                Err(e) => return Err(e.into()),
            },
            Store::File { path } => match std::fs::read_to_string(path) {
                Ok(text) => text,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => {
                    return Err(e).with_context(|| format!("reading {}", path.display()));
                }
            },
        };
        serde_json::from_str(&text)
            .map(Some)
            .with_context(|| format!("{} does not hold valid JSON", self.describe()))
    }

    /// Replace the stored document.
    pub fn write(&self, doc: &Value) -> anyhow::Result<()> {
        let text = serde_json::to_string_pretty(doc)?;
        match self {
            Store::Keychain { account } => bridge_secrets::write(account, &text)?,
            Store::File { path } => write_private(path, &text)?,
        }
        Ok(())
    }

    /// Remove the stored document, reporting whether there was one.
    pub fn clear(&self) -> anyhow::Result<bool> {
        match self {
            Store::Keychain { account } => match bridge_secrets::delete(account) {
                Ok(()) => Ok(true),
                Err(bridge_secrets::SecretError::NotFound { .. }) => Ok(false),
                Err(e) => Err(e.into()),
            },
            Store::File { path } => match std::fs::remove_file(path) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e).with_context(|| format!("removing {}", path.display())),
            },
        }
    }
}

/// Write a file only its owner can read. The permissions are set after the
/// content lands, which is the same order the other writer of this file
/// uses; on a platform with no Unix permissions the write is simply a write.
fn write_private(path: &Path, text: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(path, text).with_context(|| format!("writing {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("restricting {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bridge-auth-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn nothing_stored_reads_as_nothing_rather_than_as_a_failure() {
        let store = Store::File {
            path: scratch("absent"),
        };

        let actual = store.read().unwrap();

        assert_eq!(actual, None);
    }

    #[test]
    fn a_written_document_reads_back_whole() {
        let store = Store::File {
            path: scratch("roundtrip"),
        };
        let expected = json!({ "claudeAiOauth": { "accessToken": "a" } });

        store.write(&expected).unwrap();
        let actual = store.read().unwrap().unwrap();
        store.clear().unwrap();

        assert_eq!(actual, expected);
    }

    /// A store that is there and unreadable is a failure to report, not an
    /// empty store to move past.
    #[test]
    fn a_corrupt_document_is_a_failure_not_an_empty_store() {
        let path = scratch("corrupt");
        std::fs::write(&path, "not json").unwrap();
        let store = Store::File { path: path.clone() };

        let actual = store.read();
        let _ = std::fs::remove_file(&path);

        assert!(actual.is_err());
    }

    #[test]
    fn clearing_reports_whether_there_was_anything_to_clear() {
        let store = Store::File {
            path: scratch("clear"),
        };
        let expected = false;

        let actual = store.clear().unwrap();

        assert_eq!(actual, expected);
    }

    /// The record holds a refresh token: on a machine with no keychain the
    /// file is the only thing protecting it.
    #[cfg(unix)]
    #[test]
    fn the_file_store_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let path = scratch("mode");
        let store = Store::File { path: path.clone() };
        let expected = 0o600;

        store.write(&json!({})).unwrap();
        let actual = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        store.clear().unwrap();

        assert_eq!(actual, expected);
    }
}
