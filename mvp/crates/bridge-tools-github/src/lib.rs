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
//! The crate compiles everywhere. Only the Keychain read behind a call is
//! platform-dependent, and that is a runtime question (`bridge-secrets`),
//! so these tools and their tests exist on every platform.

mod gh;
mod tools;

use std::path::{Path, PathBuf};

use serde_json::Value;

/// The environment gh and git read for GitHub credentials, which no child
/// of bridge's Exec tool may inherit. Provider knowledge, deliberately not
/// configuration: nobody setting up a credential should have to know which
/// variables gh reads, and the provider is the authority on its own CLI.
///
/// `SSH_AUTH_SOCK` is on the list and matters most: an ssh agent would let
/// git authenticate around the token entirely, so leaving it in place would
/// make the token boundary decorative.
pub const AMBIENT_ENV: &[&str] = &["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"];

/// The variable a github credential is provided through. gh prefers it over
/// anything else it might find, which is what makes it the boundary.
pub const TOKEN_ENV: &str = "GH_TOKEN";

/// Where gh keeps the operator's own logged-in session.
pub const CONFIG_DIR_ENV: &str = "GH_CONFIG_DIR";

/// A directory that exists, is empty, and holds no session, for
/// `CONFIG_DIR_ENV` to point at.
///
/// Removing the variable achieves nothing: unset, gh falls back to its real
/// default, which is exactly where the operator's own session lives, and on
/// macOS that session's token sits in the system keyring rather than in any
/// file, so stripping the token variables never touches it. Overriding the
/// location does: with nowhere to read a session from, gh fails closed and
/// asks for a login, while a provided token still works normally.
///
/// An empty directory rather than the `/dev/null` the Azure side of this
/// uses: gh reads `config.yml` out of the directory before it does anything
/// at all, so a non-directory makes it fail to start rather than fail to
/// authenticate.
pub fn dead_config_dir() -> PathBuf {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join("bridge-gh-no-session");
        // Best effort: an unreadable directory is one gh finds no session
        // in, which is the property that matters.
        let _ = std::fs::create_dir_all(&dir);
        dir
    })
    .clone()
}

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
