//! The Anthropic credential: reading it, spending it, and renewing it when
//! it is spent.
//!
//! Nothing here is interactive. A credential that does not exist yet is an
//! error naming the command that creates one, never a browser opening under
//! a process whose stdin belongs to whoever spawned it.

pub mod oauth;
pub mod record;
pub mod store;

use std::path::PathBuf;

use anyhow::Context;
use serde_json::Value;

pub use record::{Minted, Tokens};
pub use store::Store;

/// The account the credential is stored under. The service is
/// `bridge-secrets`' own constant, and an item is identified by the two
/// together, so this collides with nothing that shares the name elsewhere.
pub const ACCOUNT: &str = "anthropic-oauth";

/// The command that obtains a credential. Named in the error a missing one
/// produces, because that error is the entire instruction an operator gets.
pub const LOGIN_COMMAND: &str = "bridge-login";

/// The user's home directory, across platforms. `$HOME` is the Unix
/// convention every shell exports (including WSL2, which is Linux for this
/// purpose); native Windows doesn't set it by default — its own convention
/// is `%USERPROFILE%`.
pub fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}

/// The credential file. Shared with Claude Code, in its format, by
/// convention and by design: on a machine with no Keychain both read and
/// write this one document, and a record written by either is a record the
/// other can use.
pub fn credentials_file() -> anyhow::Result<PathBuf> {
    let home = home_dir().context("HOME (or USERPROFILE) is not set")?;
    Ok(PathBuf::from(home)
        .join(".claude")
        .join(".credentials.json"))
}

/// The store this machine uses, decided by platform and nothing else.
pub fn default_store() -> anyhow::Result<Store> {
    Ok(Store::for_platform(ACCOUNT, credentials_file()?))
}

/// The credential, held as its source and never as the secret. It is read
/// fresh from the store on every use, so a token rotated out of band by
/// another process is picked up rather than served stale from memory.
pub struct Credentials {
    store: Store,
    renewing: tokio::sync::Mutex<()>,
}

impl Credentials {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            renewing: tokio::sync::Mutex::new(()),
        }
    }

    /// The platform's store, with the credential checked before anything
    /// depends on it. A machine that has never logged in should say so at
    /// startup, not on the first turn.
    pub fn resolve() -> anyhow::Result<Self> {
        let credentials = Self::new(default_store()?);
        record::tokens(&credentials.document()?)?;
        Ok(credentials)
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Store a freshly minted credential, keeping everything the document
    /// already holds. What `bridge-login` calls once it has a code.
    pub fn save(&self, minted: &Minted) -> anyhow::Result<()> {
        let document = self
            .store
            .read()?
            .unwrap_or_else(|| Value::Object(Default::default()));
        self.store.write(&record::merge(document, minted))
    }

    /// A token good to send now, renewing first if the one on hand is spent.
    pub async fn access_token(&self, http: &reqwest::Client) -> anyhow::Result<String> {
        let tokens = record::tokens(&self.document()?)?;
        if !record::expired(tokens.expires_at, record::now_ms()) {
            return Ok(tokens.access_token);
        }

        // One renewal at a time in this process. The case is a single bridge
        // with many conversations, all of which find the token spent at the
        // same moment; without this they would each renew, and each renewal
        // rotates the refresh token the others are still holding.
        //
        // Across processes there is no lock, and that risk is accepted: two
        // bridges renewing at once means the later write wins and the
        // other's rotated token is lost, which costs a fresh login. Buying
        // that back needs a lockfile and a compare-and-swap, and it is not
        // the case this runs in.
        let _renewing = self.renewing.lock().await;

        // Whoever held the lock has already written a good token, and the
        // one they replaced is spent. Read what they wrote instead of
        // renewing again with a refresh token they have since rotated.
        let document = self.document()?;
        let tokens = record::tokens(&document)?;
        if !record::expired(tokens.expires_at, record::now_ms()) {
            return Ok(tokens.access_token);
        }

        let minted = oauth::refresh(http, &tokens.refresh_token, &tokens.scopes).await?;
        let access_token = minted.access_token.clone();
        self.store.write(&record::merge(document, &minted))?;
        Ok(access_token)
    }

    fn document(&self) -> anyhow::Result<Value> {
        self.store.read()?.with_context(|| {
            format!(
                "no credential in {} — run `{LOGIN_COMMAND}`",
                self.store.describe()
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bridge-auth-lib-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    fn minted(access_token: &str) -> Minted {
        Minted {
            access_token: access_token.to_string(),
            refresh_token: "r".to_string(),
            expires_at: 1,
            refresh_token_expires_at: None,
            scopes: vec![],
            subscription_type: None,
            rate_limit_tier: None,
            client_id: "client".to_string(),
        }
    }

    /// The message is the whole instruction an operator gets, so it has to
    /// name both where nothing was found and what to run about it.
    #[tokio::test]
    async fn an_empty_store_names_the_command_that_fills_it() {
        let credentials = Credentials::new(Store::File {
            path: scratch("empty"),
        });

        let actual = credentials.access_token(&reqwest::Client::new()).await;

        assert!(
            actual.unwrap_err().to_string().contains(LOGIN_COMMAND),
            "the error must name the login command"
        );
    }

    /// An unspent token is served straight from the store: no network, so a
    /// dead one cannot make this fail.
    #[tokio::test]
    async fn an_unspent_token_is_served_without_renewing_it() {
        let path = scratch("unspent");
        let credentials = Credentials::new(Store::File { path: path.clone() });
        let expected = "current";
        std::fs::write(
            &path,
            json!({ "claudeAiOauth": {
                "accessToken": expected,
                "refreshToken": "r",
                "expiresAt": record::now_ms() + record::EXPIRY_MARGIN_MS + 60_000,
            }})
            .to_string(),
        )
        .unwrap();

        let actual = credentials
            .access_token(&reqwest::Client::new())
            .await
            .unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(actual, expected);
    }

    /// Saving is a merge, not a replacement: the other application's keys
    /// share the document.
    #[test]
    fn saving_keeps_what_the_document_already_held() {
        let path = scratch("save");
        let credentials = Credentials::new(Store::File { path: path.clone() });
        let expected = json!({ "trusted": true });
        std::fs::write(
            &path,
            json!({ "enterpriseGateway": { "trusted": true } }).to_string(),
        )
        .unwrap();

        credentials.save(&minted("a")).unwrap();
        let actual = credentials.store().read().unwrap().unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(actual["enterpriseGateway"], expected);
    }
}
