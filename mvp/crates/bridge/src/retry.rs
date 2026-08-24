//! The connect-phase retry policy: the `retry` cell, and the two pure
//! functions the retry loop is made of.
//!
//! Scope is the connect phase alone — the request up to and including the
//! response status. Once the stream has yielded anything the turn is past this
//! point and is never retried, because a partial stream cannot be replayed
//! into the same turn.
//!
//! The classification is by class, not by enumerated status code: 4xx never
//! retries except 429, 5xx always retries, no response at all always retries.
//! The documented list of codes has already changed under this code once, and
//! a rule written as a class stays correct when it changes again.
//!
//! Bridge holds no default for any field, so the line carries all four or it
//! is refused, and with no line there is no policy and therefore no retrying.

use std::num::NonZeroU32;
use std::time::Duration;

use serde_json::{Map, Value, json};

const KNOWN_FIELDS: &str = "maxRetries, baseDelayMs, maxDelayMs, retryAfterCapMs";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: NonZeroU32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    pub retry_after_cap: Duration,
}

/// What the connect attempt produced. Anything after the first stream event is
/// out of scope and has no representation here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectFailure {
    /// dns, socket, timeout: never reached a server.
    NoResponse,
    Status {
        code: u16,
        retry_after: Option<Duration>,
    },
}

/// How long to wait before the next attempt, or None to give up: abort the
/// turn exactly as bridge did before any of this existed.
///
/// `attempt` is 1-based and names the attempt that just failed. `random` is
/// the jitter fraction, in [0,1).
pub fn next_delay(
    failure: &ConnectFailure,
    attempt: u32,
    policy: &RetryPolicy,
    random: f64,
) -> Option<Duration> {
    if attempt > policy.max_retries.get() || !retryable(failure) {
        return None;
    }
    // Honoured as sent rather than computed, but capped, so a long one cannot
    // park a conversation. The cap is what protects the conversation whether
    // or not the header appears and whether or not its value is sane.
    if let ConnectFailure::Status {
        retry_after: Some(after),
        ..
    } = failure
    {
        return Some((*after).min(policy.retry_after_cap));
    }
    Some(backoff(attempt, policy, random))
}

fn retryable(failure: &ConnectFailure) -> bool {
    match failure {
        ConnectFailure::NoResponse => true,
        ConnectFailure::Status { code: 429, .. } => true,
        ConnectFailure::Status { code, .. } => (500..600).contains(code),
    }
}

/// Exponential from the base, capped, plus jitter of up to half the base so a
/// host running many conversations does not retry them in lockstep.
fn backoff(attempt: u32, policy: &RetryPolicy, random: f64) -> Duration {
    let doublings = 1u32
        .checked_shl(attempt.saturating_sub(1))
        .unwrap_or(u32::MAX);
    let scaled = policy
        .base_delay
        .checked_mul(doublings)
        .unwrap_or(policy.max_delay);
    scaled.min(policy.max_delay) + policy.base_delay.mul_f64(random * 0.5)
}

/// A uniform fraction in [0,1) for the jitter. Entropy already arrives in this
/// crate as uuid v4 — 122 bits from the OS — so seven of its fully random
/// bytes (9..16, clear of the version and variant nibbles) make one, rather
/// than a dependency earning its place on a single float.
pub fn jitter_fraction() -> f64 {
    let uuid = uuid::Uuid::new_v4().into_bytes();
    let mut bytes = [0u8; 8];
    bytes[1..8].copy_from_slice(&uuid[9..16]);
    u64::from_be_bytes(bytes) as f64 / (1u64 << 56) as f64
}

/// The retry-after header as a duration. Delta-seconds only: that is what the
/// messages API sends, and the header's other form is an HTTP-date, which
/// would need a date parser for a shape nothing here produces.
pub fn parse_retry_after(raw: &str) -> Option<Duration> {
    raw.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// The cell as a `retry` control line sets it: an object replaces the policy
/// wholesale, `null` clears it. A policy is one strategy, and half of one
/// mixed with half of another is not a strategy, which is why this replaces
/// rather than merging the way the `model` line does.
pub fn parse(value: &Value) -> Result<Option<RetryPolicy>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or("the value must be an object, or null to clear it")?;
    if let Some(unknown) = object
        .keys()
        .find(|key| !KNOWN_FIELDS.split(", ").any(|known| known == *key))
    {
        return Err(format!(
            "unknown field {unknown:?}; known fields: {KNOWN_FIELDS}"
        ));
    }
    let max_retries = u32::try_from(required(object, "maxRetries")?)
        .ok()
        .and_then(NonZeroU32::new)
        .ok_or("maxRetries must be a whole number of 1 or more")?;
    let base_delay = Duration::from_millis(required(object, "baseDelayMs")?);
    let max_delay = Duration::from_millis(required(object, "maxDelayMs")?);
    let retry_after_cap = Duration::from_millis(required(object, "retryAfterCapMs")?);
    if base_delay > max_delay {
        return Err("baseDelayMs must not be greater than maxDelayMs".to_string());
    }
    Ok(Some(RetryPolicy {
        max_retries,
        base_delay,
        max_delay,
        retry_after_cap,
    }))
}

/// Bridge holds no default for any of these, so every field is required and a
/// line missing one is refused rather than half-filled.
fn required(object: &Map<String, Value>, field: &str) -> Result<u64, String> {
    let given = object
        .get(field)
        .ok_or_else(|| format!("{field} is required; every field is: {KNOWN_FIELDS}"))?;
    given
        .as_u64()
        .filter(|n| *n >= 1)
        .ok_or_else(|| format!("{field} must be a whole number of 1 or more"))
}

/// The cell as the `retry` reply and the `settings` echo carry it.
pub fn to_json(policy: Option<&RetryPolicy>) -> Value {
    match policy {
        None => Value::Null,
        Some(policy) => json!({
            "maxRetries": policy.max_retries.get(),
            "baseDelayMs": policy.base_delay.as_millis() as u64,
            "maxDelayMs": policy.max_delay.as_millis() as u64,
            "retryAfterCapMs": policy.retry_after_cap.as_millis() as u64,
        }),
    }
}

/// What the console says about a failed response: the status, what the body
/// called it, its details, and the retry-after if the header carried one.
///
/// The spend cap is called out by name because it is a `rate_limit_error` 429
/// like any other in every visible respect, retrying and giving up like any
/// other, and `error.details.error_code` is the only thing that distinguishes
/// the one a human has to act on.
pub fn describe(code: u16, body: &str, retry_after: Option<Duration>) -> String {
    let mut out = format!("HTTP {code}");
    match serde_json::from_str::<Value>(body) {
        Ok(parsed) => {
            let error = &parsed["error"];
            if let Some(kind) = error["type"].as_str() {
                out.push_str(&format!(" {kind}"));
            }
            if let Some(message) = error["message"].as_str() {
                out.push_str(&format!(": {message}"));
            }
            out.push_str(&format!(" details={}", error["details"]));
            if error["details"]["error_code"] == "enforced_spend_limit_reached" {
                out.push_str(" (spend cap reached)");
            }
        }
        Err(_) => out.push_str(&format!(" body={body}")),
    }
    if let Some(after) = retry_after {
        out.push_str(&format!(" retry-after={}s", after.as_secs()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The policy every table row below is measured against: 10 retries,
    /// 500ms base, 32s ceiling, 60s cap on an honoured retry-after.
    fn policy() -> RetryPolicy {
        parse(&json!({
            "maxRetries": 10,
            "baseDelayMs": 500,
            "maxDelayMs": 32000,
            "retryAfterCapMs": 60000,
        }))
        .unwrap()
        .unwrap()
    }

    fn status(code: u16) -> ConnectFailure {
        ConnectFailure::Status {
            code,
            retry_after: None,
        }
    }

    fn after(code: u16, seconds: u64) -> ConnectFailure {
        ConnectFailure::Status {
            code,
            retry_after: Some(Duration::from_secs(seconds)),
        }
    }

    /// Jitter is up to half the base on top of the computed delay, so a
    /// computed row is a range. Zero randomness pins the floor.
    fn delay(failure: &ConnectFailure, attempt: u32) -> Option<Duration> {
        next_delay(failure, attempt, &policy(), 0.0)
    }

    mod classifying {
        use super::*;

        #[test]
        fn no_response_at_all_retries() {
            let expected = Some(Duration::from_millis(500));

            let actual = delay(&ConnectFailure::NoResponse, 1);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_400_never_retries() {
            let expected = None;

            let actual = delay(&status(400), 1);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_401_never_retries() {
            let expected = None;

            let actual = delay(&status(401), 1);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_403_never_retries() {
            let expected = None;

            let actual = delay(&status(403), 1);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_413_never_retries() {
            let expected = None;

            let actual = delay(&status(413), 1);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_429_is_the_one_4xx_that_retries() {
            let expected = Some(Duration::from_millis(4000));

            let actual = delay(&status(429), 4);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_500_retries() {
            let expected = Some(Duration::from_millis(2000));

            let actual = delay(&status(500), 3);

            assert_eq!(actual, expected);
        }

        /// The overload status. Nothing enumerates it: it retries because it
        /// is a 5xx, which is what keeps the rule correct when the documented
        /// list of codes moves again.
        #[test]
        fn a_529_retries_without_being_named() {
            let expected = Some(Duration::from_millis(500));

            let actual = delay(&status(529), 1);

            assert_eq!(actual, expected);
        }

        /// A 4xx nobody has seen yet is still a 4xx.
        #[test]
        fn an_unheard_of_4xx_never_retries() {
            let expected = None;

            let actual = delay(&status(451), 1);

            assert_eq!(actual, expected);
        }
    }

    mod backing_off {
        use super::*;

        #[test]
        fn the_first_failure_waits_the_base_delay() {
            let expected = Some(Duration::from_millis(500));

            let actual = delay(&ConnectFailure::NoResponse, 1);

            assert_eq!(actual, expected);
        }

        #[test]
        fn each_attempt_doubles_the_wait() {
            let expected = vec![
                Some(Duration::from_millis(500)),
                Some(Duration::from_millis(1000)),
                Some(Duration::from_millis(2000)),
                Some(Duration::from_millis(4000)),
            ];

            let actual: Vec<_> = (1..=4)
                .map(|attempt| delay(&ConnectFailure::NoResponse, attempt))
                .collect();

            assert_eq!(actual, expected);
        }

        #[test]
        fn the_wait_stops_growing_at_the_ceiling() {
            let expected = Some(Duration::from_millis(32000));

            let actual = delay(&ConnectFailure::NoResponse, 10);

            assert_eq!(actual, expected);
        }

        #[test]
        fn jitter_adds_up_to_half_the_base_on_top() {
            let expected = Some(Duration::from_millis(700));

            let actual = next_delay(&ConnectFailure::NoResponse, 1, &policy(), 0.8);

            assert_eq!(actual, expected);
        }

        /// Jitter sits on top of the ceiling rather than inside it, so the
        /// waits of many conversations that all reached the ceiling still
        /// spread out instead of firing together.
        #[test]
        fn jitter_still_applies_once_the_ceiling_is_reached() {
            let expected = Some(Duration::from_millis(32250));

            let actual = next_delay(&ConnectFailure::NoResponse, 10, &policy(), 1.0);

            assert_eq!(actual, expected);
        }

        /// A policy that allows enough retries to reach an attempt number
        /// whose doubling cannot be represented. The wait saturates at the
        /// ceiling rather than panicking on the overflow.
        #[test]
        fn a_doubling_too_large_to_represent_saturates_at_the_ceiling() {
            let expected = Some(Duration::from_millis(32000));
            let forever = RetryPolicy {
                max_retries: NonZeroU32::MAX,
                ..policy()
            };

            let actual = next_delay(&ConnectFailure::NoResponse, u32::MAX, &forever, 0.0);

            assert_eq!(actual, expected);
        }
    }

    mod giving_up {
        use super::*;

        #[test]
        fn the_last_allowed_retry_still_waits() {
            let expected = Some(Duration::from_millis(32000));

            let actual = delay(&ConnectFailure::NoResponse, 10);

            assert_eq!(actual, expected);
        }

        #[test]
        fn one_failure_past_the_retry_count_gives_up() {
            let expected = None;

            let actual = delay(&ConnectFailure::NoResponse, 11);

            assert_eq!(actual, expected);
        }

        /// A 429 carrying a retry-after gives up on exhaustion like anything
        /// else. The header says how long to wait, never whether to keep
        /// going, so nothing can retry a conversation forever.
        #[test]
        fn an_honoured_retry_after_still_gives_up_when_the_retries_run_out() {
            let expected = None;

            let actual = delay(&after(429, 20), 11);

            assert_eq!(actual, expected);
        }
    }

    mod honouring_retry_after {
        use super::*;

        #[test]
        fn a_retry_after_is_waited_as_sent_rather_than_computed() {
            let expected = Some(Duration::from_secs(20));

            let actual = delay(&after(429, 20), 1);

            assert_eq!(actual, expected);
        }

        #[test]
        fn the_attempt_number_does_not_change_an_honoured_retry_after() {
            let expected = Some(Duration::from_secs(20));

            let actual = delay(&after(429, 20), 9);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_long_retry_after_is_capped_so_it_cannot_park_a_conversation() {
            let expected = Some(Duration::from_secs(60));

            let actual = delay(&after(429, 300), 1);

            assert_eq!(actual, expected);
        }

        /// A 503 commonly carries one too. Nothing about honouring it is
        /// specific to 429.
        #[test]
        fn a_5xx_retry_after_is_honoured_the_same_way() {
            let expected = Some(Duration::from_secs(20));

            let actual = delay(&after(503, 20), 1);

            assert_eq!(actual, expected);
        }

        /// A 429 that sends no header — which is what a tier spend cap does —
        /// backs off on the computed schedule instead.
        #[test]
        fn a_429_with_no_retry_after_backs_off_like_anything_else() {
            let expected = Some(Duration::from_millis(4000));

            let actual = delay(&status(429), 4);

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_retry_after_on_a_status_that_never_retries_changes_nothing() {
            let expected = None;

            let actual = delay(&after(400, 20), 1);

            assert_eq!(actual, expected);
        }
    }

    mod reading_the_header {
        use super::*;

        #[test]
        fn whole_seconds_are_a_duration() {
            let expected = Some(Duration::from_secs(20));

            let actual = parse_retry_after("20");

            assert_eq!(actual, expected);
        }

        #[test]
        fn surrounding_space_is_ignored() {
            let expected = Some(Duration::from_secs(20));

            let actual = parse_retry_after(" 20 ");

            assert_eq!(actual, expected);
        }

        /// The header's other form. Bridge reads it as absent rather than
        /// guessing, and falls back to the computed backoff.
        #[test]
        fn an_http_date_is_read_as_no_retry_after() {
            let expected = None;

            let actual = parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT");

            assert_eq!(actual, expected);
        }
    }

    mod configuring {
        use super::*;

        #[test]
        fn a_whole_line_becomes_the_policy() {
            let expected = Some(RetryPolicy {
                max_retries: NonZeroU32::new(10).unwrap(),
                base_delay: Duration::from_millis(500),
                max_delay: Duration::from_secs(32),
                retry_after_cap: Duration::from_secs(60),
            });

            let actual = parse(&json!({
                "maxRetries": 10,
                "baseDelayMs": 500,
                "maxDelayMs": 32000,
                "retryAfterCapMs": 60000,
            }))
            .unwrap();

            assert_eq!(actual, expected);
        }

        #[test]
        fn null_clears_the_policy() {
            let expected = None;

            let actual = parse(&Value::Null).unwrap();

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_line_missing_a_field_is_refused() {
            let actual = parse(&json!({
                "maxRetries": 10,
                "baseDelayMs": 500,
                "maxDelayMs": 32000,
            }));

            assert_eq!(
                actual,
                Err(
                    "retryAfterCapMs is required; every field is: maxRetries, baseDelayMs, maxDelayMs, retryAfterCapMs"
                        .to_string()
                )
            );
        }

        #[test]
        fn a_zero_is_refused() {
            let actual = parse(&json!({
                "maxRetries": 10,
                "baseDelayMs": 0,
                "maxDelayMs": 32000,
                "retryAfterCapMs": 60000,
            }));

            assert_eq!(
                actual,
                Err("baseDelayMs must be a whole number of 1 or more".to_string())
            );
        }

        #[test]
        fn a_base_delay_above_the_ceiling_is_refused() {
            let actual = parse(&json!({
                "maxRetries": 10,
                "baseDelayMs": 40000,
                "maxDelayMs": 32000,
                "retryAfterCapMs": 60000,
            }));

            assert_eq!(
                actual,
                Err("baseDelayMs must not be greater than maxDelayMs".to_string())
            );
        }

        #[test]
        fn a_base_delay_equal_to_the_ceiling_is_accepted() {
            let expected = Some(Duration::from_secs(32));

            let actual = parse(&json!({
                "maxRetries": 10,
                "baseDelayMs": 32000,
                "maxDelayMs": 32000,
                "retryAfterCapMs": 60000,
            }))
            .unwrap()
            .map(|policy| policy.base_delay);

            assert_eq!(actual, expected);
        }

        #[test]
        fn an_unrecognised_field_is_refused() {
            let actual = parse(&json!({
                "maxRetries": 10,
                "baseDelayMs": 500,
                "maxDelayMs": 32000,
                "retryAfterCapMs": 60000,
                "jitter": 0.5,
            }));

            assert_eq!(
                actual,
                Err(
                    "unknown field \"jitter\"; known fields: maxRetries, baseDelayMs, maxDelayMs, retryAfterCapMs"
                        .to_string()
                )
            );
        }

        #[test]
        fn a_value_that_is_not_an_object_is_refused() {
            let actual = parse(&json!("aggressive"));

            assert!(actual.is_err());
        }

        #[test]
        fn the_echo_carries_the_whole_policy() {
            let expected = json!({
                "maxRetries": 10,
                "baseDelayMs": 500,
                "maxDelayMs": 32000,
                "retryAfterCapMs": 60000,
            });

            let actual = to_json(Some(&policy()));

            assert_eq!(actual, expected);
        }

        #[test]
        fn no_policy_echoes_as_null() {
            let expected = Value::Null;

            let actual = to_json(None);

            assert_eq!(actual, expected);
        }
    }

    mod describing {
        use super::*;

        #[test]
        fn the_status_and_what_the_body_called_it_are_both_named() {
            let body = r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded","details":null}}"#;

            let actual = describe(529, body, None);

            assert_eq!(actual, "HTTP 529 overloaded_error: Overloaded details=null");
        }

        /// The one 429 a human has to act on, and it looks like any other
        /// rate limit until the details are read.
        #[test]
        fn the_spend_cap_is_named_when_its_error_code_is_present() {
            let body = r#"{"error":{"type":"rate_limit_error","message":"Spend limit","details":{"error_code":"enforced_spend_limit_reached"}}}"#;

            let actual = describe(429, body, None);

            assert!(actual.contains("(spend cap reached)"), "{actual}");
        }

        #[test]
        fn an_ordinary_rate_limit_is_not_called_a_spend_cap() {
            let body = r#"{"error":{"type":"rate_limit_error","message":"Too many requests","details":null}}"#;

            let actual = describe(429, body, Some(Duration::from_secs(20)));

            assert_eq!(
                actual,
                "HTTP 429 rate_limit_error: Too many requests details=null retry-after=20s"
            );
        }

        /// A gateway in front of the API answers in HTML. The body still
        /// reaches the console rather than being dropped for not parsing.
        #[test]
        fn a_body_that_is_not_json_is_reported_as_it_arrived() {
            let actual = describe(502, "<html>bad gateway</html>", None);

            assert_eq!(actual, "HTTP 502 body=<html>bad gateway</html>");
        }
    }
}
