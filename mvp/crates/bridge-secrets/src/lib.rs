//! The Keychain read behind every credential bridge hands to a child
//! process. One service, `@shellicar/credentials`, a constant of this crate
//! and never configurable: an account name is the whole of what a caller
//! chooses, so no configuration can point a read at some other service's
//! items.
//!
//! Read fresh on every call, never cached. A cached credential goes stale
//! the moment it is rotated or revoked out of band, and bridge has been
//! bitten by exactly that before (the OAuth-caching incident). There is no
//! store here to go stale: this crate holds one function.
//!
//! The crate compiles everywhere. Whether a read can succeed is a runtime
//! question, `keychain_supported`, not a compile-time one: a build that
//! omitted this code could not be tested on the platform that omitted it,
//! and an unsupported platform must degrade by injecting nothing rather
//! than by failing.

/// The one Keychain service every credential lives under. Items are created
/// out of band by the operator, never by bridge.
pub const SERVICE: &str = "@shellicar/credentials";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain item {SERVICE}/{account} could not be read")]
    Read {
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
    #[error("the keychain is not available on {os}/{arch}")]
    Unsupported {
        os: &'static str,
        arch: &'static str,
    },
}

/// Whether a Keychain read can work here at all. macOS on Apple silicon and
/// nothing else, mirroring where the native binding actually installs.
///
/// Pure, and takes its inputs, so every combination is testable directly
/// rather than only the one the test host happens to be.
pub fn is_keychain_platform_supported(os: &str, arch: &str) -> bool {
    os == "macos" && arch == "aarch64"
}

/// The same question for the running process.
pub fn keychain_supported() -> bool {
    is_keychain_platform_supported(std::env::consts::OS, std::env::consts::ARCH)
}

/// Read one account's secret from the Keychain. Fails closed: an absent
/// item, a declined access prompt, or a non-UTF-8 value is an error, never
/// an empty string a caller might pass on as a credential.
///
/// Callers that are deciding whether to provide a credential ask
/// `keychain_supported` first and provide nothing when it is false. This
/// returning `Unsupported` is for the caller that asked for one specific
/// account and is owed an answer about it.
pub fn read(account: &str) -> Result<String, SecretError> {
    read_platform(account)
}

#[cfg(target_os = "macos")]
fn read_platform(account: &str) -> Result<String, SecretError> {
    let bytes = security_framework::passwords::get_generic_password(SERVICE, account).map_err(
        |source| SecretError::Read {
            account: account.to_string(),
            source: Box::new(source),
        },
    )?;
    String::from_utf8(bytes).map_err(|source| SecretError::NotUtf8 {
        account: account.to_string(),
        source,
    })
}

#[cfg(not(target_os = "macos"))]
fn read_platform(_account: &str) -> Result<String, SecretError> {
    Err(SecretError::Unsupported {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_keychain_is_supported_on_macos_arm64_and_nowhere_else() {
        assert!(is_keychain_platform_supported("macos", "aarch64"));
        assert!(!is_keychain_platform_supported("macos", "x86_64"));
        assert!(!is_keychain_platform_supported("linux", "aarch64"));
        assert!(!is_keychain_platform_supported("windows", "aarch64"));
        assert!(!is_keychain_platform_supported("linux", "x86_64"));
    }

    /// Fails closed on an item that isn't there. The account name is minted
    /// per run, so no machine can happen to hold it. Off a supported
    /// platform the same call is `Unsupported`, which is equally an error
    /// and equally not a secret.
    #[test]
    fn an_absent_item_is_an_error_not_an_empty_secret() {
        let account = format!("bridge-secrets-test-absent-{}", std::process::id());
        let err = read(&account).expect_err("an absent keychain item must not read as a secret");
        if keychain_supported() {
            assert!(matches!(err, SecretError::Read { .. }));
        } else {
            assert!(matches!(err, SecretError::Unsupported { .. }));
        }
    }

    /// The service is this crate's own constant: an error names it, so a
    /// misconfigured account is diagnosable without guessing which service
    /// was searched.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_error_names_the_service_and_the_account() {
        let account = format!("bridge-secrets-test-named-{}", std::process::id());
        let rendered = read(&account).unwrap_err().to_string();
        assert!(rendered.contains(SERVICE), "{rendered}");
        assert!(rendered.contains(&account), "{rendered}");
    }
}
