//! The six specs: for each tool, its schema and the one function that turns
//! its input into argv. Schema and flag mapping sit side by side on purpose,
//! because reviewing the guarantee means reading both at once.
//!
//! Every value-carrying flag is emitted as one `--flag=value` argv element,
//! never as two. A separate value could be read as a flag in its own right
//! if it began with a dash; joined, it cannot be anything but this flag's
//! value.

use serde_json::{Value, json};

pub(crate) struct ToolSpec {
    pub name: &'static str,
    pub subcommand: &'static str,
    pub schema: fn() -> Value,
    pub build_args: fn(&Value) -> Result<Vec<String>, String>,
}

pub(crate) static SPECS: &[ToolSpec] = &[
    ToolSpec {
        name: "GitHub_PullRequest_Create",
        subcommand: "create",
        schema: create_schema,
        build_args: create_args,
    },
    ToolSpec {
        name: "GitHub_PullRequest_Ready",
        subcommand: "ready",
        schema: ready_schema,
        build_args: ready_args,
    },
    ToolSpec {
        name: "GitHub_PullRequest_Edit",
        subcommand: "edit",
        schema: edit_schema,
        build_args: edit_args,
    },
    ToolSpec {
        name: "GitHub_PullRequest_Comment",
        subcommand: "comment",
        schema: comment_schema,
        build_args: comment_args,
    },
    ToolSpec {
        name: "GitHub_PullRequest_AutoMerge",
        subcommand: "merge",
        schema: auto_merge_schema,
        build_args: auto_merge_args,
    },
    ToolSpec {
        name: "GitHub_PullRequest_Review",
        subcommand: "review",
        schema: review_schema,
        build_args: review_args,
    },
];

const CWD_DESCRIPTION: &str = "Directory to run gh in. Decides which repository the command targets, via that directory's git remote, so it is required whenever the conversation's own working directory is not the target repository. Relative paths resolve against the conversation's working directory.";

const NUMBER_DESCRIPTION: &str =
    "The pull request number. Omit to use the pull request on the current branch.";

fn create_schema() -> Value {
    json!({
        "name": "GitHub_PullRequest_Create",
        "description": "Open a new pull request as a draft. Always passes --draft; \
            GitHub_PullRequest_Ready is the separate step that promotes it out of draft.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": { "type": "string", "description": "Title for the pull request." },
                "body": { "type": "string", "description": "Body for the pull request." },
                "base": { "type": "string", "description": "The branch the code should be merged into." },
                "head": { "type": "string", "description": "The branch holding the commits. Defaults to the current branch." },
                "milestone": { "type": "string", "description": "Add the pull request to a milestone by name." },
                "reviewer": { "type": "array", "items": { "type": "string" }, "description": "Request reviews from people or teams by handle." },
                "assignee": { "type": "array", "items": { "type": "string" }, "description": "Assign people by login. \"@me\" self-assigns." },
                "label": { "type": "array", "items": { "type": "string" }, "description": "Add labels by name." },
                "cwd": { "type": "string", "description": CWD_DESCRIPTION }
            },
            "required": ["title", "body", "base"],
            "additionalProperties": false
        }
    })
}

fn create_args(input: &Value) -> Result<Vec<String>, String> {
    let mut args = vec![
        flag("--title", &required_nonempty(input, "title")?),
        flag("--body", &required_string(input, "body")?),
        flag("--base", &required_nonempty(input, "base")?),
        // Unconditional: this tool opens drafts and nothing else.
        "--draft".to_string(),
    ];
    if let Some(head) = optional_string(input, "head")? {
        args.push(flag("--head", &head));
    }
    if let Some(milestone) = optional_string(input, "milestone")? {
        args.push(flag("--milestone", &milestone));
    }
    for reviewer in string_array(input, "reviewer")? {
        args.push(flag("--reviewer", &reviewer));
    }
    for assignee in string_array(input, "assignee")? {
        args.push(flag("--assignee", &assignee));
    }
    for label in string_array(input, "label")? {
        args.push(flag("--label", &label));
    }
    Ok(args)
}

fn ready_schema() -> Value {
    json!({
        "name": "GitHub_PullRequest_Ready",
        "description": "Mark a draft pull request as ready for review.",
        "input_schema": {
            "type": "object",
            "properties": {
                "number": { "type": "integer", "minimum": 1, "description": NUMBER_DESCRIPTION },
                "cwd": { "type": "string", "description": CWD_DESCRIPTION }
            },
            "additionalProperties": false
        }
    })
}

fn ready_args(input: &Value) -> Result<Vec<String>, String> {
    number_arg(input)
}

fn edit_schema() -> Value {
    json!({
        "name": "GitHub_PullRequest_Edit",
        "description": "Edit an existing pull request: title, body, labels, assignees, reviewers, milestone.",
        "input_schema": {
            "type": "object",
            "properties": {
                "number": { "type": "integer", "minimum": 1, "description": NUMBER_DESCRIPTION },
                "title": { "type": "string", "description": "Set a new title." },
                "body": { "type": "string", "description": "Set a new body." },
                "addLabel": { "type": "array", "items": { "type": "string" }, "description": "Add labels by name." },
                "removeLabel": { "type": "array", "items": { "type": "string" }, "description": "Remove labels by name." },
                "addAssignee": { "type": "array", "items": { "type": "string" }, "description": "Add assignees by login. \"@me\" is you." },
                "removeAssignee": { "type": "array", "items": { "type": "string" }, "description": "Remove assignees by login." },
                "addReviewer": { "type": "array", "items": { "type": "string" }, "description": "Add or re-request reviewers by login." },
                "removeReviewer": { "type": "array", "items": { "type": "string" }, "description": "Remove reviewers by login." },
                "milestone": { "type": "string", "description": "Set the milestone by name." },
                "removeMilestone": { "type": "boolean", "description": "Remove the milestone association." },
                "cwd": { "type": "string", "description": CWD_DESCRIPTION }
            },
            "additionalProperties": false
        }
    })
}

fn edit_args(input: &Value) -> Result<Vec<String>, String> {
    let mut args = number_arg(input)?;
    if let Some(title) = optional_string(input, "title")? {
        args.push(flag("--title", &title));
    }
    if let Some(body) = optional_string(input, "body")? {
        args.push(flag("--body", &body));
    }
    for (field, name) in [
        ("addLabel", "--add-label"),
        ("removeLabel", "--remove-label"),
        ("addAssignee", "--add-assignee"),
        ("removeAssignee", "--remove-assignee"),
        ("addReviewer", "--add-reviewer"),
        ("removeReviewer", "--remove-reviewer"),
    ] {
        for value in string_array(input, field)? {
            args.push(flag(name, &value));
        }
    }
    if let Some(milestone) = optional_string(input, "milestone")? {
        args.push(flag("--milestone", &milestone));
    }
    if optional_bool(input, "removeMilestone")?.unwrap_or(false) {
        args.push("--remove-milestone".to_string());
    }
    Ok(args)
}

fn comment_schema() -> Value {
    json!({
        "name": "GitHub_PullRequest_Comment",
        "description": "Add a comment to a pull request.",
        "input_schema": {
            "type": "object",
            "properties": {
                "number": { "type": "integer", "minimum": 1, "description": NUMBER_DESCRIPTION },
                "body": { "type": "string", "description": "The comment body." },
                "cwd": { "type": "string", "description": CWD_DESCRIPTION }
            },
            "required": ["body"],
            "additionalProperties": false
        }
    })
}

fn comment_args(input: &Value) -> Result<Vec<String>, String> {
    let mut args = number_arg(input)?;
    args.push(flag("--body", &required_nonempty(input, "body")?));
    Ok(args)
}

fn auto_merge_schema() -> Value {
    json!({
        "name": "GitHub_PullRequest_AutoMerge",
        "description": "Enable or disable auto-merge on a pull request. Never merges immediately: \
            it queues a merge with --auto plus a strategy flag, or clears the queued merge with \
            --disable-auto.",
        "input_schema": {
            "type": "object",
            "properties": {
                "number": { "type": "integer", "minimum": 1, "description": NUMBER_DESCRIPTION },
                "enable": { "type": "boolean", "description": "true queues auto-merge, false clears it. This tool never performs an immediate merge." },
                "strategy": { "type": "string", "enum": ["merge", "squash", "rebase"], "description": "Merge strategy to queue alongside --auto. Required when enable is true, ignored when disabling." },
                "cwd": { "type": "string", "description": CWD_DESCRIPTION }
            },
            "required": ["enable"],
            "additionalProperties": false
        }
    })
}

fn auto_merge_args(input: &Value) -> Result<Vec<String>, String> {
    let mut args = number_arg(input)?;
    if !required_bool(input, "enable")? {
        args.push("--disable-auto".to_string());
        return Ok(args);
    }
    // The strategy is drawn from a closed set here, not passed through: the
    // flag emitted is one of three literals, so no input can reach gh as a
    // flag of its own.
    let strategy = match optional_string(input, "strategy")?.as_deref() {
        Some("merge") => "--merge",
        Some("squash") => "--squash",
        Some("rebase") => "--rebase",
        Some(other) => return Err(format!("unknown strategy {other:?}")),
        None => return Err("strategy is required when enable is true".to_string()),
    };
    args.push("--auto".to_string());
    args.push(strategy.to_string());
    Ok(args)
}

fn review_schema() -> Value {
    json!({
        "name": "GitHub_PullRequest_Review",
        "description": "Leave a review on a pull request: a comment, or a request for changes. \
            This tool cannot approve a pull request, and \"approve\" is not a value its type field \
            can hold.",
        "input_schema": {
            "type": "object",
            "properties": {
                "number": { "type": "integer", "minimum": 1, "description": NUMBER_DESCRIPTION },
                "type": { "type": "string", "enum": ["comment", "request-changes"], "description": "The kind of review to leave. There is no approve option." },
                "body": { "type": "string", "description": "The review body." },
                "cwd": { "type": "string", "description": CWD_DESCRIPTION }
            },
            "required": ["type", "body"],
            "additionalProperties": false
        }
    })
}

fn review_args(input: &Value) -> Result<Vec<String>, String> {
    let mut args = number_arg(input)?;
    // Two literals, and neither is --approve. An unrecognised type is
    // rejected rather than defaulted, so no input can widen this.
    let kind = match required_nonempty(input, "type")?.as_str() {
        "comment" => "--comment",
        "request-changes" => "--request-changes",
        other => return Err(format!("unknown review type {other:?}")),
    };
    args.push(kind.to_string());
    args.push(flag("--body", &required_nonempty(input, "body")?));
    Ok(args)
}

/// One argv element carrying both flag and value, so the value can never be
/// parsed as a flag of its own.
fn flag(name: &str, value: &str) -> String {
    format!("{name}={value}")
}

/// The optional leading pull request number, as gh's positional argument.
/// Numeric by construction, so it cannot look like a flag.
fn number_arg(input: &Value) -> Result<Vec<String>, String> {
    match &input["number"] {
        Value::Null => Ok(Vec::new()),
        Value::Number(n) => match n.as_u64() {
            Some(n) if n > 0 => Ok(vec![n.to_string()]),
            _ => Err("number must be a positive whole number".to_string()),
        },
        _ => Err("number must be a positive whole number".to_string()),
    }
}

fn required_string(input: &Value, field: &str) -> Result<String, String> {
    match &input[field] {
        Value::String(s) => Ok(s.clone()),
        Value::Null => Err(format!("missing {field}")),
        _ => Err(format!("{field} must be a string")),
    }
}

fn required_nonempty(input: &Value, field: &str) -> Result<String, String> {
    let value = required_string(input, field)?;
    if value.trim().is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    Ok(value)
}

fn optional_string(input: &Value, field: &str) -> Result<Option<String>, String> {
    match &input[field] {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(format!("{field} must be a string")),
    }
}

fn required_bool(input: &Value, field: &str) -> Result<bool, String> {
    match &input[field] {
        Value::Bool(b) => Ok(*b),
        Value::Null => Err(format!("missing {field}")),
        _ => Err(format!("{field} must be true or false")),
    }
}

fn optional_bool(input: &Value, field: &str) -> Result<Option<bool>, String> {
    match &input[field] {
        Value::Null => Ok(None),
        Value::Bool(b) => Ok(Some(*b)),
        _ => Err(format!("{field} must be true or false")),
    }
}

fn string_array(input: &Value, field: &str) -> Result<Vec<String>, String> {
    match &input[field] {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(s) => Ok(s.clone()),
                _ => Err(format!("{field} must be an array of strings")),
            })
            .collect(),
        _ => Err(format!("{field} must be an array of strings")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_for(name: &str, input: Value) -> Result<Vec<String>, String> {
        let spec = SPECS.iter().find(|s| s.name == name).expect("known tool");
        (spec.build_args)(&input)
    }

    #[test]
    fn create_always_opens_a_draft() {
        let args = args_for(
            "GitHub_PullRequest_Create",
            json!({ "title": "t", "body": "b", "base": "main" }),
        )
        .unwrap();
        assert!(args.contains(&"--draft".to_string()), "{args:?}");
    }

    /// Nothing in the input can add a flag of its own: a value that looks
    /// like one rides inside its flag's own argv element.
    #[test]
    fn a_value_that_looks_like_a_flag_stays_a_value() {
        let args = args_for(
            "GitHub_PullRequest_Create",
            json!({ "title": "--repo=someone/else", "body": "b", "base": "main" }),
        )
        .unwrap();
        assert!(
            args.contains(&"--title=--repo=someone/else".to_string()),
            "{args:?}"
        );
        assert!(!args.iter().any(|a| a == "--repo=someone/else"), "{args:?}");
    }

    #[test]
    fn review_can_comment_or_request_changes_and_nothing_else() {
        let comment = args_for(
            "GitHub_PullRequest_Review",
            json!({ "type": "comment", "body": "b" }),
        )
        .unwrap();
        assert!(comment.contains(&"--comment".to_string()), "{comment:?}");

        let changes = args_for(
            "GitHub_PullRequest_Review",
            json!({ "type": "request-changes", "body": "b" }),
        )
        .unwrap();
        assert!(
            changes.contains(&"--request-changes".to_string()),
            "{changes:?}"
        );
    }

    #[test]
    fn review_cannot_approve() {
        for attempt in ["approve", "APPROVE", "--approve", "comment --approve"] {
            let result = args_for(
                "GitHub_PullRequest_Review",
                json!({ "type": attempt, "body": "b" }),
            );
            assert!(result.is_err(), "{attempt:?} was accepted: {result:?}");
        }
    }

    #[test]
    fn auto_merge_queues_a_merge_and_never_performs_one() {
        let enable = args_for(
            "GitHub_PullRequest_AutoMerge",
            json!({ "number": 42, "enable": true, "strategy": "squash" }),
        )
        .unwrap();
        assert_eq!(enable, vec!["42", "--auto", "--squash"]);

        let disable = args_for(
            "GitHub_PullRequest_AutoMerge",
            json!({ "number": 42, "enable": false }),
        )
        .unwrap();
        assert_eq!(disable, vec!["42", "--disable-auto"]);
    }

    #[test]
    fn auto_merge_without_a_strategy_is_rejected_rather_than_defaulted() {
        let result = args_for("GitHub_PullRequest_AutoMerge", json!({ "enable": true }));
        assert!(result.is_err(), "{result:?}");
    }

    #[test]
    fn an_omitted_number_leaves_gh_to_use_the_current_branch() {
        let args = args_for("GitHub_PullRequest_Ready", json!({})).unwrap();
        assert!(args.is_empty(), "{args:?}");
    }

    #[test]
    fn a_number_that_is_not_a_positive_whole_number_is_rejected() {
        for bad in [json!(0), json!(-4), json!("42"), json!(1.5)] {
            let result = args_for("GitHub_PullRequest_Ready", json!({ "number": bad }));
            assert!(result.is_err(), "{bad} was accepted: {result:?}");
        }
    }

    #[test]
    fn edit_carries_every_list_flag_once_per_item() {
        let args = args_for(
            "GitHub_PullRequest_Edit",
            json!({ "number": 7, "addLabel": ["bug", "urgent"], "removeReviewer": ["someone"] }),
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "7",
                "--add-label=bug",
                "--add-label=urgent",
                "--remove-reviewer=someone"
            ]
        );
    }

    #[test]
    fn a_missing_required_field_fails_before_anything_runs() {
        let result = args_for(
            "GitHub_PullRequest_Create",
            json!({ "title": "t", "base": "main" }),
        );
        assert_eq!(result, Err("missing body".to_string()));
    }

    #[test]
    fn create_rejects_an_empty_title_but_allows_an_empty_body() {
        assert!(
            args_for(
                "GitHub_PullRequest_Create",
                json!({ "title": "  ", "body": "b", "base": "main" })
            )
            .is_err()
        );
        assert!(
            args_for(
                "GitHub_PullRequest_Create",
                json!({ "title": "t", "body": "", "base": "main" })
            )
            .is_ok()
        );
    }
}
