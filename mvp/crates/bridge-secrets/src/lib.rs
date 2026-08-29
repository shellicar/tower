//! The Keychain behind every credential bridge reads, holds, or hands to a
//! child process. One service, `@shellicar/credentials`, a constant of this
//! crate and never configurable: an account name is the whole of what a
//! caller chooses, so no configuration can point a read at some other
//! service's items. An item is identified by the service and account
//! together, so an account here collides with nothing that happens to share
//! its name under another service.
//!
//! Read fresh on every call, never cached. A cached credential goes stale
//! the moment it is rotated or revoked out of band, and bridge has been
//! bitten by exactly that before (the OAuth-caching incident). There is no
//! store here to go stale: this crate holds three functions and no state.
//!
//! The crate compiles everywhere. Whether the Keychain can be reached is a
//! runtime question, `keychain_supported`, not a compile-time one: a build
//! that omitted this code could not be tested on the platform that omitted
//! it, and an unsupported platform must degrade by choosing a different
//! store rather than by failing.
//!
//! That choice is made once, from `keychain_supported`, before any call
//! here. A failure returned by this crate is a failure, never a reason to go
//! looking somewhere else: a locked Keychain, a declined prompt and an
//! absent item all mean something a caller has to surface, and reading a
//! file instead would answer them with a credential nobody checked.

/// The one Keychain service every credential lives under.
pub const SERVICE: &str = "@shellicar/credentials";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    /// The item is not there. Held apart from `Read` because the two call
    /// for opposite advice: nothing stored means store something, whereas a
    /// Keychain that is locked or a prompt that was declined means the item
    /// may be perfectly good and unreachable. Telling an operator to set up
    /// a credential they already have is how a locked Keychain gets
    /// diagnosed as a missing one.
    #[error("keychain item {SERVICE}/{account} does not exist")]
    NotFound { account: String },
    #[error("keychain item {SERVICE}/{account} could not be read")]
    Read {
        account: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("keychain item {SERVICE}/{account} could not be written")]
    Write {
        account: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("keychain item {SERVICE}/{account} could not be deleted")]
    Delete {
        account: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("keychain item {SERVICE}/{account} is not valid UTF-8")]
    NotUtf8 {
        account: String,
        #[source]
        source: std::string::FromUtf8Error,
    },
    #[error("the keychain is not available on {os}")]
    Unsupported { os: &'static str },
}

/// Whether a Keychain call can work here at all. The operating system is the
/// whole of the question: `security-framework` binds Apple's Security
/// framework, which every Mac has and nothing else does.
///
/// Pure, and takes its input, so every case is testable directly rather than
/// only the one the test host happens to be.
pub fn is_keychain_platform_supported(os: &str) -> bool {
    os == "macos"
}

/// The same question for the running process.
pub fn keychain_supported() -> bool {
    is_keychain_platform_supported(std::env::consts::OS)
}

/// Read one account's secret. Fails closed: an absent item, a declined
/// access prompt, or a non-UTF-8 value is an error, never an empty string a
/// caller might pass on as a credential.
///
/// Callers that are deciding whether to provide a credential ask
/// `keychain_supported` first and provide nothing when it is false. This
/// returning `Unsupported` is for the caller that asked for one specific
/// account and is owed an answer about it.
pub fn read(account: &str) -> Result<String, SecretError> {
    read_platform(account)
}

/// Create or replace one account's secret. Replacing is the ordinary case:
/// a rotated token overwrites the one it succeeds, and there is no state
/// where writing the same account twice is a mistake to be reported.
pub fn write(account: &str, secret: &str) -> Result<(), SecretError> {
    write_platform(account, secret)
}

/// Remove one account's item. An item that was never there is an error like
/// any other, because a caller asking to remove a specific account is owed
/// the truth about whether it existed.
pub fn delete(account: &str) -> Result<(), SecretError> {
    delete_platform(account)
}

/// Apple's `errSecItemNotFound`, the status both a read and a delete return
/// for an account that has no item.
#[cfg(target_os = "macos")]
const ITEM_NOT_FOUND: i32 = -25300;

#[cfg(target_os = "macos")]
fn classify(
    account: &str,
    source: security_framework::base::Error,
    absent: fn(String) -> SecretError,
    failed: fn(String, Box<dyn std::error::Error + Send + Sync>) -> SecretError,
) -> SecretError {
    if source.code() == ITEM_NOT_FOUND {
        absent(account.to_string())
    } else {
        failed(account.to_string(), Box::new(source))
    }
}

#[cfg(target_os = "macos")]
fn read_platform(account: &str) -> Result<String, SecretError> {
    let bytes = security_framework::passwords::get_generic_password(SERVICE, account).map_err(
        |source| {
            classify(
                account,
                source,
                |account| SecretError::NotFound { account },
                |account, source| SecretError::Read { account, source },
            )
        },
    )?;
    String::from_utf8(bytes).map_err(|source| SecretError::NotUtf8 {
        account: account.to_string(),
        source,
    })
}

#[cfg(target_os = "macos")]
fn write_platform(account: &str, secret: &str) -> Result<(), SecretError> {
    security_framework::passwords::set_generic_password(SERVICE, account, secret.as_bytes())
        .map_err(|source| SecretError::Write {
            account: account.to_string(),
            source: Box::new(source),
        })
}

#[cfg(target_os = "macos")]
fn delete_platform(account: &str) -> Result<(), SecretError> {
    security_framework::passwords::delete_generic_password(SERVICE, account).map_err(|source| {
        classify(
            account,
            source,
            |account| SecretError::NotFound { account },
            |account, source| SecretError::Delete { account, source },
        )
    })
}

#[cfg(not(target_os = "macos"))]
fn read_platform(_account: &str) -> Result<String, SecretError> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn write_platform(_account: &str, _secret: &str) -> Result<(), SecretError> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn delete_platform(_account: &str) -> Result<(), SecretError> {
    Err(unsupported())
}

#[cfg(not(target_os = "macos"))]
fn unsupported() -> SecretError {
    SecretError::Unsupported {
        os: std::env::consts::OS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keychain_is_supported_on_macos_and_nowhere_else() {
        assert!(is_keychain_platform_supported("macos"));
        assert!(!is_keychain_platform_supported("linux"));
        assert!(!is_keychain_platform_supported("windows"));
    }

    /// Fails closed on an item that isn't there. The account name is minted
    /// per run, so no machine can happen to hold it. Off a supported
    /// platform the same call is `Unsupported`, which is equally an error
    /// and equally not a secret.
    #[test]
    fn an_absent_item_is_an_error_not_an_empty_secret() {
        let account = format!("bridge-secrets-test-absent-{}", std::process::id());

        let actual = read(&account);

        assert!(actual.is_err());
    }

    /// An absent item reports itself as absent, not as an unreadable one,
    /// so a caller can tell "nothing stored yet" from "stored and out of
    /// reach" and give the advice that matches.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_absent_item_reports_itself_as_absent() {
        let account = format!("bridge-secrets-test-classify-{}", std::process::id());

        let actual = read(&account).unwrap_err();

        assert!(matches!(actual, SecretError::NotFound { .. }));
    }

    /// The service is this crate's own constant: an error names it, so a
    /// misconfigured account is diagnosable without guessing which service
    /// was searched.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_error_names_the_service_and_the_account() {
        let account = format!("bridge-secrets-test-named-{}", std::process::id());

        let actual = read(&account).unwrap_err().to_string();

        assert!(
            actual.contains(SERVICE) && actual.contains(&account),
            "{actual}"
        );
    }

    /// A write is readable, and a second write to the same account replaces
    /// the first rather than failing as a duplicate — the shape every token
    /// rotation depends on.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_second_write_to_one_account_replaces_the_first() {
        let account = format!("bridge-secrets-test-replace-{}", std::process::id());
        let expected = "second";

        write(&account, "first").unwrap();
        write(&account, expected).unwrap();
        let actual = read(&account).unwrap();
        delete(&account).unwrap();

        assert_eq!(actual, expected);
    }

    /// Delete removes the item, so the read that follows fails closed.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_deleted_item_no_longer_reads() {
        let account = format!("bridge-secrets-test-deleted-{}", std::process::id());

        write(&account, "value").unwrap();
        delete(&account).unwrap();
        let actual = read(&account);

        assert!(actual.is_err());
    }
}
