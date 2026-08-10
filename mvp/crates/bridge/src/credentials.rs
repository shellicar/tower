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

    /// The ambient environment a configured credential for this provider
    /// displaces from an Exec child. Provider knowledge, held next to the
    /// tools that speak for the provider.
    pub fn ambient_env(self) -> &'static [&'static str] {
        match self {
            #[cfg(target_os = "macos")]
            Self::Github => bridge_tools_github::AMBIENT_ENV,
            // The github tools are not compiled in off macOS, and no
            // credential can be read there, so there is nothing to provide
            // in the ambient environment's place.
            #[cfg(not(target_os = "macos"))]
            Self::Github => &[],
        }
    }

    /// The variable a credential for this provider is provided through.
    pub fn token_env(self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::Github => bridge_tools_github::TOKEN_ENV,
            #[cfg(not(target_os = "macos"))]
            Self::Github => "GH_TOKEN",
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

/// What Exec's children get: the ambient environment removed, and whatever
/// the exec group carries put in its place.
///
/// Stripping and providing are configured separately on purpose. Configuring
/// *any* credential for a provider is what removes that provider's ambient
/// environment from Exec, whichever group binds it, because a privileged
/// credential held by another group is worth nothing if Exec can still reach
/// the same service with what it inherited. What Exec then carries is only
/// what its own group binds.
#[derive(Debug, Clone, Default)]
pub struct ExecCredentials {
    pub strip: Vec<String>,
    pub provide: Vec<(String, String)>,
}

/// The strip half, which needs no secrets and so is decided here in full.
pub fn strip_list(credentials: &Credentials) -> Vec<String> {
    let providers: BTreeSet<Provider> = credentials
        .0
        .values()
        .filter(|credential| credential.enabled)
        .map(|credential| credential.provider)
        .collect();
    let mut names: BTreeSet<String> = BTreeSet::new();
    for provider in providers {
        names.extend(provider.ambient_env().iter().map(|n| (*n).to_string()));
    }
    names.into_iter().collect()
}

/// Fails closed: a credential the exec group binds but that cannot be read
/// fails the Exec call rather than letting it run without one. A misread
/// credential otherwise surfaces as a puzzling 401 from whatever the command
/// was, long after the cause.
pub fn exec_credentials(
    credentials: &Credentials,
    tools: &ToolsConfig,
) -> Result<ExecCredentials, String> {
    let strip = strip_list(credentials);
    let mut provide = Vec::new();
    if let Some(active) = resolve(credentials, tools.exec.as_ref()).active() {
        for credential in active {
            let secret = read_secret(&credential.account)?;
            provide.push((credential.provider.token_env().to_string(), secret));
        }
    }
    Ok(ExecCredentials { strip, provide })
}

#[cfg(target_os = "macos")]
fn read_secret(account: &str) -> Result<String, String> {
    bridge_secrets::read(account)
        .map_err(|e| format!("credential could not be read: {:#}", anyhow::Error::new(e)))
}

#[cfg(not(target_os = "macos"))]
fn read_secret(_account: &str) -> Result<String, String> {
    Err("credentials are read from the macOS Keychain; this build cannot read one".to_string())
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
pub fn conversation_state(
    credentials: &Credentials,
    tools: &ToolsConfig,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    out.insert(
        "GitHub pull request tools".to_string(),
        describe(&resolve(credentials, tools.github.as_ref())),
    );
    out
}

fn describe(state: &GroupState) -> String {
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

    /// The sentence this enforces: configuring any credential for a provider
    /// is what removes that provider's ambient environment from Exec. Here
    /// the only credential is bound to the github group, not to exec, and
    /// exec's inherited gh environment goes anyway. Otherwise the privileged
    /// tools would be one `Exec` call away from being bypassed.
    ///
    /// macOS only, like the provider itself.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_providers_ambient_environment_is_stripped_even_when_only_another_group_binds_it() {
        let credentials = creds(json!({
            "github-privileged": { "provider": "github", "account": "gh-holder" }
        }));
        let strip = strip_list(&credentials);
        assert!(strip.contains(&"GH_TOKEN".to_string()), "{strip:?}");
        assert!(strip.contains(&"GITHUB_TOKEN".to_string()), "{strip:?}");
        assert!(strip.contains(&"SSH_AUTH_SOCK".to_string()), "{strip:?}");
    }

    #[test]
    fn nothing_is_stripped_until_a_credential_is_configured() {
        assert!(strip_list(&Credentials::default()).is_empty());
    }

    #[test]
    fn a_conversation_is_told_a_group_it_cannot_use() {
        let state = conversation_state(&Credentials::default(), &ToolsConfig::default());
        let reminder = reminder(&state).expect("a conversation is always told the state");
        assert!(reminder.contains("GitHub pull request tools"), "{reminder}");
        assert!(reminder.contains("not configured"), "{reminder}");
    }

    #[test]
    fn a_delta_names_only_what_changed() {
        let before = conversation_state(&Credentials::default(), &ToolsConfig::default());
        assert!(delta(&before, &before).is_none());

        let credentials = two_credentials();
        let config = tools(json!({ "github": { "credentials": "github-privileged" } }));
        let after = conversation_state(&credentials, &config);
        let delta = delta(&before, &after).expect("the change is announced");
        assert!(
            delta.contains("GitHub pull request tools: available"),
            "{delta}"
        );
    }
}
