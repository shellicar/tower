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

/// One JSON object, dispatched. A key helm recognizes as its own would be
/// applied locally here first and never reach bridge — none exist yet:
/// helm has no local config surface implemented today, so this is the
/// hook such a key would join, not a placeholder standing in for one that
/// already works. Everything else rides through to bridge's control
/// channel exactly as given, unexamined; bridge's own validation is what
/// decides whether an unrecognized key was ever valid config at all.
pub async fn apply_config_line(session: &mut Session, line: &str) -> Applied {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Applied::Invalid("empty line".to_string());
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => return Applied::Invalid(format!("invalid JSON: {e}")),
    };
    match session.control(&value).await {
        Ok(reply) => Applied::Forwarded(reply),
        Err(e) => Applied::Invalid(format!("control failed: {e}")),
    }
}

/// Every non-blank line of a `-c`-style batch, applied in order — the
/// same grammar and the same one-line-at-a-time discipline bridge's own
/// `-c` uses, one layer up.
pub async fn apply_config_batch(session: &mut Session, batch: &str) -> Vec<Applied> {
    let mut results = Vec::new();
    for line in batch.lines() {
        if line.trim().is_empty() {
            continue;
        }
        results.push(apply_config_line(session, line).await);
    }
    results
}
