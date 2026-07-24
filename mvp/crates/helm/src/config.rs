//! Config lines shared by two entry points: the `-c` startup batch and the
//! live paste command mode (`j`) — same grammar bridge's own `-c` accepts
//! (one JSON object per line), same dispatch either way: helm applies what
//! it recognizes as its own, everything else rides straight through to
//! bridge's control channel unexamined. Helm never needs to know bridge's
//! schema to do this — only its own small one, with "not mine" as the
//! only fallback case (composition-model.md's "handled or unhandled", not
//! a two-way route requiring knowledge of the other side).

use crate::transport::Session;

/// One line's outcome, for the caller to report however it wants (a
/// startup log line, a status-bar note).
pub enum Applied {
    /// Handled by helm itself — never reached bridge at all.
    #[allow(dead_code)] // no key claims this arm yet; see apply_config_line
    Local(String),
    /// Forwarded; bridge's own reply, verbatim.
    Forwarded(serde_json::Value),
    /// Not valid JSON, or an empty line — never reaches bridge.
    Invalid(String),
}

/// One already-parsed JSON value, dispatched. A key helm recognizes as its
/// own would be applied locally here first and never reach bridge — none
/// exist yet: helm has no local config surface implemented today, so this
/// is the hook such a key would join, not a placeholder standing in for
/// one that already works. Everything else rides through to bridge's
/// control channel exactly as given, unexamined; bridge's own validation
/// is what decides whether an unrecognized key was ever valid config.
pub async fn apply_config_value(session: &mut Session, value: serde_json::Value) -> Applied {
    match session.control(&value).await {
        Ok(reply) => Applied::Forwarded(reply),
        Err(e) => Applied::Invalid(format!("control failed: {e}")),
    }
}

/// A streamed parse, not a newline split: every complete JSON value in
/// `batch`, in order, however many lines each one happens to span. A
/// hand-written, pretty-printed value (a `permissions` list is routinely
/// several lines) is exactly as valid as one crammed onto a single line;
/// splitting on '\n' first would shred it into fragments that are each
/// invalid, or worse, valid but meaningless, on their own — bridge's own
/// `-c` has the identical fix for the identical reason. Pulled out from
/// `apply_config_batch` so this part is testable without a live `Session`.
fn parse_batch(batch: &str) -> Vec<Result<serde_json::Value, String>> {
    serde_json::Deserializer::from_str(batch)
        .into_iter::<serde_json::Value>()
        .map(|r| r.map_err(|e| e.to_string()))
        .collect()
}

/// Every value in a `-c`-style batch, applied in order.
pub async fn apply_config_batch(session: &mut Session, batch: &str) -> Vec<Applied> {
    let mut results = Vec::new();
    for parsed in parse_batch(batch) {
        match parsed {
            Ok(value) => results.push(apply_config_value(session, value).await),
            Err(e) => results.push(Applied::Invalid(format!("invalid JSON: {e}"))),
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::parse_batch;

    #[test]
    fn a_pretty_printed_multiline_value_parses_as_one_value_not_shredded_by_line() {
        // The exact shape that broke: a permissions list, written the way a
        // human actually writes one, spanning several lines.
        let batch = r#"{"permissions": [
  { "match": "$PWD", "default": "allow", "delete": "ask" },
  { "match": "*", "default": "ask" }
]}"#;
        let results = parse_batch(batch);
        assert_eq!(results.len(), 1, "one value, however many lines it spans");
        let value = results[0].as_ref().expect("valid JSON");
        assert_eq!(value["permissions"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn multiple_values_back_to_back_each_parse_separately() {
        let batch = "{\"model\": \"a\"}\n{\"cwd\": \"/tmp\"}\n";
        let results = parse_batch(batch);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].as_ref().unwrap()["model"], "a");
        assert_eq!(results[1].as_ref().unwrap()["cwd"], "/tmp");
    }

    #[test]
    fn genuinely_broken_json_is_reported_not_silently_dropped() {
        let results = parse_batch("{ not json");
        assert_eq!(results.len(), 1);
        assert!(results[0].is_err());
    }
}
