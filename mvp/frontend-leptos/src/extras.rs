//! What a message's extra fields mean to the reader: its kind and values, who
//! sees it, what is shown, how each kind is drawn, and which messages a
//! compaction took out of the model's view. Every field arrives as the
//! producer sent it, so each reader below checks its shape and reads a
//! misshaped value as absent. Pure, so the rules are tested without a
//! component. mvp/frontend-svelte/src/lib/core/extras.ts is the same model in
//! TypeScript, tested against the same cases.

use std::collections::HashSet;

use serde_json::{Map, Value};
use ws_types::WsMessage;

use crate::time::Millis;

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn is_blocks(value: &Value) -> bool {
    value.as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .all(|b| b.get("type").and_then(Value::as_str).is_some())
    })
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// The message's kind, when it carries one as a string.
pub fn kind_of(message: &WsMessage) -> Option<&str> {
    text(message.extras.kind.as_ref())
}

/// The message's `fields`, or an empty map when it has no object there.
pub fn fields_of(message: &WsMessage) -> Map<String, Value> {
    record(message.extras.fields.as_ref())
        .cloned()
        .unwrap_or_default()
}

/// `userContent`, when it is a list of blocks.
pub fn user_content_of(message: &WsMessage) -> Option<&Vec<Value>> {
    message
        .extras
        .user_content
        .as_ref()
        .filter(|v| is_blocks(v))
        .and_then(Value::as_array)
}

/// What `scope` says when it replaces what came before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    /// The ids it keeps for the model.
    pub except: Vec<String>,
}

/// The ids `scope` keeps for the model, when it replaces what came before.
pub fn scope_of(message: &WsMessage) -> Option<Scope> {
    let scope = record(message.extras.scope.as_ref())?;
    if scope.get("replaces").and_then(Value::as_str) != Some("before") {
        return None;
    }
    let except = scope
        .get("except")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    Some(Scope { except })
}

/// `at`, when it is a time.
pub fn at_of(message: &WsMessage) -> Option<&str> {
    text(message.extras.at.as_ref()).filter(|at| parse_time(at).is_some())
}

fn audience_side(message: &WsMessage, side: &str) -> bool {
    record(message.extras.audience.as_ref())
        .and_then(|a| a.get(side))
        .and_then(Value::as_bool)
        != Some(false)
}

/// False only when the message says the person is not shown it.
pub fn shown_to_user(message: &WsMessage) -> bool {
    audience_side(message, "user")
}

/// False only when the message says the model is not sent it.
fn sent_to_model(message: &WsMessage) -> bool {
    audience_side(message, "model")
}

/// What the person is shown for a message: `userContent` when it has it, else `content`.
pub fn user_blocks(message: &WsMessage) -> Vec<Value> {
    user_content_of(message).unwrap_or(&message.content).clone()
}

/// The text of the text blocks, joined.
pub fn blocks_text(blocks: &[Value]) -> String {
    blocks
        .iter()
        .map(|b| {
            if b.get("type").and_then(Value::as_str) != Some("text") {
                return String::new();
            }
            match b.get("text") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
            }
        })
        .collect()
}

/// The ids of messages the model is no longer sent: everything before a
/// message whose `scope` replaces what came before, except the ids it names.
/// A message the model was never sent, and a system message, is not replaced
/// by anything.
pub fn replaced_for_model(messages: &[WsMessage]) -> HashSet<String> {
    let mut replaced = HashSet::new();
    for (index, message) in messages.iter().enumerate() {
        let Some(scope) = scope_of(message) else {
            continue;
        };
        let except: HashSet<&str> = scope.except.iter().map(String::as_str).collect();
        for earlier in &messages[..index] {
            if sent_to_model(earlier)
                && earlier.role != "system"
                && !except.contains(earlier.id.as_str())
            {
                replaced.insert(earlier.id.clone());
            }
        }
    }
    replaced
}

/// `2s`, `1m 5s`: whole seconds, the way a turn's length reads. Rounds half
/// up, as JavaScript's `Math.round` does.
pub fn format_duration(ms: f64) -> String {
    let seconds = (ms / 1000.0 + 0.5).floor();
    if seconds < 60.0 {
        format!("{seconds}s")
    } else {
        format!("{}m {}s", (seconds / 60.0).floor(), seconds % 60.0)
    }
}

/// A moment for `clock_label`: a time as text, or milliseconds since the epoch.
#[derive(Debug, Clone, Copy)]
pub enum Moment<'a> {
    Text(&'a str),
    Millis(Millis),
}

const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// `19:01`, with the weekday in front when the moment is not on the same day
/// as `now`; empty when the moment is not a time.
// TODO(claude): undecided: the weekday is always an English name and the
// time always `HH:MM`, where Svelte follows the browser's locale
// (`toLocaleDateString`/`toLocaleTimeString`). English and fixed for now.
pub fn clock_label(moment: Moment, now: Millis) -> String {
    let ms = match moment {
        Moment::Text(s) => match parse_time(s) {
            Some(ms) => ms,
            None => return String::new(),
        },
        Moment::Millis(ms) => ms as f64,
    };
    let date = local::parts(ms);
    let today = local::parts(now as f64);
    let time = format!("{:02}:{:02}", date.hour, date.minute);
    if (date.year, date.month, date.day) == (today.year, today.month, today.day) {
        time
    } else {
        format!("{} {time}", WEEKDAYS[date.weekday as usize])
    }
}

/// Milliseconds since the epoch for an ISO-8601 time: `YYYY-MM-DD` (read as
/// UTC), or a date with `THH:MM`, optional `:SS` and fraction, and an
/// optional `Z` or `±HH:MM` (read as local time when it has neither).
// TODO(claude): undecided: `at` and `endedAt` are parsed by this ISO-8601
// reader on every target, so a string JavaScript's `Date` would accept in
// another format (`Oct 3 2026`) reads as not a time here, where Svelte reads
// it as one. The alternative is `js_sys::Date::parse` in the browser, which
// matches Svelte exactly but leaves the host tests on a different parser.
fn parse_time(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let year = digits(0, 4)?;
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let month = digits(5, 2)?;
    let day = digits(8, 2)?;
    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    if b.len() == 10 {
        return Some(days_from_civil(year, month, day) as f64 * 86_400_000.0);
    }
    if !matches!(b.get(10), Some(b'T') | Some(b't') | Some(b' ')) || b.get(13) != Some(&b':') {
        return None;
    }
    let hour = digits(11, 2)?;
    let minute = digits(14, 2)?;
    let mut i = 16;
    let mut second = 0;
    let mut milli = 0.0;
    if b.get(i) == Some(&b':') {
        second = digits(i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut end = start;
            while b.get(end).is_some_and(u8::is_ascii_digit) {
                end += 1;
            }
            if end == start {
                return None;
            }
            let fraction: f64 = format!("0.{}", &s[start..end]).parse().ok()?;
            milli = (fraction * 1000.0).floor();
            i = end;
        }
    }
    if hour > 24
        || minute > 59
        || second > 59
        || (hour == 24 && (minute, second, milli) != (0, 0, 0.0))
    {
        return None;
    }
    let offset_minutes = match b.get(i) {
        None => {
            return Some(local::to_utc(year, month, day, hour, minute, second, milli));
        }
        Some(b'Z') | Some(b'z') if b.len() == i + 1 => 0,
        Some(sign @ (b'+' | b'-')) if b.len() == i + 6 && b.get(i + 3) == Some(&b':') => {
            let h = digits(i + 1, 2)?;
            let m = digits(i + 4, 2)?;
            if h > 23 || m > 59 {
                return None;
            }
            let total = h * 60 + m;
            if *sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
    let utc = days_from_civil(year, month, day) as f64 * 86_400_000.0
        + ((hour * 60 + minute - offset_minutes) * 60 + second) as f64 * 1000.0
        + milli;
    Some(utc)
}

fn is_leap(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 for a civil date (month 1-12).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The civil date (year, month 1-12, day) for days since 1970-01-01.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// A moment's local calendar date and clock time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Parts {
    year: i64,
    month: i64,
    day: i64,
    /// 0 is Sunday.
    weekday: i64,
    hour: i64,
    minute: i64,
}

/// Local time: the browser's own time zone in wasm, read through
/// `js_sys::Date` the way `time::format_time` reads it; UTC on the host, so
/// the tests read the same strings wherever they run.
#[cfg(target_arch = "wasm32")]
mod local {
    use super::Parts;

    pub fn parts(ms: f64) -> Parts {
        let date = js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(ms));
        Parts {
            year: i64::from(date.get_full_year()),
            month: i64::from(date.get_month()) + 1,
            day: i64::from(date.get_date()),
            weekday: i64::from(date.get_day()),
            hour: i64::from(date.get_hours()),
            minute: i64::from(date.get_minutes()),
        }
    }

    pub fn to_utc(
        year: i64,
        month: i64,
        day: i64,
        hour: i64,
        minute: i64,
        second: i64,
        milli: f64,
    ) -> f64 {
        let date = js_sys::Date::new_with_year_month_day_hr_min_sec_milli(
            year as u32,
            (month - 1) as i32,
            day as i32,
            hour as i32,
            minute as i32,
            second as i32,
            milli as i32,
        );
        date.get_time()
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod local {
    use super::{Parts, civil_from_days, days_from_civil};

    pub fn parts(ms: f64) -> Parts {
        let ms = ms.floor() as i64;
        let days = ms.div_euclid(86_400_000);
        let in_day = ms.rem_euclid(86_400_000) / 1000;
        let (year, month, day) = civil_from_days(days);
        Parts {
            year,
            month,
            day,
            weekday: (days + 4).rem_euclid(7),
            hour: in_day / 3600,
            minute: in_day % 3600 / 60,
        }
    }

    pub fn to_utc(
        year: i64,
        month: i64,
        day: i64,
        hour: i64,
        minute: i64,
        second: i64,
        milli: f64,
    ) -> f64 {
        days_from_civil(year, month, day) as f64 * 86_400_000.0
            + ((hour * 60 + minute) * 60 + second) as f64 * 1000.0
            + milli
    }
}

/// The tone of a folded row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Agent,
    Compaction,
}

/// How a message is drawn.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    /// Plain chat, or a kind this reader does not know: a message with its header.
    Message { blocks: Vec<Value> },
    /// A message only the model is sent, shown when the reader asks to see those.
    ModelOnly { label: String, blocks: Vec<Value> },
    /// One dim line.
    Line { text: String },
    /// A dot and a line; `failed` colours the dot.
    Notice { failed: bool, text: String },
    /// A folded message: its label and detail, its blocks inside.
    Folded {
        tone: Tone,
        label: String,
        detail: String,
        blocks: Vec<Value>,
    },
    /// An error from the service, with its class and status.
    Error { detail: String, blocks: Vec<Value> },
}

fn joined(parts: &[Option<String>]) -> String {
    parts
        .iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" · ")
}

fn tool_call_note(reason: &str) -> Option<&'static str> {
    match reason {
        "incomplete" => Some("Tool call did not complete"),
        "interrupted" => Some("Tool call interrupted"),
        "result-missing" => Some("Tool call result missing"),
        "denied" => Some("Tool call denied"),
        "skipped" => Some("Tool call skipped"),
        _ => None,
    }
}

/// How `message` is drawn, given `fallback_label` for a model-only message
/// with no kind and `now` for the clock.
pub fn row_of(message: &WsMessage, fallback_label: &str, now: Millis) -> Row {
    let kind = kind_of(message);
    let fields = fields_of(message);
    let blocks = user_blocks(message);
    if !shown_to_user(message) {
        return Row::ModelOnly {
            label: kind.unwrap_or(fallback_label).to_owned(),
            blocks: message.content.clone(),
        };
    }
    let duration = number(fields.get("durationMs"));
    let field_text = |name: &str| text(fields.get(name)).map(str::to_owned);
    match kind {
        Some("turn-finished") => {
            let moment = match text(fields.get("endedAt")).or_else(|| at_of(message)) {
                Some(s) => Moment::Text(s),
                None => Moment::Millis(message.ts),
            };
            let ended = clock_label(moment, now);
            let worked = match duration {
                None => blocks_text(&blocks),
                Some(ms) => format!("Worked for {}", format_duration(ms)),
            };
            let done = (!ended.is_empty()).then(|| format!("done {ended}"));
            Row::Line {
                text: joined(&[Some(worked), done]),
            }
        }
        Some("interrupted") => {
            let during = (fields.get("during").and_then(Value::as_str) == Some("tool-use"))
                .then(|| "during tool use".to_owned());
            Row::Line {
                text: joined(&[Some("Interrupted".to_owned()), during]),
            }
        }
        Some("tool-call-note") => Row::Line {
            text: tool_call_note(text(fields.get("reason")).unwrap_or(""))
                .map(str::to_owned)
                .unwrap_or_else(|| blocks_text(&blocks)),
        },
        Some("task-finished") => {
            let text = match field_text("summary") {
                None => blocks_text(&blocks),
                Some(summary) => joined(&[Some(summary), duration.map(format_duration)]),
            };
            Row::Notice {
                failed: fields.get("status").and_then(Value::as_str) == Some("failed"),
                text,
            }
        }
        Some("subagent-report") => Row::Folded {
            tone: Tone::Agent,
            label: format!(
                "Message from @{}",
                field_text("agentType").unwrap_or_else(|| "agent".to_owned())
            ),
            detail: String::new(),
            blocks,
        },
        Some("compaction") => Row::Folded {
            tone: Tone::Compaction,
            label: "Conversation compacted".to_owned(),
            detail: joined(&[field_text("trigger"), duration.map(format_duration)]),
            blocks,
        },
        Some("api-error") => {
            let status = number(fields.get("status")).map(|n| n.to_string());
            Row::Error {
                detail: joined(&[field_text("error"), status]),
                blocks,
            }
        }
        _ => Row::Message { blocks },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use ws_types::WsExtras;

    fn text_block(value: &str) -> Value {
        json!({ "type": "text", "text": value })
    }

    fn message(id: &str) -> WsMessage {
        WsMessage {
            id: id.into(),
            query: "q".into(),
            turn: "t".into(),
            role: "user".into(),
            from: None,
            content: vec![text_block(id)],
            extras: Box::default(),
            ts: 1,
        }
    }

    fn with_extras(id: &str, extras: WsExtras) -> WsMessage {
        WsMessage {
            extras: Box::new(extras),
            ..message(id)
        }
    }

    /// Every extra field the wrong shape: a number kind, a list for fields, a
    /// string audience, userContent, scope and a number at.
    fn misshaped() -> WsMessage {
        WsMessage {
            role: "assistant".into(),
            ..with_extras(
                "x",
                WsExtras {
                    kind: Some(json!(7)),
                    fields: Some(json!([1])),
                    audience: Some(json!("model")),
                    user_content: Some(json!("not blocks")),
                    scope: Some(json!("before")),
                    at: Some(json!(1_727_930_560_880_i64)),
                },
            )
        }
    }

    /// Milliseconds for a local date and time (month 1-12).
    fn local_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64) -> Millis {
        local::to_utc(year, month, day, hour, minute, 0, 0.0) as Millis
    }

    /// The moment as `toISOString` writes it.
    fn iso(ms: Millis) -> String {
        let days = ms.div_euclid(86_400_000);
        let in_day = ms.rem_euclid(86_400_000);
        let (y, mo, d) = civil_from_days(days);
        format!(
            "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
            in_day / 3_600_000,
            in_day / 60_000 % 60,
            in_day / 1000 % 60,
            in_day % 1000
        )
    }

    fn noon() -> Millis {
        local_ms(2026, 10, 3, 12, 0)
    }

    fn evening() -> String {
        iso(local_ms(2026, 10, 3, 19, 1))
    }

    mod shown_to_user {
        use super::*;

        #[test]
        fn is_true_for_plain_chat() {
            let actual = shown_to_user(&message("m1"));

            assert!(actual);
        }

        #[test]
        fn is_false_for_a_message_only_the_model_is_sent() {
            let m = with_extras(
                "m1",
                WsExtras {
                    audience: Some(json!({ "model": true, "user": false })),
                    ..Default::default()
                },
            );

            let actual = shown_to_user(&m);

            assert!(!actual);
        }

        #[test]
        fn is_true_for_a_message_both_are_sent() {
            let m = with_extras(
                "m1",
                WsExtras {
                    audience: Some(json!({ "model": true, "user": true })),
                    ..Default::default()
                },
            );

            let actual = shown_to_user(&m);

            assert!(actual);
        }

        #[test]
        fn is_true_for_a_misshaped_audience() {
            let actual = shown_to_user(&misshaped());

            assert!(actual);
        }
    }

    mod user_blocks {
        use super::*;

        #[test]
        fn is_the_content_when_there_is_no_user_content() {
            let expected = vec![text_block("m1")];

            let actual = user_blocks(&message("m1"));

            assert_eq!(actual, expected);
        }

        #[test]
        fn is_user_content_when_there_is_one() {
            let expected = vec![text_block("shown")];
            let m = with_extras(
                "m1",
                WsExtras {
                    user_content: Some(json!([text_block("shown")])),
                    ..Default::default()
                },
            );

            let actual = user_blocks(&m);

            assert_eq!(actual, expected);
        }

        #[test]
        fn is_the_content_when_user_content_is_not_a_list_of_blocks() {
            let expected = vec![text_block("x")];

            let actual = user_blocks(&misshaped());

            assert_eq!(actual, expected);
        }
    }

    mod a_misshaped_field_reads_as_absent {
        use super::*;

        #[test]
        fn kind() {
            let m = misshaped();

            let actual = kind_of(&m);

            assert_eq!(actual, None);
        }

        #[test]
        fn fields() {
            let expected = Map::new();

            let actual = fields_of(&misshaped());

            assert_eq!(actual, expected);
        }

        #[test]
        fn user_content() {
            let m = misshaped();

            let actual = user_content_of(&m);

            assert_eq!(actual, None);
        }

        #[test]
        fn scope() {
            let actual = scope_of(&misshaped());

            assert_eq!(actual, None);
        }

        #[test]
        fn at() {
            let m = misshaped();

            let actual = at_of(&m);

            assert_eq!(actual, None);
        }

        #[test]
        fn an_at_that_is_not_a_time() {
            let m = with_extras(
                "m1",
                WsExtras {
                    at: Some(json!("yesterday")),
                    ..Default::default()
                },
            );

            let actual = at_of(&m);

            assert_eq!(actual, None);
        }

        #[test]
        fn a_scope_whose_except_is_not_a_list() {
            let expected = Some(Scope { except: vec![] });
            let m = with_extras(
                "s",
                WsExtras {
                    scope: Some(json!({ "replaces": "before", "except": "m1" })),
                    ..Default::default()
                },
            );

            let actual = scope_of(&m);

            assert_eq!(actual, expected);
        }
    }

    mod blocks_text {
        use super::*;

        #[test]
        fn joins_the_text_blocks_and_skips_the_rest() {
            let expected = "ab";

            let actual =
                blocks_text(&[text_block("a"), json!({ "type": "image" }), text_block("b")]);

            assert_eq!(actual, expected);
        }
    }

    mod replaced_for_model {
        use super::*;

        fn summary() -> WsMessage {
            with_extras(
                "s",
                WsExtras {
                    scope: Some(json!({ "replaces": "before", "except": ["m2"] })),
                    ..Default::default()
                },
            )
        }

        fn ids(names: &[&str]) -> HashSet<String> {
            names.iter().map(|n| (*n).to_owned()).collect()
        }

        #[test]
        fn names_the_messages_before_the_summary_except_those_it_keeps() {
            let expected = ids(&["m1", "m3"]);

            let actual =
                replaced_for_model(&[message("m1"), message("m2"), message("m3"), summary()]);

            assert_eq!(actual, expected);
        }

        #[test]
        fn leaves_the_messages_after_the_summary() {
            let expected = ids(&[]);

            let actual = replaced_for_model(&[summary(), message("m4")]);

            assert_eq!(actual, expected);
        }

        #[test]
        fn leaves_a_message_the_model_was_never_sent() {
            let expected = ids(&[]);
            let unsent = with_extras(
                "m1",
                WsExtras {
                    audience: Some(json!({ "model": false, "user": true })),
                    ..Default::default()
                },
            );

            let actual = replaced_for_model(&[unsent, summary()]);

            assert_eq!(actual, expected);
        }

        #[test]
        fn leaves_a_system_message() {
            let expected = ids(&[]);
            let boundary = WsMessage {
                role: "system".into(),
                ..message("boundary")
            };

            let actual = replaced_for_model(&[boundary, summary()]);

            assert_eq!(actual, expected);
        }

        #[test]
        fn is_empty_when_nothing_has_a_scope() {
            let expected = ids(&[]);

            let actual = replaced_for_model(&[message("m1"), message("m2")]);

            assert_eq!(actual, expected);
        }

        #[test]
        fn is_empty_when_the_scope_is_misshaped() {
            let expected = ids(&[]);

            let actual = replaced_for_model(&[message("m1"), misshaped()]);

            assert_eq!(actual, expected);
        }
    }

    mod format_duration {
        use super::*;

        #[test]
        fn reads_seconds_under_a_minute() {
            let expected = "2s";

            let actual = format_duration(2000.0);

            assert_eq!(actual, expected);
        }

        #[test]
        fn reads_minutes_and_seconds_from_a_minute_on() {
            let expected = "1m 5s";

            let actual = format_duration(65000.0);

            assert_eq!(actual, expected);
        }
    }

    mod clock_label {
        use super::*;

        #[test]
        fn is_just_the_time_on_the_same_day() {
            let expected = "19:01";

            let actual = clock_label(Moment::Millis(local_ms(2026, 10, 3, 19, 1)), noon());

            assert_eq!(actual, expected);
        }

        #[test]
        fn puts_the_weekday_in_front_on_another_day() {
            let expected = "Thursday 19:01";

            let actual = clock_label(Moment::Millis(local_ms(2026, 10, 1, 19, 1)), noon());

            assert_eq!(actual, expected);
        }

        #[test]
        fn is_empty_for_a_moment_that_is_not_a_date() {
            let expected = "";

            let actual = clock_label(Moment::Text("not a date"), noon());

            assert_eq!(actual, expected);
        }

        #[test]
        fn reads_an_iso_time_with_an_offset() {
            let expected = "19:01";

            let actual = clock_label(Moment::Text("2026-10-03T21:01:00+02:00"), noon());

            assert_eq!(actual, expected);
        }
    }

    mod row_of {
        use super::*;

        fn at(m: &WsMessage) -> Row {
            row_of(m, "system", noon())
        }

        fn evening_label() -> String {
            clock_label(Moment::Text(&evening()), noon())
        }

        fn kinded(id: &str, role: &str, kind: &str, fields: Value) -> WsMessage {
            WsMessage {
                role: role.into(),
                ..with_extras(
                    id,
                    WsExtras {
                        kind: Some(json!(kind)),
                        fields: Some(fields),
                        ..Default::default()
                    },
                )
            }
        }

        fn and(m: WsMessage, change: impl FnOnce(&mut WsExtras)) -> WsMessage {
            let mut m = m;
            change(&mut m.extras);
            m
        }

        mod turn_finished {
            use super::*;

            #[test]
            fn reads_how_long_the_turn_ran_and_when_it_ended() {
                let expected = Row::Line {
                    text: format!("Worked for 2s · done {}", evening_label()),
                };
                let m = and(
                    kinded(
                        "t",
                        "system",
                        "turn-finished",
                        json!({ "durationMs": 2000, "endedAt": evening() }),
                    ),
                    |e| e.audience = Some(json!({ "model": false, "user": true })),
                );

                let actual = at(&m);

                assert_eq!(actual, expected);
            }

            #[test]
            fn falls_back_to_the_messages_at_for_when_it_ended() {
                let expected = Row::Line {
                    text: format!("Worked for 2s · done {}", evening_label()),
                };
                let m = and(
                    kinded(
                        "t",
                        "system",
                        "turn-finished",
                        json!({ "durationMs": 2000 }),
                    ),
                    |e| e.at = Some(json!(evening())),
                );

                let actual = at(&m);

                assert_eq!(actual, expected);
            }

            #[test]
            fn shows_the_content_when_the_duration_is_missing() {
                let expected = Row::Line {
                    text: format!("Worked for 2s · done {}", evening_label()),
                };
                let m = WsMessage {
                    content: vec![text_block("Worked for 2s")],
                    ..and(kinded("t", "system", "turn-finished", json!({})), |e| {
                        e.at = Some(json!(evening()))
                    })
                };

                let actual = at(&m);

                assert_eq!(actual, expected);
            }
        }

        mod interrupted {
            use super::*;

            #[test]
            fn reads_interrupted() {
                let expected = Row::Line {
                    text: "Interrupted".into(),
                };

                let actual = at(&kinded(
                    "i",
                    "user",
                    "interrupted",
                    json!({ "during": "turn" }),
                ));

                assert_eq!(actual, expected);
            }

            #[test]
            fn says_when_it_cut_short_a_tool_use() {
                let expected = Row::Line {
                    text: "Interrupted · during tool use".into(),
                };

                let actual = at(&kinded(
                    "i",
                    "user",
                    "interrupted",
                    json!({ "during": "tool-use" }),
                ));

                assert_eq!(actual, expected);
            }
        }

        mod tool_call_note {
            use super::*;

            #[test]
            fn reads_the_reason() {
                let expected = Row::Line {
                    text: "Tool call denied".into(),
                };

                let actual = at(&kinded(
                    "n",
                    "user",
                    "tool-call-note",
                    json!({ "reason": "denied" }),
                ));

                assert_eq!(actual, expected);
            }

            #[test]
            fn shows_user_content_for_a_reason_it_does_not_know() {
                let expected = Row::Line {
                    text: "Tool call vanished".into(),
                };
                let m = and(
                    kinded(
                        "n",
                        "user",
                        "tool-call-note",
                        json!({ "reason": "vanished" }),
                    ),
                    |e| e.user_content = Some(json!([text_block("Tool call vanished")])),
                );

                let actual = at(&m);

                assert_eq!(actual, expected);
            }
        }

        mod task_finished {
            use super::*;

            #[test]
            fn reads_the_summary_and_how_long_it_ran() {
                let expected = Row::Notice {
                    failed: false,
                    text: "Agent \"reviewer\" finished · 39s".into(),
                };
                let m = kinded(
                    "f",
                    "user",
                    "task-finished",
                    json!({ "status": "completed", "summary": "Agent \"reviewer\" finished", "durationMs": 39000 }),
                );

                let actual = at(&m);

                assert_eq!(actual, expected);
            }

            #[test]
            fn marks_a_failed_one() {
                let expected = Row::Notice {
                    failed: true,
                    text: "Agent \"reviewer\" failed".into(),
                };
                let m = kinded(
                    "f",
                    "user",
                    "task-finished",
                    json!({ "status": "failed", "summary": "Agent \"reviewer\" failed" }),
                );

                let actual = at(&m);

                assert_eq!(actual, expected);
            }

            #[test]
            fn shows_user_content_with_no_summary() {
                let expected = Row::Notice {
                    failed: false,
                    text: "Task finished".into(),
                };
                let m = and(kinded("f", "user", "task-finished", json!({})), |e| {
                    e.user_content = Some(json!([text_block("Task finished")]))
                });

                let actual = at(&m);

                assert_eq!(actual, expected);
            }
        }

        mod subagent_report {
            use super::*;

            #[test]
            fn folds_the_report_under_who_sent_it() {
                let expected = Row::Folded {
                    tone: Tone::Agent,
                    label: "Message from @general-purpose".into(),
                    detail: String::new(),
                    blocks: vec![text_block("Review done")],
                };
                let m = WsMessage {
                    content: vec![text_block("Review done")],
                    ..kinded(
                        "r",
                        "user",
                        "subagent-report",
                        json!({ "agentType": "general-purpose" }),
                    )
                };

                let actual = at(&m);

                assert_eq!(actual, expected);
            }
        }

        mod compaction {
            use super::*;

            #[test]
            fn folds_the_summary_under_the_trigger_and_duration() {
                let expected = Row::Folded {
                    tone: Tone::Compaction,
                    label: "Conversation compacted".into(),
                    detail: "manual · 5s".into(),
                    blocks: vec![text_block("Summary")],
                };
                let m = WsMessage {
                    content: vec![text_block("Summary")],
                    ..kinded(
                        "c",
                        "user",
                        "compaction",
                        json!({ "trigger": "manual", "durationMs": 4996 }),
                    )
                };

                let actual = at(&m);

                assert_eq!(actual, expected);
            }
        }

        mod api_error {
            use super::*;

            #[test]
            fn shows_the_error_class_and_status() {
                let expected = Row::Error {
                    detail: "server_error · 529".into(),
                    blocks: vec![text_block("API Error")],
                };
                let m = WsMessage {
                    content: vec![text_block("API Error")],
                    ..and(
                        kinded(
                            "e",
                            "assistant",
                            "api-error",
                            json!({ "error": "server_error", "status": 529 }),
                        ),
                        |e| e.audience = Some(json!({ "model": false, "user": true })),
                    )
                };

                let actual = at(&m);

                assert_eq!(actual, expected);
            }
        }

        mod model_only {
            use super::*;

            fn model_only(m: WsMessage) -> WsMessage {
                and(m, |e| {
                    e.audience = Some(json!({ "model": true, "user": false }))
                })
            }

            #[test]
            fn labels_a_reminder_by_its_kind() {
                let expected = Row::ModelOnly {
                    label: "date".into(),
                    blocks: vec![text_block("d")],
                };

                let actual = at(&model_only(kinded(
                    "d",
                    "user",
                    "date",
                    json!({ "date": "2026-10-01" }),
                )));

                assert_eq!(actual, expected);
            }

            #[test]
            fn labels_no_response_by_its_kind() {
                let expected = Row::ModelOnly {
                    label: "no-response".into(),
                    blocks: vec![text_block("n")],
                };

                let actual = at(&model_only(kinded(
                    "n",
                    "assistant",
                    "no-response",
                    json!({}),
                )));

                assert_eq!(actual, expected);
            }

            #[test]
            fn labels_a_message_with_no_kind_by_its_sender() {
                let expected = Row::ModelOnly {
                    label: "system".into(),
                    blocks: vec![text_block("m")],
                };

                let actual = at(&model_only(message("m")));

                assert_eq!(actual, expected);
            }
        }

        mod a_kind_it_does_not_know {
            use super::*;

            #[test]
            fn shows_user_content_as_a_message() {
                let expected = Row::Message {
                    blocks: vec![text_block("shown")],
                };
                let m = and(kinded("u", "user", "recap", json!({ "text": "r" })), |e| {
                    e.user_content = Some(json!([text_block("shown")]))
                });

                let actual = at(&m);

                assert_eq!(actual, expected);
            }
        }

        #[test]
        fn shows_plain_chat_as_a_message() {
            let expected = Row::Message {
                blocks: vec![text_block("p")],
            };

            let actual = at(&message("p"));

            assert_eq!(actual, expected);
        }

        #[test]
        fn shows_a_message_with_misshaped_extras_as_a_message_of_its_content() {
            let expected = Row::Message {
                blocks: vec![text_block("x")],
            };

            let actual = at(&misshaped());

            assert_eq!(actual, expected);
        }
    }
}
