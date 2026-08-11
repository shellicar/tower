//! Credentials and the tool groups that bind them: the two `credentials` and
//! `tools` control lines, each one cell replaced whole.
//!
//! Two closed sets the build knows: the providers a credential can name, and
//! the tool groups a binding can name. An unknown word in either is rejected
//! when the line arrives, because a typo that silently configures nothing is
//! the failure this exists to prevent.
//!
//! A credential name that does not exist is different: it is accepted with a
//! warning and the group binding it is simply not active. That is what lets
//! the two lines arrive in either order, since neither can be validated
//! against a cell the other has not filled yet. Everything is resolved at the
//! point of use instead.
//!
//! What a credential displaces is code, never configuration. Nobody setting
//! one up should have to know which environment variables gh reads, so the
//! list belongs to the provider and configuring any credential for that
//! provider is what applies it.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

/// The providers this build knows. Closed: an unknown one is rejected when
/// the line arrives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Provider {
    Github,
}

impl Provider {
    pub const KNOWN: &'static [&'static str] = &["github"];

    fn parse(word: &str) -> Option<Self> {
        match word {
            "github" => Some(Self::Github),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Github => "github",
        }
    }

    /// The ambient environment an Exec child must never inherit for this
    /// provider. Provider knowledge, held next to the tools that speak for
    /// the provider.
    pub fn ambient_env(self) -> &'static [&'static str] {
        match self {
            Self::Github => bridge_tools_github::AMBIENT_ENV,
        }
    }

    /// What an Exec child must be given, rather than have taken away, for
    /// this provider. A CLI that falls back to a default location when its
    /// override is absent cannot be cut off by deleting the override: the
    /// fallback is exactly where the operator's own session lives. Pointing
    /// it somewhere with no session in it is what closes that route.
    pub fn forced_env(self) -> Vec<(String, String)> {
        match self {
            Self::Github => vec![(
                bridge_tools_github::CONFIG_DIR_ENV.to_string(),
                bridge_tools_github::dead_config_dir()
                    .to_string_lossy()
                    .into_owned(),
            )],
        }
    }

    /// The variable a credential for this provider is provided through.
    pub fn token_env(self) -> &'static str {
        match self {
            Self::Github => bridge_tools_github::TOKEN_ENV,
        }
    }
}

/// One configured credential. `account` names a Keychain item; the secret
/// itself is never held here, only read at the moment a child is spawned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    pub provider: Provider,
    pub account: String,
    pub enabled: bool,
}

/// The `credentials` cell: every configured credential by name.
#[derive(Debug, Clone, Default)]
pub struct Credentials(pub BTreeMap<String, Credential>);

/// One tool group's binding. `github` binds one credential and `exec` binds a
/// list, because exec can run anything and may need to carry several at once;
/// both are held as a list so resolution is one path.
#[derive(Debug, Clone)]
pub struct Binding {
    pub credentials: Vec<String>,
    pub enabled: bool,
}

/// The `tools` cell. A group absent from the line is unconfigured, not
/// disabled: the line replaces the cell whole, so absence is the only way to
/// say "not set".
#[derive(Debug, Clone, Default)]
pub struct ToolsConfig {
    pub github: Option<Binding>,
    pub exec: Option<Binding>,
}

impl ToolsConfig {
    pub const KNOWN_GROUPS: &'static [&'static str] = &["exec", "github"];
}

/// What a group resolves to right now, against whatever the credentials cell
/// currently holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupState {
    /// No binding for this group at all.
    Unconfigured,
    /// Bound, but the binding or one of its credentials is switched off.
    Disabled,
    /// Bound to credential names that are not configured. Taken whole: a
    /// group is not partly active, so one absent name leaves it inactive.
    Missing(Vec<String>),
    Active(Vec<Credential>),
}

impl GroupState {
    pub fn active(&self) -> Option<&[Credential]> {
        match self {
            Self::Active(credentials) => Some(credentials),
            _ => None,
        }
    }
}

pub fn parse_credentials(value: &Value) -> Result<Credentials, String> {
    let object = value
        .as_object()
        .ok_or("credentials must be an object of name to credential")?;
    let mut out = BTreeMap::new();
    for (name, entry) in object {
        let entry = entry
            .as_object()
            .ok_or_else(|| format!("credential {name:?} must be an object"))?;
        let word = entry
            .get("provider")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("credential {name:?} needs a provider"))?;
        let provider = Provider::parse(word).ok_or_else(|| {
            format!(
                "credential {name:?} names unknown provider {word:?}; known providers: {}",
                Provider::KNOWN.join(", ")
            )
        })?;
        let account = entry
            .get("account")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("credential {name:?} needs an account"))?
            .to_string();
        let enabled = enabled_field(entry.get("enabled"), &format!("credential {name:?}"))?;
        out.insert(
            name.clone(),
            Credential {
                provider,
                account,
                enabled,
            },
        );
    }
    Ok(Credentials(out))
}

pub fn parse_tools(value: &Value) -> Result<ToolsConfig, String> {
    let object = value
        .as_object()
        .ok_or("tools must be an object of group to binding")?;
    let mut out = ToolsConfig::default();
    for (group, entry) in object {
        match group.as_str() {
            "github" => out.github = Some(parse_binding(entry, group, Arity::One)?),
            "exec" => out.exec = Some(parse_binding(entry, group, Arity::Many)?),
            other => {
                return Err(format!(
                    "unknown tools group {other:?}; known groups: {}",
                    ToolsConfig::KNOWN_GROUPS.join(", ")
                ));
            }
        }
    }
    Ok(out)
}

enum Arity {
    One,
    Many,
}

fn parse_binding(entry: &Value, group: &str, arity: Arity) -> Result<Binding, String> {
    let object = entry
        .as_object()
        .ok_or_else(|| format!("tools group {group:?} must be an object"))?;
    let named = object
        .get("credentials")
        .ok_or_else(|| format!("tools group {group:?} needs credentials"))?;
    let credentials = match arity {
        Arity::One => vec![
            named
                .as_str()
                .ok_or_else(|| {
                    format!("tools group {group:?} takes one credential name, as a string")
                })?
                .to_string(),
        ],
        Arity::Many => named
            .as_array()
            .ok_or_else(|| format!("tools group {group:?} takes a list of credential names"))?
            .iter()
            .map(|name| {
                name.as_str().map(str::to_string).ok_or_else(|| {
                    format!("tools group {group:?} takes a list of credential names")
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    let enabled = enabled_field(object.get("enabled"), &format!("tools group {group:?}"))?;
    Ok(Binding {
        credentials,
        enabled,
    })
}

/// `enabled` defaults to true wherever it appears.
fn enabled_field(value: Option<&Value>, what: &str) -> Result<bool, String> {
    match value {
        None | Some(Value::Null) => Ok(true),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(format!("{what} has a non-boolean enabled")),
    }
}

pub fn resolve(credentials: &Credentials, binding: Option<&Binding>) -> GroupState {
    let Some(binding) = binding else {
        return GroupState::Unconfigured;
    };
    if !binding.enabled {
        return GroupState::Disabled;
    }
    let missing: Vec<String> = binding
        .credentials
        .iter()
        .filter(|name| !credentials.0.contains_key(*name))
        .cloned()
        .collect();
    if !missing.is_empty() {
        return GroupState::Missing(missing);
    }
    let resolved: Vec<Credential> = binding
        .credentials
        .iter()
        .filter_map(|name| credentials.0.get(name))
        .cloned()
        .collect();
    if resolved.iter().any(|credential| !credential.enabled) {
        return GroupState::Disabled;
    }
    GroupState::Active(resolved)
}

/// Every warning the two cells produce together, recomputed from scratch:
/// both control lines and `settings` report the same list, so a `credentials`
/// line that orphans a binding warns exactly as the `tools` line naming it
/// first did.
pub fn warnings(credentials: &Credentials, tools: &ToolsConfig) -> Vec<String> {
    let mut out = Vec::new();
    for (group, binding) in [("exec", &tools.exec), ("github", &tools.github)] {
        if let GroupState::Missing(names) = resolve(credentials, binding.as_ref()) {
            for name in names {
                out.push(format!(
                    "tools group {group:?} names credential {name:?}, which is not configured; the group is not active"
                ));
            }
        }
    }
    out
}

/// What Exec's children get: for every provider this host has credentials
/// for, that provider's ambient credentials removed and its session location
/// pointed somewhere empty, and then whatever the exec group carries.
///
/// A provider nobody configured is left alone entirely. Removing a route and
/// replacing it are one act: a host that never opted into this keeps the
/// environment it always had.
#[derive(Debug, Clone, Default)]
pub struct ExecCredentials {
    pub strip: Vec<String>,
    pub provide: Vec<(String, String)>,
}

/// The providers this host has credentials for. Configuring a credential
/// for a provider is what makes that provider active, and an active
/// provider's env provider applies to every Exec child.
///
/// Read off the credentials cell alone. Which group binds a credential does
/// not enter into it: the `tools` mapping decides what Exec is given, never
/// whether the provider's environment is governed at all. So a host that
/// configures a github credential and binds it only to the privileged tools
/// still has gh's ambient environment taken off its Exec children, with
/// nothing put back.
fn active_providers(credentials: &Credentials) -> BTreeSet<Provider> {
    credentials
        .0
        .values()
        .filter(|credential| credential.enabled)
        .map(|credential| credential.provider)
        .collect()
}

/// What an active provider's env provider removes.
pub fn active_strip_list(credentials: &Credentials) -> Vec<String> {
    let mut names: BTreeSet<String> = BTreeSet::new();
    for provider in active_providers(credentials) {
        names.extend(provider.ambient_env().iter().map(|n| (*n).to_string()));
    }
    names.into_iter().collect()
}

/// The other half of an active provider's env provider: what must be forced
/// rather than removed, because removing it only sends the CLI back to its
/// real default.
pub fn active_forced_env(credentials: &Credentials) -> Vec<(String, String)> {
    active_providers(credentials)
        .into_iter()
        .flat_map(|provider| provider.forced_env())
        .collect()
}

/// Fails closed: a credential the exec group binds but that cannot be read
/// fails the Exec call rather than letting it run without one. A misread
/// credential otherwise surfaces as a puzzling 401 from whatever the command
/// was, long after the cause.
///
/// An unsupported platform is not that case. There, nothing is injected and
/// the call proceeds with the active providers' env providers alone, which
/// is the strictest state and not an error: the child simply has no way to
/// authenticate.
pub fn exec_credentials(
    credentials: &Credentials,
    tools: &ToolsConfig,
) -> Result<ExecCredentials, String> {
    let strip = active_strip_list(credentials);
    let mut provide = active_forced_env(credentials);
    if bridge_secrets::keychain_supported()
        && let Some(active) = resolve(credentials, tools.exec.as_ref()).active()
    {
        for credential in active {
            let secret = read_secret(&credential.account)?;
            provide.push((credential.provider.token_env().to_string(), secret));
        }
    }
    Ok(ExecCredentials { strip, provide })
}

fn read_secret(account: &str) -> Result<String, String> {
    bridge_secrets::read(account)
        .map_err(|e| format!("credential could not be read: {:#}", anyhow::Error::new(e)))
}

/// The `settings` view: what the two cells currently hold, and what each
/// group resolves to against the other.
pub fn settings(credentials: &Credentials, tools: &ToolsConfig) -> Value {
    let configured: BTreeMap<&String, Value> = credentials
        .0
        .iter()
        .map(|(name, credential)| {
            (
                name,
                json!({
                    "provider": credential.provider.name(),
                    "account": credential.account,
                    "enabled": credential.enabled,
                }),
            )
        })
        .collect();
    let groups: BTreeMap<&str, Value> = [("exec", &tools.exec), ("github", &tools.github)]
        .into_iter()
        .map(|(group, binding)| {
            let state = resolve(credentials, binding.as_ref());
            (
                group,
                json!({
                    "credentials": binding.as_ref().map(|b| b.credentials.clone()).unwrap_or_default(),
                    "enabled": binding.as_ref().is_none_or(|b| b.enabled),
                    "state": state_word(&state),
                }),
            )
        })
        .collect();
    json!({ "credentials": configured, "tools": groups })
}

fn state_word(state: &GroupState) -> &'static str {
    match state {
        GroupState::Unconfigured => "unconfigured",
        GroupState::Disabled => "disabled",
        GroupState::Missing(_) => "missing",
        GroupState::Active(_) => "active",
    }
}

/// The groups a conversation is told about: the ones whose configuration
/// decides whether their tools work at all. Exec is not among them; it runs
/// whatever its credentials resolve to, so its state changes nothing the
/// model would do differently.
/// `keychain_supported` is passed in rather than read here, so both answers
/// are testable on any host. The caller reads the platform once.
pub fn conversation_state(
    credentials: &Credentials,
    tools: &ToolsConfig,
    keychain_supported: bool,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    out.insert(
        "GitHub pull request tools".to_string(),
        describe(
            &resolve(credentials, tools.github.as_ref()),
            keychain_supported,
        ),
    );
    out
}

fn describe(state: &GroupState, keychain_supported: bool) -> String {
    // The schemas are offered on every platform, so a host that cannot read
    // a credential has to say so here. Otherwise a configured group reads as
    // available somewhere no call could ever authenticate.
    if !keychain_supported {
        return "not available: this host cannot read credentials, so calling one returns an error"
            .to_string();
    }
    match state {
        GroupState::Unconfigured => "not configured, so calling one returns an error".to_string(),
        GroupState::Disabled => "turned off, so calling one returns an error".to_string(),
        GroupState::Missing(names) => format!(
            "not available: the credential named for it ({}) is not configured, so calling one returns an error",
            names.join(", ")
        ),
        GroupState::Active(_) => "available".to_string(),
    }
}

/// The full state, committed onto a conversation's opening message, so the
/// record holds what the model was told.
pub fn reminder(state: &BTreeMap<String, String>) -> Option<String> {
    if state.is_empty() {
        return None;
    }
    let mut text = String::from("<system-reminder>\nTool availability:\n\n");
    for (group, status) in state {
        text.push_str(&format!("- {group}: {status}\n"));
    }
    text.push_str("</system-reminder>\n\n");
    Some(text)
}

/// A delta against what this conversation was last told, for a say after its
/// first. Same discipline as the skills catalogue: the full state at birth, a
/// delta thereafter, so a live reconfiguration reaches a running conversation
/// without repeating what it already knows.
pub fn delta(
    previous: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
) -> Option<String> {
    let changed: Vec<String> = current
        .iter()
        .filter(|(group, status)| previous.get(*group) != Some(status))
        .map(|(group, status)| format!("- {group}: {status}"))
        .collect();
    if changed.is_empty() {
        return None;
    }
    Some(format!(
        "<system-reminder>\nTool availability has changed:\n\n{}\n</system-reminder>\n\n",
        changed.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(value: Value) -> Credentials {
        parse_credentials(&value).expect("valid credentials")
    }

    fn tools(value: Value) -> ToolsConfig {
        parse_tools(&value).expect("valid tools")
    }

    fn two_credentials() -> Credentials {
        creds(json!({
            "github-privileged": { "provider": "github", "account": "gh-holder" },
            "github-default": { "provider": "github", "account": "gh-reader" },
        }))
    }

    #[test]
    fn an_unknown_provider_is_rejected_when_the_line_arrives() {
        let error = parse_credentials(&json!({
            "azure": { "provider": "azure-devops", "account": "sp" }
        }))
        .expect_err("an unknown provider must not be accepted");
        assert!(error.contains("azure-devops"), "{error}");
        assert!(error.contains("github"), "{error}");
    }

    #[test]
    fn an_unknown_tools_group_is_rejected_when_the_line_arrives() {
        let error = parse_tools(&json!({ "gitlab": { "credentials": "x" } }))
            .expect_err("an unknown group must not be accepted");
        assert!(error.contains("gitlab"), "{error}");
    }

    #[test]
    fn enabled_defaults_to_true_on_a_credential_and_on_a_group() {
        let credentials = two_credentials();
        assert!(credentials.0["github-privileged"].enabled);
        let config = tools(json!({ "github": { "credentials": "github-privileged" } }));
        assert!(config.github.expect("a github binding").enabled);
    }

    #[test]
    fn a_group_takes_one_credential_and_exec_takes_a_list() {
        let config = tools(json!({
            "github": { "credentials": "github-privileged" },
            "exec": { "credentials": ["github-default"] },
        }));
        assert_eq!(
            config.github.expect("github").credentials,
            vec!["github-privileged"]
        );
        assert_eq!(
            config.exec.expect("exec").credentials,
            vec!["github-default"]
        );

        assert!(parse_tools(&json!({ "github": { "credentials": ["a"] } })).is_err());
        assert!(parse_tools(&json!({ "exec": { "credentials": "a" } })).is_err());
    }

    /// Neither line can be validated against the other's cell, so an unknown
    /// name is a warning rather than a rejection and the group is simply not
    /// active. That is what makes the two lines order-independent.
    #[test]
    fn a_credential_that_does_not_exist_leaves_the_group_inactive_with_a_warning() {
        let config = tools(json!({ "github": { "credentials": "not-configured-yet" } }));
        let credentials = Credentials::default();

        assert_eq!(
            resolve(&credentials, config.github.as_ref()),
            GroupState::Missing(vec!["not-configured-yet".to_string()])
        );
        let warnings = warnings(&credentials, &config);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("not-configured-yet"), "{warnings:?}");
    }

    #[test]
    fn the_two_lines_resolve_the_same_whichever_arrived_first() {
        let config = tools(json!({ "github": { "credentials": "github-privileged" } }));
        let credentials = two_credentials();
        let state = resolve(&credentials, config.github.as_ref());
        assert!(state.active().is_some(), "{state:?}");
        assert!(warnings(&credentials, &config).is_empty());
    }

    #[test]
    fn a_disabled_credential_leaves_its_group_inactive() {
        let credentials = creds(json!({
            "github-privileged": { "provider": "github", "account": "gh-holder", "enabled": false }
        }));
        let config = tools(json!({ "github": { "credentials": "github-privileged" } }));
        assert_eq!(
            resolve(&credentials, config.github.as_ref()),
            GroupState::Disabled
        );
    }

    /// Configuring a credential for a provider is what makes that provider
    /// active, and an active provider's env provider governs every Exec
    /// child. Which group binds it does not enter into it: here nothing is
    /// bound to exec at all.
    #[test]
    fn a_configured_provider_governs_exec_whatever_the_tools_mapping_says() {
        let credentials = creds(json!({
            "github-privileged": { "provider": "github", "account": "gh-holder" }
        }));
        let strip = active_strip_list(&credentials);
        assert!(strip.contains(&"GH_TOKEN".to_string()), "{strip:?}");
        assert!(strip.contains(&"GITHUB_TOKEN".to_string()), "{strip:?}");
        assert!(strip.contains(&"SSH_AUTH_SOCK".to_string()), "{strip:?}");
    }

    /// A provider nobody configured is left alone entirely. Removing a route
    /// and replacing it are one act, so a host that never opted in keeps the
    /// environment it always had.
    #[test]
    fn an_unconfigured_provider_is_left_alone() {
        let none = Credentials::default();
        assert!(active_strip_list(&none).is_empty());
        assert!(active_forced_env(&none).is_empty());
    }

    #[test]
    fn a_disabled_credential_does_not_activate_its_provider() {
        let credentials = creds(json!({
            "github-privileged": { "provider": "github", "account": "gh-holder", "enabled": false }
        }));
        assert!(active_strip_list(&credentials).is_empty());
    }

    /// Removing the variables is not enough on its own: unset, gh reads the
    /// operator's own session from its default location, which on macOS
    /// keeps its token in the system keyring where no amount of stripping
    /// reaches. The location is forced somewhere empty instead.
    #[test]
    fn a_providers_session_location_is_forced_somewhere_with_no_session_in_it() {
        let credentials = creds(json!({
            "github-privileged": { "provider": "github", "account": "gh-holder" }
        }));
        let forced = active_forced_env(&credentials);
        let (name, value) = forced
            .iter()
            .find(|(name, _)| name == "GH_CONFIG_DIR")
            .expect("gh's session location is forced");
        assert_eq!(name, "GH_CONFIG_DIR");
        let real = bridge::home::home_dir()
            .map(|home| std::path::PathBuf::from(home).join(".config/gh"))
            .expect("a home directory");
        assert_ne!(std::path::Path::new(value), real);
        // The property is that no session lives there, not that the
        // directory is untouched: gh may write its own preferences in.
        // hosts.yml is where a logged-in account is recorded.
        assert!(std::path::Path::new(value).is_dir(), "{value} must exist");
        assert!(
            !std::path::Path::new(value).join("hosts.yml").exists(),
            "the forced location holds a session: {value}"
        );
    }

    /// The case this rule exists for: github is configured, so the provider
    /// is active and governs Exec, but nothing is bound to exec, so there is
    /// nothing to put back. The route closes rather than staying open beside
    /// the privileged tools.
    #[test]
    fn a_provider_configured_for_the_tools_alone_closes_exec_with_nothing_put_back() {
        let credentials = creds(json!({
            "github-privileged": { "provider": "github", "account": "gh-holder" }
        }));
        let config = tools(json!({ "github": { "credentials": "github-privileged" } }));

        let resolved = exec_credentials(&credentials, &config).expect("not an error");

        assert!(resolved.strip.contains(&"GH_TOKEN".to_string()));
        assert!(
            resolved
                .provide
                .iter()
                .any(|(name, _)| name == "GH_CONFIG_DIR"),
            "gh must find no session to fall back to: {:?}",
            resolved.provide
        );
        assert!(
            !resolved.provide.iter().any(|(name, _)| name == "GH_TOKEN"),
            "nothing is bound to exec, so nothing is put back: {:?}",
            resolved.provide
        );
    }

    #[test]
    fn an_unconfigured_host_changes_nothing_about_an_exec_child() {
        let resolved = exec_credentials(&Credentials::default(), &ToolsConfig::default())
            .expect("an unconfigured host is not an error");
        assert!(resolved.strip.is_empty(), "{:?}", resolved.strip);
        assert!(resolved.provide.is_empty(), "{:?}", resolved.provide);
    }

    #[test]
    fn a_conversation_is_told_a_group_it_cannot_use() {
        let state = conversation_state(&Credentials::default(), &ToolsConfig::default(), true);
        let reminder = reminder(&state).expect("a conversation is always told the state");
        assert!(reminder.contains("GitHub pull request tools"), "{reminder}");
        assert!(reminder.contains("not configured"), "{reminder}");
    }

    /// A host that cannot read a credential says so, rather than reporting
    /// the configuration it would have used. The tools are offered there
    /// too, so this line is the only thing that tells the model otherwise.
    #[test]
    fn a_host_that_cannot_read_a_credential_says_so_however_it_is_configured() {
        let config = tools(json!({ "github": { "credentials": "github-privileged" } }));
        let state = conversation_state(&two_credentials(), &config, false);
        let status = &state["GitHub pull request tools"];
        assert!(status.contains("cannot read credentials"), "{status}");
        assert_ne!(
            status, "available",
            "a configured group must not read as usable here"
        );
    }

    #[test]
    fn a_delta_names_only_what_changed() {
        let before = conversation_state(&Credentials::default(), &ToolsConfig::default(), true);
        assert!(delta(&before, &before).is_none());

        let credentials = two_credentials();
        let config = tools(json!({ "github": { "credentials": "github-privileged" } }));
        let after = conversation_state(&credentials, &config, true);
        let delta = delta(&before, &after).expect("the change is announced");
        assert!(
            delta.contains("GitHub pull request tools: available"),
            "{delta}"
        );
    }
}
