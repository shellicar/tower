//! One timestamp normalisation, at ingest. Wire timestamps are ISO-8601 with
//! a real UTC offset and arrive with mixed offsets; strings misorder, so the
//! boundary inward of ingest carries unix milliseconds UTC only.
//!
//! Hand-rolled rather than a chrono dependency: the wire grammar is one fixed
//! shape (date, time, optional fraction, offset or Z) and a new dependency is
//! a decision this doesn't earn.

/// Parse `2026-07-07T21:00:00+10:00` (optional `.fff`, `Z` allowed) to unix
/// millis UTC. `None` for anything that doesn't fit the wire grammar.
pub fn parse_ts(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    // Minimum is the seconds-less form plus `Z`: `YYYY-MM-DDTHH:MMZ` = 17.
    if b.len() < 17 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't') {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }

    if b[13] != b':' {
        return None;
    }
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    // Seconds are optional in practice: real producers emit `23:15+10:00`
    // (seconds omitted) alongside the spec's full form. Tolerance widens the
    // parse — dropping the frame would lose a real message over ceremony.
    let (second, mut i): (i64, usize) = if b.get(16) == Some(&b':') {
        (s.get(17..19)?.parse().ok()?, 19)
    } else {
        (0, 16)
    };
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    // Optional fractional seconds, then the offset.
    let mut millis: i64 = 0;
    if b.get(i) == Some(&b'.') {
        if i == 16 {
            return None; // a fraction needs seconds to attach to
        }
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        // First three fraction digits are the milliseconds; the rest truncate.
        let frac = &s[start..i];
        let m3: String = frac.chars().chain("000".chars()).take(3).collect();
        millis = m3.parse().ok()?;
    }

    let offset_min: i64 = match b.get(i) {
        Some(b'Z') | Some(b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let rest = s.get(i + 1..)?;
            let (h, m) = match rest.len() {
                5 if rest.as_bytes()[2] == b':' => (
                    rest.get(0..2)?.parse::<i64>().ok()?,
                    rest.get(3..5)?.parse::<i64>().ok()?,
                ),
                4 => (
                    rest.get(0..2)?.parse::<i64>().ok()?,
                    rest.get(2..4)?.parse::<i64>().ok()?,
                ),
                _ => return None,
            };
            let total = h * 60 + m;
            if *sign == b'-' { -total } else { total }
        }
        _ => return None,
    };

    let days = days_from_epoch(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_min * 60;
    Some(seconds * 1_000 + millis)
}

/// The inverse direction: unix millis → the wire grammar (UTC, offset
/// spelled `+00:00`). Hoisted here so every producer in the workspace stamps
/// identically; std has no civil-time formatting (Hinnant's civil_from_days).
pub fn format_ts(ms: i64) -> String {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}+00:00",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// Now, in the wire grammar.
pub fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before 1970")
        .as_millis() as i64;
    format_ts(ms)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Civil date → days since 1970-01-01 (Howard Hinnant's days_from_civil).
fn days_from_epoch(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch() {
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
    }

    #[test]
    fn fixture_timestamp_with_offset() {
        // 2026-07-07T21:00:00+10:00 = 2026-07-07T11:00:00Z
        assert_eq!(
            parse_ts("2026-07-07T21:00:00+10:00"),
            Some(1_783_422_000_000)
        );
        assert_eq!(parse_ts("2026-07-07T11:00:00Z"), Some(1_783_422_000_000));
    }

    #[test]
    fn mixed_offsets_order_by_instant_not_string() {
        // String order says +10:00 comes first; instant order says otherwise.
        let melbourne = parse_ts("2026-07-07T21:00:00+10:00").unwrap();
        let utc_later_string_earlier = parse_ts("2026-07-07T12:00:00Z").unwrap();
        assert!(melbourne < utc_later_string_earlier);
    }

    #[test]
    fn fractional_seconds() {
        assert_eq!(parse_ts("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(parse_ts("1970-01-01T00:00:00.123Z"), Some(123));
        assert_eq!(parse_ts("1970-01-01T00:00:00.123456Z"), Some(123));
    }

    #[test]
    fn seconds_are_optional() {
        // Seen on the real wire: the CLI emits minute precision.
        assert_eq!(
            parse_ts("2026-07-07T21:00+10:00"),
            parse_ts("2026-07-07T21:00:00+10:00")
        );
        assert_eq!(parse_ts("1970-01-01T00:00Z"), Some(0));
    }

    #[test]
    fn negative_offset() {
        assert_eq!(parse_ts("1970-01-01T00:00:00-01:00"), Some(3_600_000));
    }

    #[test]
    fn leap_day() {
        assert_eq!(parse_ts("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
    }

    #[test]
    fn format_round_trips_through_parse() {
        for ms in [0_i64, 1_783_422_000_000, 123, 1_709_164_800_000] {
            assert_eq!(parse_ts(&format_ts(ms)), Some(ms), "{ms}");
        }
        assert!(parse_ts(&now_iso()).is_some());
    }

    #[test]
    fn garbage_is_none() {
        for bad in [
            "",
            "not a date",
            "2026-13-01T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-07-07 21:00:00+10:00",
            "2026-07-07T21:00:00",
            "2026-07-07T24:00:00Z",
        ] {
            assert_eq!(parse_ts(bad), None, "{bad}");
        }
    }
}
