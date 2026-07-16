//! Time verdicts, pure and injectable — Decision 1 of docs/mvp/
//! frontend-architecture.md, mirroring the control's core/time.ts. The two
//! hardest folds (liveness, approval void) are verdicts against the client's
//! OWN clock. They take `now` as an argument, so they test with a fixed value
//! and no clock at all; the clock is only for the per-concern *ticking* that
//! feeds them (ticker != clock).

/// Milliseconds since the epoch — the unit the wire's `ts`/`lastPulse` carry.
pub type Millis = i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    Stranded,
}

/// Liveness is a fold, never declared (agent-spec): the facts are the pulse and
/// the instance's own declared interval; the verdict is the reader's, against
/// its own clock. Stranded = silence past ~3 declared intervals; no declared
/// interval yet = no verdict to pass (Alive).
pub fn liveness_verdict(now: Millis, last_pulse: Millis, interval_s: Option<i64>) -> Liveness {
    match interval_s {
        Some(s) if now - last_pulse > 3 * s * 1000 => Liveness::Stranded,
        _ => Liveness::Alive,
    }
}

/// The pulse is ~15s while an approval pends, so ~3 missed (>45s) reads as a
/// dead holder — the ask is void. The client's derivation, never a wire fact.
pub const VOID_AFTER_MS: Millis = 45_000;

pub fn approval_void(now: Millis, last_pulse: Millis) -> bool {
    now - last_pulse > VOID_AFTER_MS
}

/// "How long ago", coarse — the staleness read shared by rail, panel, view.
pub fn age(now: Millis, ts: Millis) -> String {
    let s = ((now - ts) / 1000).max(0);
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else if s < 86_400 {
        format!("{}h", s / 3600)
    } else {
        format!("{}d", s / 86_400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_declared_interval_is_never_stranded() {
        assert_eq!(liveness_verdict(1_000_000, 0, None), Liveness::Alive);
    }

    #[test]
    fn stranded_past_three_intervals() {
        // interval 15s → stranded after 45s of silence.
        let now = 100_000;
        assert_eq!(liveness_verdict(now, now - 44_000, Some(15)), Liveness::Alive);
        assert_eq!(
            liveness_verdict(now, now - 46_000, Some(15)),
            Liveness::Stranded
        );
    }

    #[test]
    fn void_after_forty_five_seconds() {
        assert!(!approval_void(100_000, 100_000 - 45_000));
        assert!(approval_void(100_000, 100_000 - 45_001));
    }

    #[test]
    fn age_reads_coarsely() {
        assert_eq!(age(60_000, 60_000), "0s");
        assert_eq!(age(60_000, 30_000), "30s");
        assert_eq!(age(600_000, 0), "10m");
        assert_eq!(age(7_200_000, 0), "2h");
    }
}
