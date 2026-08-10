//! The six GitHub pull request tools.
//!
//! Each tool hardcodes one gh subcommand and the exact set of flags it can
//! ever emit. That is the whole point: a generic "run gh with this command"
//! tool would carry whatever the model wrote, and GitHub's fine-grained
//! tokens have no permission below the `Pull requests: read-write` bucket to
//! fall back on. Here the mapping from typed input to argv is code, so
//! whatever lands in the fields, only these flags reach gh.
//!
//! Three guarantees the flag mappings make structurally, not by asking:
//! Create always passes `--draft`; Review can emit `--comment` or
//! `--request-changes` and its `type` field holds no value that could mean
//! approve; AutoMerge emits `--auto` or `--disable-auto` and never merges
//! immediately.
//!
//! gh is spawned here rather than through bridge's Exec tool. Exec runs
//! user-specified pipelines and its environment is the ordinary, default
//! credential's; the privileged credential exists only inside the one gh
//! child that needs it, and is read from the Keychain at the moment that
//! child is spawned.
//!
//! macOS only, because the Keychain read is (`bridge-secrets`). The crate is
//! empty on every other platform.
#![cfg(target_os = "macos")]

mod gh;
mod tools;

use std::path::Path;

use serde_json::Value;

/// The environment gh and git read for GitHub credentials, which a
/// configured github credential displaces. Provider knowledge, deliberately
/// not configuration: nobody setting up a credential should have to know
/// which variables gh reads.
///
/// `SSH_AUTH_SOCK` is on the list and matters most: an ssh agent would let
/// git authenticate around the token entirely, so leaving it in place would
/// make the token boundary decorative.
pub const AMBIENT_ENV: &[&str] = &["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"];

/// The variable a github credential is provided through. gh prefers it over
/// anything else it might find, which is what makes it the boundary.
pub const TOKEN_ENV: &str = "GH_TOKEN";

/// Every tool schema this crate offers, in a fixed order. Part of bridge's
/// static tool array, so this is a constant of the build: it never varies
/// with configuration, and never per query.
pub fn schemas() -> Vec<Value> {
    tools::SPECS.iter().map(|spec| (spec.schema)()).collect()
}

/// Whether a tool name belongs to this crate — bridge's dispatch asks before
/// routing.
pub fn owns(name: &str) -> bool {
    tools::SPECS.iter().any(|spec| spec.name == name)
}

/// Run one tool: map its input to a fixed argv, read `account`'s secret from
/// the Keychain, and spawn gh with it. `cwd` decides which repository the
/// command targets (via that directory's git remote) and is already resolved
/// by the caller.
///
/// Returns the tool_result's two halves, `(content, is_error)`. An input the
/// flag mapping cannot accept fails here, before anything is spawned and
/// before the credential is read.
pub async fn run(name: &str, input: &Value, cwd: &Path, account: &str) -> (String, bool) {
    let Some(spec) = tools::SPECS.iter().find(|spec| spec.name == name) else {
        return (format!("unknown tool {name:?}"), true);
    };
    match (spec.build_args)(input) {
        Ok(args) => gh::run(spec.subcommand, &args, cwd, account).await,
        Err(e) => (format!("invalid {name} input: {e}"), true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_schema_carries_the_name_dispatch_routes_on() {
        for (spec, schema) in tools::SPECS.iter().zip(schemas()) {
            assert_eq!(schema["name"], spec.name);
            assert!(owns(spec.name), "{} is not routable", spec.name);
        }
    }

    #[test]
    fn six_tools_are_offered() {
        assert_eq!(schemas().len(), 6);
    }
}
