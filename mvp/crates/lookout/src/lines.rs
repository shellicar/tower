//! The reporting lines: which conversation is a worker, and whose.
//!
//! A line is declared, never inferred. Watching traffic cannot recover it —
//! a parent asking a worker a question and a worker reporting to its parent
//! are the same shape on the wire, so an inferred graph gets edges backwards.
//! It is the org chart, and you find that out by looking it up.
//!
//! The spawn tool writes the bucket; the lookout only ever reads it.

use serde::Deserialize;

/// A line records direction of reporting and nothing else. Not the contract,
/// not the worktree, which belong to the spawn. It confers no authority, the
/// same way reporting to a manager rather than a peer says where a report
/// goes and not who may command whom.
#[derive(Debug, Clone, PartialEq)]
pub struct ReportingLine {
    pub worker: String,
    pub owner: String,
    /// When the line was written, in epoch milliseconds. It is the floor for
    /// silence: a worker that has committed nothing has still been quiet
    /// since somebody commissioned it, and that is the only clock there is
    /// for a brief that never arrived.
    pub written_at_ms: Option<i64>,
}

#[derive(Deserialize)]
struct LineBody {
    owner: String,
    #[serde(default)]
    ts: Option<String>,
}

/// One bucket entry as a line, or why it could not be read. A malformed
/// entry is named rather than dropped: nothing drops silently, and one bad
/// key must not blind the lookout to every other worker.
pub fn parse_line(key: &str, value: &[u8]) -> Result<ReportingLine, String> {
    let body: LineBody = serde_json::from_slice(value)
        .map_err(|e| format!("reporting line {key:?} is not a line: {e}"))?;
    if body.owner.is_empty() {
        return Err(format!("reporting line {key:?} names no owner"));
    }
    Ok(ReportingLine {
        worker: key.to_string(),
        owner: body.owner,
        written_at_ms: body.ts.as_deref().and_then(wire::parse_ts),
    })
}

#[cfg(test)]
mod parse_line {
    use super::*;

    #[test]
    fn reads_the_owner_and_the_moment_the_line_was_written() {
        let expected = Ok(ReportingLine {
            worker: "worker-1".into(),
            owner: "handler-1".into(),
            written_at_ms: Some(1_754_000_000_000),
        });

        let actual = parse_line(
            "worker-1",
            br#"{"owner":"handler-1","ts":"2025-07-31T22:13:20.000Z"}"#,
        );

        assert_eq!(actual, expected);
    }

    #[test]
    fn reads_a_line_that_carries_no_timestamp() {
        let expected = Ok(ReportingLine {
            worker: "worker-1".into(),
            owner: "handler-1".into(),
            written_at_ms: None,
        });

        let actual = parse_line("worker-1", br#"{"owner":"handler-1"}"#);

        assert_eq!(actual, expected);
    }

    #[test]
    fn rejects_an_entry_that_is_not_json() {
        let actual = parse_line("worker-1", b"not json at all");

        assert!(actual.is_err());
    }

    #[test]
    fn rejects_a_line_naming_no_owner() {
        let actual = parse_line("worker-1", br#"{"owner":""}"#);

        assert!(actual.is_err());
    }

    /// The line is direction of reporting and nothing else, so anything else
    /// the spawn tool chooses to write alongside it is ignored rather than
    /// fatal.
    #[test]
    fn ignores_fields_a_line_does_not_carry() {
        let expected = Ok(ReportingLine {
            worker: "worker-1".into(),
            owner: "handler-1".into(),
            written_at_ms: None,
        });

        let actual = parse_line(
            "worker-1",
            br#"{"owner":"handler-1","cwd":"/tmp/tree","contract":"whatever"}"#,
        );

        assert_eq!(actual, expected);
    }
}
