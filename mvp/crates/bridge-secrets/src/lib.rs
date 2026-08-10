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
//! macOS only. The crate is empty on every other platform, and so is
//! everything built on it.
#![cfg(target_os = "macos")]

use security_framework::passwords::get_generic_password;

/// The one Keychain service every credential lives under. Items are created
/// out of band by the operator, never by bridge.
pub const SERVICE: &str = "@shellicar/credentials";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain item {SERVICE}/{account} could not be read")]
    Read {
        account: String,
        #[source]
        source: security_framework::base::Error,
    },
    #[error("keychain item {SERVICE}/{account} is not valid UTF-8")]
    NotUtf8 {
        account: String,
        #[source]
        source: std::string::FromUtf8Error,
    },
}

/// Read one account's secret from the Keychain. Fails closed: an absent
/// item, a declined access prompt, or a non-UTF-8 value is an error, never
/// an empty string a caller might pass on as a credential.
pub fn read(account: &str) -> Result<String, SecretError> {
    let bytes = get_generic_password(SERVICE, account).map_err(|source| SecretError::Read {
        account: account.to_string(),
        source,
    })?;
    String::from_utf8(bytes).map_err(|source| SecretError::NotUtf8 {
        account: account.to_string(),
        source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fails closed on an item that isn't there. The account name is minted
    /// per run, so no machine can happen to hold it.
    #[test]
    fn an_absent_item_is_an_error_not_an_empty_secret() {
        let account = format!("bridge-secrets-test-absent-{}", std::process::id());
        let err = read(&account).expect_err("an absent keychain item must not read as a secret");
        assert!(matches!(err, SecretError::Read { .. }));
    }

    /// The service is this crate's own constant: an error names it, so a
    /// misconfigured account is diagnosable without guessing which service
    /// was searched.
    #[test]
    fn an_error_names_the_service_and_the_account() {
        let account = format!("bridge-secrets-test-named-{}", std::process::id());
        let rendered = read(&account).unwrap_err().to_string();
        assert!(rendered.contains(SERVICE), "{rendered}");
        assert!(rendered.contains(&account), "{rendered}");
    }
}
