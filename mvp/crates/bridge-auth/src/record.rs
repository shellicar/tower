//! The credential record itself: the shape stored, when it is spent, and
//! how a freshly minted token is folded into what is already there.
//!
//! The record is shared. Claude Code reads and writes the same document in
//! the same format, and keeps its own keys beside ours, so a write here is
//! always a merge and never a replacement. Deserialising into a struct and
//! serialising it back would silently drop every field this crate does not
//! know about, which is why the document stays a `Value` throughout and only
//! the fields being changed are touched.

use anyhow::Context;
use serde_json::{Value, json};

/// The one key inside the document that holds the subscription credential.
pub const RECORD_KEY: &str = "claudeAiOauth";

/// How long before the stated expiry a token is treated as spent. A token
/// that expires during the request carrying it fails the turn, so the margin
/// buys a renewal before that can happen rather than a 401 to recover from.
pub const EXPIRY_MARGIN_MS: i64 = 300_000;

/// What a request needs, read out of the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub scopes: Vec<String>,
}

/// What a token endpoint returned. `subscription_type` and `rate_limit_tier`
/// are absent from every token response: they are account facts, not token
/// facts, so a refresh leaves whatever the record already holds rather than
/// overwriting it with nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Minted {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub refresh_token_expires_at: Option<i64>,
    pub scopes: Vec<String>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub client_id: String,
}

/// Wall-clock milliseconds. Every expiry decision takes this as an argument
/// rather than calling it, so the decision is testable without waiting.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether a token is spent, counting the margin.
pub fn expired(expires_at: i64, now_ms: i64) -> bool {
    now_ms + EXPIRY_MARGIN_MS >= expires_at
}

/// Read the credential out of the document, naming precisely what is missing
/// rather than reporting the record as a whole as bad.
pub fn tokens(doc: &Value) -> anyhow::Result<Tokens> {
    let record = doc
        .get(RECORD_KEY)
        .with_context(|| format!("the credential record has no {RECORD_KEY}"))?;
    let field = |name: &str| -> anyhow::Result<String> {
        record
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_string)
            .with_context(|| format!("the credential record has no {RECORD_KEY}.{name}"))
    };
    Ok(Tokens {
        access_token: field("accessToken")?,
        refresh_token: field("refreshToken")?,
        expires_at: record
            .get("expiresAt")
            .and_then(Value::as_i64)
            .with_context(|| format!("the credential record has no {RECORD_KEY}.expiresAt"))?,
        scopes: record
            .get("scopes")
            .and_then(Value::as_array)
            .map(|scopes| {
                scopes
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Fold a minted credential into the document. Every key the document
/// already carries survives, at both levels: the ones beside `claudeAiOauth`
/// and the ones inside it. A field the endpoint did not return keeps the
/// value it had.
pub fn merge(doc: Value, minted: &Minted) -> Value {
    let mut doc = match doc {
        Value::Object(_) => doc,
        _ => json!({}),
    };
    let mut record = match doc.get(RECORD_KEY) {
        Some(Value::Object(fields)) => Value::Object(fields.clone()),
        _ => json!({}),
    };
    record["accessToken"] = json!(minted.access_token);
    record["refreshToken"] = json!(minted.refresh_token);
    record["expiresAt"] = json!(minted.expires_at);
    record["scopes"] = json!(minted.scopes);
    record["clientId"] = json!(minted.client_id);
    if let Some(expires_at) = minted.refresh_token_expires_at {
        record["refreshTokenExpiresAt"] = json!(expires_at);
    }
    if let Some(subscription) = &minted.subscription_type {
        record["subscriptionType"] = json!(subscription);
    }
    if let Some(tier) = &minted.rate_limit_tier {
        record["rateLimitTier"] = json!(tier);
    }
    doc[RECORD_KEY] = record;
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minted() -> Minted {
        Minted {
            access_token: "new-access".to_string(),
            refresh_token: "new-refresh".to_string(),
            expires_at: 2_000,
            refresh_token_expires_at: None,
            scopes: vec!["user:inference".to_string()],
            subscription_type: None,
            rate_limit_tier: None,
            client_id: "client".to_string(),
        }
    }

    mod expiry {
        use super::*;

        #[test]
        fn a_token_with_time_left_beyond_the_margin_is_not_spent() {
            let expected = false;

            let actual = expired(1_000_000, 1_000_000 - EXPIRY_MARGIN_MS - 1);

            assert_eq!(actual, expected);
        }

        /// The margin is the point: a token still valid by the clock is
        /// spent early, so it is never renewed in the middle of the request
        /// that needed it.
        #[test]
        fn a_token_inside_the_margin_is_spent_before_it_expires() {
            let expected = true;

            let actual = expired(1_000_000, 1_000_000 - EXPIRY_MARGIN_MS + 1);

            assert_eq!(actual, expected);
        }
    }

    mod reading {
        use super::*;

        #[test]
        fn reads_the_credential_out_of_the_shared_document() {
            let expected = Tokens {
                access_token: "a".to_string(),
                refresh_token: "r".to_string(),
                expires_at: 42,
                scopes: vec!["user:inference".to_string()],
            };

            let actual = tokens(&json!({
                "claudeAiOauth": {
                    "accessToken": "a",
                    "refreshToken": "r",
                    "expiresAt": 42,
                    "scopes": ["user:inference"],
                }
            }))
            .unwrap();

            assert_eq!(actual, expected);
        }

        #[test]
        fn names_the_missing_field_rather_than_the_whole_record() {
            let expected = "claudeAiOauth.refreshToken";

            let actual = tokens(&json!({ "claudeAiOauth": { "accessToken": "a" } }))
                .unwrap_err()
                .to_string();

            assert!(actual.contains(expected), "{actual}");
        }
    }

    mod merging {
        use super::*;

        /// The other application's keys sit beside ours in one document, so
        /// a write that replaced the document would log it out.
        #[test]
        fn keeps_the_keys_beside_the_credential() {
            let expected = json!({ "trusted": true });

            let actual = merge(
                json!({ "enterpriseGateway": { "trusted": true } }),
                &minted(),
            );

            assert_eq!(actual["enterpriseGateway"], expected);
        }

        /// An account fact no token response carries: overwriting it with
        /// nothing on every renewal is how the record decays.
        #[test]
        fn keeps_a_field_the_token_response_does_not_carry() {
            let expected = json!("enterprise");

            let actual = merge(
                json!({ "claudeAiOauth": { "subscriptionType": "enterprise" } }),
                &minted(),
            );

            assert_eq!(actual["claudeAiOauth"]["subscriptionType"], expected);
        }

        #[test]
        fn replaces_the_token_the_renewal_supersedes() {
            let expected = json!("new-access");

            let actual = merge(
                json!({ "claudeAiOauth": { "accessToken": "old-access" } }),
                &minted(),
            );

            assert_eq!(actual["claudeAiOauth"]["accessToken"], expected);
        }

        #[test]
        fn writes_a_credential_into_a_document_that_has_none() {
            let expected = json!("new-refresh");

            let actual = merge(json!({}), &minted());

            assert_eq!(actual["claudeAiOauth"]["refreshToken"], expected);
        }
    }
}
