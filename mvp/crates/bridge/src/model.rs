//! The `model` cell: what bridge asks the messages API for, and the control
//! line that fills it in.
//!
//! Where the line is drawn, because the repository's tolerance rule points
//! the other way and someone will otherwise open these enums back up. Bridge
//! knows the shape of a request; the API owns what a given model will accept.
//! Model names change constantly, so `name` is free text and is never checked
//! against a list. A new effort level or thinking mode arrives with a feature
//! release and is rare, so a closed set that must be updated to adopt one is
//! worth the cost. Which efforts a given model supports, and that Opus 5
//! refuses disabled thinking at xhigh or max, are the API's to reject and
//! never bridge's to know.
//!
//! The line MERGES rather than replacing: it updates the fields it names and
//! leaves the rest alone, and `null` clears an optional one. So a line is
//! validated on the values it carries, and whether the cell is complete is
//! asked when a conversation is served instead.
//!
//! `thinking` and `thinkingDisplay` are separate flat fields rather than an
//! object mirroring the API's, and that is the merge's doing: with a display
//! already set, setting thinking to `disabled` one field at a time would
//! otherwise leave bridge rejecting a configuration reached legitimately.
//! Bridge holds what was meant and knows what the API will accept.

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Thinking {
    Adaptive,
    Disabled,
}

impl Thinking {
    const KNOWN: &'static str = "adaptive, disabled";

    fn parse(word: &str) -> Option<Self> {
        match word {
            "adaptive" => Some(Self::Adaptive),
            "disabled" => Some(Self::Disabled),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Adaptive => "adaptive",
            Self::Disabled => "disabled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThinkingDisplay {
    Summarized,
    Omitted,
}

impl ThinkingDisplay {
    const KNOWN: &'static str = "summarized, omitted";

    fn parse(word: &str) -> Option<Self> {
        match word {
            "summarized" => Some(Self::Summarized),
            "omitted" => Some(Self::Omitted),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Summarized => "summarized",
            Self::Omitted => "omitted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effort {
    Max,
    XHigh,
    High,
    Medium,
    Low,
}

impl Effort {
    const KNOWN: &'static str = "max, xhigh, high, medium, low";

    fn parse(word: &str) -> Option<Self> {
        match word {
            "max" => Some(Self::Max),
            "xhigh" => Some(Self::XHigh),
            "high" => Some(Self::High),
            "medium" => Some(Self::Medium),
            "low" => Some(Self::Low),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Max => "max",
            Self::XHigh => "xhigh",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }
}

const KNOWN_FIELDS: &str = "name, maxTokens, thinking, thinkingDisplay, effort";

/// The cell. Every field is optional here because a line names only what it
/// changes; `name` and `maxTokens` are required of the cell as a whole, which
/// `resolve` is what asks.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Settings {
    pub name: Option<String>,
    pub max_tokens: Option<i64>,
    pub thinking: Option<Thinking>,
    pub thinking_display: Option<ThinkingDisplay>,
    pub effort: Option<Effort>,
}

impl Settings {
    /// This cell with `value`'s fields merged over it. Built whole and
    /// returned rather than written in place, so a line that fails validation
    /// partway leaves the cell exactly as it was.
    pub fn merged(&self, value: &Value) -> Result<Settings, String> {
        let object = value.as_object().ok_or("the value must be an object")?;
        let mut next = self.clone();
        for (field, given) in object {
            match field.as_str() {
                "name" => {
                    next.name = Some(given.as_str().ok_or("name must be a string")?.to_string());
                }
                "maxTokens" => {
                    next.max_tokens = Some(
                        given
                            .as_i64()
                            .filter(|n| *n >= 1)
                            .ok_or("maxTokens must be a whole number of 1 or more")?,
                    );
                }
                "thinking" => {
                    next.thinking = word(given, Thinking::parse, "thinking", Thinking::KNOWN)?;
                }
                "thinkingDisplay" => {
                    next.thinking_display = word(
                        given,
                        ThinkingDisplay::parse,
                        "thinkingDisplay",
                        ThinkingDisplay::KNOWN,
                    )?;
                }
                "effort" => {
                    next.effort = word(given, Effort::parse, "effort", Effort::KNOWN)?;
                }
                unknown => {
                    return Err(format!(
                        "unknown field {unknown:?}; known fields: {KNOWN_FIELDS}"
                    ));
                }
            }
        }
        Ok(next)
    }

    /// The cell as the `model` reply and `settings` echo it: the fields that
    /// are set, and nothing at all for the ones that are not.
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        if let Some(name) = &self.name {
            out.insert("name".into(), json!(name));
        }
        if let Some(max_tokens) = self.max_tokens {
            out.insert("maxTokens".into(), json!(max_tokens));
        }
        if let Some(thinking) = self.thinking {
            out.insert("thinking".into(), json!(thinking.name()));
        }
        if let Some(display) = self.thinking_display {
            out.insert("thinkingDisplay".into(), json!(display.name()));
        }
        if let Some(effort) = self.effort {
            out.insert("effort".into(), json!(effort.name()));
        }
        Value::Object(out)
    }

    /// The whole configuration one conversation is served with, `pin` naming
    /// the model when a spawn or a service request named one. This is the only
    /// place completeness is asked, and it is asked once, when the
    /// conversation is served — which is what leaves no unconfigured path
    /// behind it.
    pub fn resolve(&self, pin: Option<&str>) -> Result<Resolved, String> {
        let name = pin
            .map(str::to_string)
            .or_else(|| self.name.clone())
            .ok_or("no model name is configured")?;
        let max_tokens = self.max_tokens.ok_or("no maxTokens is configured")?;
        Ok(Resolved {
            name,
            max_tokens,
            thinking: self.thinking,
            thinking_display: self.thinking_display,
            effort: self.effort,
        })
    }
}

/// An optional closed-set field: a known word sets it, `null` clears it.
fn word<T>(
    value: &Value,
    parse: fn(&str) -> Option<T>,
    field: &str,
    known: &str,
) -> Result<Option<T>, String> {
    if value.is_null() {
        return Ok(None);
    }
    value
        .as_str()
        .and_then(parse)
        .map(Some)
        .ok_or_else(|| format!("{field} must be one of: {known}"))
}

/// One conversation's model configuration, fixed when it was served.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub name: String,
    pub max_tokens: i64,
    pub thinking: Option<Thinking>,
    pub thinking_display: Option<ThinkingDisplay>,
    pub effort: Option<Effort>,
}

impl Resolved {
    /// The request's `thinking` field, or None to omit it entirely — omitted
    /// is not the same as empty. Adaptive carries the display when one is set;
    /// disabled drops it, because the API rejects a display there and the two
    /// fields are held apart precisely so a merge can reach that pair.
    pub fn thinking_field(&self) -> Option<Value> {
        match self.thinking? {
            Thinking::Adaptive => Some(match self.thinking_display {
                Some(display) => json!({ "type": "adaptive", "display": display.name() }),
                None => json!({ "type": "adaptive" }),
            }),
            Thinking::Disabled => Some(json!({ "type": "disabled" })),
        }
    }

    /// The request's `output_config`, or None to omit it entirely.
    pub fn output_config(&self) -> Option<Value> {
        Some(json!({ "effort": self.effort?.name() }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole() -> Settings {
        Settings::default()
            .merged(&json!({
                "name": "claude-opus-5",
                "maxTokens": 120000,
                "thinking": "adaptive",
                "thinkingDisplay": "summarized",
                "effort": "xhigh",
            }))
            .unwrap()
    }

    mod merging {
        use super::*;

        #[test]
        fn a_line_leaves_the_fields_it_does_not_name_alone() {
            let expected = Some(Effort::Low);

            let actual = whole().merged(&json!({ "effort": "low" })).unwrap();

            assert_eq!(actual.effort, expected);
            assert_eq!(actual.name.as_deref(), Some("claude-opus-5"));
            assert_eq!(actual.max_tokens, Some(120000));
        }

        #[test]
        fn null_clears_an_optional_field() {
            let expected = None;

            let actual = whole().merged(&json!({ "effort": null })).unwrap();

            assert_eq!(actual.effort, expected);
        }

        #[test]
        fn a_rejected_line_leaves_the_cell_exactly_as_it_was() {
            let before = whole();
            let expected = before.clone();

            let actual = before.merged(&json!({ "effort": "low", "name": 7 }));

            assert!(actual.is_err());
            assert_eq!(before, expected);
        }

        #[test]
        fn an_empty_line_changes_nothing() {
            let expected = whole();

            let actual = whole().merged(&json!({})).unwrap();

            assert_eq!(actual, expected);
        }
    }

    mod validation {
        use super::*;

        #[test]
        fn an_unrecognised_field_is_rejected() {
            let actual = Settings::default().merged(&json!({ "budgetTokens": 4096 }));

            assert!(actual.is_err());
        }

        #[test]
        fn a_value_that_is_not_an_object_is_rejected() {
            let actual = Settings::default().merged(&json!("claude-opus-5"));

            assert!(actual.is_err());
        }

        #[test]
        fn max_tokens_below_one_is_rejected() {
            let actual = Settings::default().merged(&json!({ "maxTokens": 0 }));

            assert!(actual.is_err());
        }

        #[test]
        fn max_tokens_has_no_upper_bound() {
            let expected = Some(1_000_000);

            let actual = Settings::default()
                .merged(&json!({ "maxTokens": 1_000_000 }))
                .unwrap();

            assert_eq!(actual.max_tokens, expected);
        }

        #[test]
        fn a_name_is_never_checked_against_a_list() {
            let expected = Some("a-model-that-does-not-exist-yet");

            let actual = Settings::default()
                .merged(&json!({ "name": "a-model-that-does-not-exist-yet" }))
                .unwrap();

            assert_eq!(actual.name.as_deref(), expected);
        }

        #[test]
        fn an_unknown_thinking_mode_is_rejected() {
            let actual = Settings::default().merged(&json!({ "thinking": "enabled" }));

            assert!(actual.is_err());
        }

        #[test]
        fn an_unknown_effort_level_is_rejected() {
            let actual = Settings::default().merged(&json!({ "effort": "adaptive" }));

            assert!(actual.is_err());
        }

        /// Bridge never rejects a combination. This pair is invalid at the
        /// API, and the merge can reach it one field at a time, so the cell
        /// holds it and the render is what resolves it.
        #[test]
        fn disabled_thinking_beside_a_display_is_accepted() {
            let expected = (Some(Thinking::Disabled), Some(ThinkingDisplay::Summarized));

            let actual = Settings::default()
                .merged(&json!({ "thinkingDisplay": "summarized" }))
                .unwrap()
                .merged(&json!({ "thinking": "disabled" }))
                .unwrap();

            assert_eq!((actual.thinking, actual.thinking_display), expected);
        }
    }

    mod resolving {
        use super::*;

        #[test]
        fn a_cell_with_no_name_does_not_resolve() {
            let actual = Settings::default()
                .merged(&json!({ "maxTokens": 8192 }))
                .unwrap()
                .resolve(None);

            assert!(actual.is_err());
        }

        #[test]
        fn a_cell_with_no_max_tokens_does_not_resolve() {
            let actual = Settings::default()
                .merged(&json!({ "name": "claude-opus-5" }))
                .unwrap()
                .resolve(None);

            assert!(actual.is_err());
        }

        #[test]
        fn a_pin_names_the_model_and_the_cell_carries_the_rest() {
            let expected = Resolved {
                name: "claude-sonnet-5".into(),
                max_tokens: 120000,
                thinking: Some(Thinking::Adaptive),
                thinking_display: Some(ThinkingDisplay::Summarized),
                effort: Some(Effort::XHigh),
            };

            let actual = whole().resolve(Some("claude-sonnet-5")).unwrap();

            assert_eq!(actual, expected);
        }

        #[test]
        fn a_pin_supplies_the_name_a_cell_lacks() {
            let expected = "claude-opus-5";

            let actual = Settings::default()
                .merged(&json!({ "maxTokens": 8192 }))
                .unwrap()
                .resolve(Some("claude-opus-5"))
                .unwrap();

            assert_eq!(actual.name, expected);
        }
    }

    mod rendering {
        use super::*;

        fn resolved(line: Value) -> Resolved {
            Settings::default()
                .merged(&json!({ "name": "claude-opus-5", "maxTokens": 8192 }))
                .unwrap()
                .merged(&line)
                .unwrap()
                .resolve(None)
                .unwrap()
        }

        #[test]
        fn adaptive_thinking_carries_its_display() {
            let expected = Some(json!({ "type": "adaptive", "display": "summarized" }));

            let actual =
                resolved(json!({ "thinking": "adaptive", "thinkingDisplay": "summarized" }))
                    .thinking_field();

            assert_eq!(actual, expected);
        }

        #[test]
        fn adaptive_thinking_without_a_display_sends_the_type_alone() {
            let expected = Some(json!({ "type": "adaptive" }));

            let actual = resolved(json!({ "thinking": "adaptive" })).thinking_field();

            assert_eq!(actual, expected);
        }

        /// The pair a merge can reach one field at a time, and the reason
        /// the two are separate fields: display is invalid alongside
        /// disabled, so it is dropped rather than sent.
        #[test]
        fn disabled_thinking_drops_a_display_that_is_set() {
            let expected = Some(json!({ "type": "disabled" }));

            let actual =
                resolved(json!({ "thinking": "disabled", "thinkingDisplay": "summarized" }))
                    .thinking_field();

            assert_eq!(actual, expected);
        }

        #[test]
        fn thinking_unset_sends_no_thinking_field_at_all() {
            let expected = None;

            let actual = resolved(json!({ "thinkingDisplay": "summarized" })).thinking_field();

            assert_eq!(actual, expected);
        }

        #[test]
        fn effort_is_wrapped_as_output_config() {
            let expected = Some(json!({ "effort": "xhigh" }));

            let actual = resolved(json!({ "effort": "xhigh" })).output_config();

            assert_eq!(actual, expected);
        }

        #[test]
        fn effort_unset_sends_no_output_config_at_all() {
            let expected = None;

            let actual = resolved(json!({})).output_config();

            assert_eq!(actual, expected);
        }
    }

    mod echoing {
        use super::*;

        #[test]
        fn the_echo_carries_every_field_that_is_set() {
            let expected = json!({
                "name": "claude-opus-5",
                "maxTokens": 120000,
                "thinking": "adaptive",
                "thinkingDisplay": "summarized",
                "effort": "xhigh",
            });

            let actual = whole().to_json();

            assert_eq!(actual, expected);
        }

        #[test]
        fn the_echo_omits_a_field_that_is_not_set() {
            let expected = json!({ "name": "claude-opus-5" });

            let actual = Settings::default()
                .merged(&json!({ "name": "claude-opus-5" }))
                .unwrap()
                .to_json();

            assert_eq!(actual, expected);
        }
    }
}
