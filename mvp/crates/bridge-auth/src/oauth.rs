//! The OAuth protocol itself: the endpoints, the authorisation URL, PKCE,
//! and the two grants that mint a credential.
//!
//! All of it lives here rather than in bridge-login, because none of it is
//! interactive. Opening a browser, listening on a port and reading a pasted
//! code are the interactive parts and belong to that binary; building the
//! URL it opens and exchanging what comes back are protocol, and bridge
//! needs half of it (the refresh grant) with no browser anywhere in sight.

use anyhow::Context;
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::record::{Minted, now_ms};

pub const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";

/// Where the authorisation server sends a code when there is no local
/// listener to send it to: a page that shows the code for a human to carry
/// back by hand.
pub const MANUAL_REDIRECT_URL: &str = "https://platform.claude.com/oauth/code/callback";

/// The client every Claude Code subscription credential is issued to.
/// Refreshing one means presenting the same client it was issued to, so this
/// is not ours to choose.
pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/// The header that tells the messages API this bearer is a subscription
/// token rather than a platform key.
pub const BETA_HEADER: &str = "oauth-2025-04-20";

/// What bridge needs a credential to be allowed to do. `org:create_api_key`
/// is deliberately absent: it belongs to the console flow that mints a
/// standalone API key, which is not what this is.
pub const SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
];

/// The verifier is kept and sent at exchange time; the challenge is what
/// travels in the URL. Proving possession of the verifier is what stops an
/// intercepted code being redeemable by anyone else.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// Two v4 UUIDs of randomness, hex, hyphens stripped: 64 characters, inside
/// the 43-to-128 the spec allows and well past guessing.
pub fn nonce() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub fn pkce() -> Pkce {
    let verifier = nonce();
    let digest = Sha256::digest(verifier.as_bytes());
    Pkce {
        challenge: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest),
        verifier,
    }
}

/// The URL a human authorises at. `redirect_uri` decides which flow this is,
/// and it must be the same string again at exchange time or the server
/// rejects the code.
pub fn authorize_url(challenge: &str, state: &str, redirect_uri: &str) -> anyhow::Result<String> {
    let scope = SCOPES.join(" ");
    let url = reqwest::Url::parse_with_params(
        AUTHORIZE_URL,
        &[
            ("code", "true"),
            ("client_id", CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("scope", scope.as_str()),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
        ],
    )?;
    Ok(url.to_string())
}

/// What the manual page shows is the code and the state joined by a `#`, so
/// a human pasting it back hands over both. Anything without the separator
/// is taken as a bare code.
pub fn split_pasted_code(pasted: &str) -> (String, Option<String>) {
    match pasted.trim().split_once('#') {
        Some((code, state)) => (code.to_string(), Some(state.to_string())),
        None => (pasted.trim().to_string(), None),
    }
}

/// Redeem an authorisation code. `redirect_uri` has to match the one the URL
/// was built with.
pub async fn exchange_code(
    http: &reqwest::Client,
    code: &str,
    state: &str,
    verifier: &str,
    redirect_uri: &str,
) -> anyhow::Result<Minted> {
    let data = post(
        http,
        &json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
            "state": state,
        }),
    )
    .await
    .context("exchanging the authorisation code")?;
    minted(&data, "", SCOPES.iter().map(|s| s.to_string()).collect())
}

/// Renew a credential. The scopes already held are sent back rather than the
/// defaults, so a credential issued with a narrower set keeps it instead of
/// silently widening on every renewal.
pub async fn refresh(
    http: &reqwest::Client,
    refresh_token: &str,
    scopes: &[String],
) -> anyhow::Result<Minted> {
    let requested: Vec<String> = if scopes.is_empty() {
        SCOPES.iter().map(|s| s.to_string()).collect()
    } else {
        scopes.to_vec()
    };
    let data = post(
        http,
        &json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
            "scope": requested.join(" "),
        }),
    )
    .await
    .context("renewing the credential")?;
    minted(&data, refresh_token, requested)
}

/// One POST for both grants. A failure carries the server's own reply, which
/// is where `invalid_grant` (the credential has been revoked or superseded,
/// and only a fresh login fixes it) can be read.
async fn post(http: &reqwest::Client, body: &Value) -> anyhow::Result<Value> {
    let response = http
        .post(TOKEN_URL)
        .json(body)
        .send()
        .await
        .context("reaching the token endpoint")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("the token endpoint answered {status}: {text}");
    }
    serde_json::from_str(&text).context("the token endpoint's reply is not JSON")
}

/// Shape a token response into a record. A rotated refresh token replaces
/// the one presented; an unrotated response keeps it. Scopes fall back to
/// what was asked for, so a reply that omits them does not erase them.
fn minted(data: &Value, presented_refresh: &str, requested: Vec<String>) -> anyhow::Result<Minted> {
    let access_token = data["access_token"]
        .as_str()
        .context("the token endpoint returned no access_token")?
        .to_string();
    let refresh_token = data["refresh_token"]
        .as_str()
        .unwrap_or(presented_refresh)
        .to_string();
    anyhow::ensure!(
        !refresh_token.is_empty(),
        "the token endpoint returned no refresh_token"
    );
    let now = now_ms();
    let scopes: Vec<String> = data["scope"]
        .as_str()
        .unwrap_or_default()
        .split(' ')
        .filter(|scope| !scope.is_empty())
        .map(str::to_string)
        .collect();
    Ok(Minted {
        access_token,
        refresh_token,
        expires_at: now + data["expires_in"].as_i64().unwrap_or_default() * 1000,
        refresh_token_expires_at: data["refresh_token_expires_in"]
            .as_i64()
            .map(|seconds| now + seconds * 1000),
        scopes: if scopes.is_empty() { requested } else { scopes },
        subscription_type: None,
        rate_limit_tier: None,
        client_id: CLIENT_ID.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    mod authorisation_url {
        use super::*;

        #[test]
        fn carries_the_challenge_method_the_server_requires() {
            let expected = "code_challenge_method=S256";

            let actual = authorize_url("challenge", "state", MANUAL_REDIRECT_URL).unwrap();

            assert!(actual.contains(expected), "{actual}");
        }

        /// The redirect is what separates the two flows, and it travels
        /// encoded: a raw `:` or `/` in the query would end the parameter.
        #[test]
        fn encodes_the_redirect_it_is_given() {
            let expected = "redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback";

            let actual =
                authorize_url("challenge", "state", "http://localhost:8080/callback").unwrap();

            assert!(actual.contains(expected), "{actual}");
        }
    }

    mod pkce_challenge {
        use super::*;

        /// The published worked example from RFC 7636, which pins the whole
        /// chain: SHA-256, base64url, and no padding.
        #[test]
        fn derives_the_challenge_the_way_the_spec_does() {
            let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

            let digest = Sha256::digest(b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
            let actual = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest);

            assert_eq!(actual, expected);
        }

        #[test]
        fn mints_a_different_verifier_each_time() {
            let actual = pkce().verifier;

            assert_ne!(actual, pkce().verifier);
        }
    }

    mod pasted_code {
        use super::*;

        #[test]
        fn separates_the_state_the_page_appends_to_the_code() {
            let expected = ("the-code".to_string(), Some("the-state".to_string()));

            let actual = split_pasted_code("  the-code#the-state\n");

            assert_eq!(actual, expected);
        }

        #[test]
        fn takes_a_value_without_a_separator_as_a_bare_code() {
            let expected = ("the-code".to_string(), None);

            let actual = split_pasted_code("the-code");

            assert_eq!(actual, expected);
        }
    }

    mod shaping_a_response {
        use super::*;

        #[test]
        fn keeps_the_presented_refresh_token_when_the_reply_does_not_rotate_it() {
            let expected = "presented";

            let actual = minted(
                &json!({ "access_token": "a", "expires_in": 60 }),
                "presented",
                vec![],
            )
            .unwrap();

            assert_eq!(actual.refresh_token, expected);
        }

        #[test]
        fn takes_the_rotated_refresh_token_when_the_reply_carries_one() {
            let expected = "rotated";

            let actual = minted(
                &json!({ "access_token": "a", "refresh_token": "rotated", "expires_in": 60 }),
                "presented",
                vec![],
            )
            .unwrap();

            assert_eq!(actual.refresh_token, expected);
        }

        /// A reply that omits the scopes must not be read as a credential
        /// with no scopes, or the next renewal would ask for none.
        #[test]
        fn falls_back_to_the_requested_scopes_when_the_reply_omits_them() {
            let expected = vec!["user:inference".to_string()];

            let actual = minted(
                &json!({ "access_token": "a", "expires_in": 60 }),
                "presented",
                vec!["user:inference".to_string()],
            )
            .unwrap();

            assert_eq!(actual.scopes, expected);
        }

        #[test]
        fn reports_a_reply_with_no_access_token_as_a_failure() {
            let actual = minted(&json!({ "expires_in": 60 }), "presented", vec![]);

            assert!(actual.is_err());
        }
    }
}
