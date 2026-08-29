//! Obtaining a credential for bridge to use.
//!
//! Two ways in, tried in the order they are listed. Interactive opens a
//! browser and catches the redirect on a local port; code prints the URL and
//! takes the result back by hand. The default is both, which is the same
//! thing said twice: use a browser, and if there is no browser to use, ask.
//!
//! A flag narrows the list rather than switching a mode, so `--interactive`
//! means interactive and nothing else, and fails outright when no browser
//! opens instead of quietly asking for a paste that was not wanted.

mod browser;
mod callback;

use std::io::Write;
use std::time::Duration;

use anyhow::Context;
use bridge_auth::{Credentials, Minted, oauth};

/// Long enough for a human to read a consent screen, short enough that a
/// closed tab gives the shell back rather than hanging.
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);

const USAGE: &str = "usage: bridge-login [--interactive | --code]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Strategy {
    Interactive,
    Code,
}

/// Which ways in to try, in order.
fn strategies(args: &[String]) -> anyhow::Result<Vec<Strategy>> {
    match args {
        [] => Ok(vec![Strategy::Interactive, Strategy::Code]),
        [flag] if flag == "--interactive" => Ok(vec![Strategy::Interactive]),
        [flag] if flag == "--code" => Ok(vec![Strategy::Code]),
        _ => anyhow::bail!("{USAGE}"),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let strategies = strategies(&args)?;
    let http = reqwest::Client::new();
    let store = bridge_auth::default_store()?;

    let minted = login(&strategies, &http).await?;
    Credentials::new(store.clone()).save(&minted)?;

    println!("bridge-login: credential stored in {}", store.describe());
    Ok(())
}

async fn login(strategies: &[Strategy], http: &reqwest::Client) -> anyhow::Result<Minted> {
    for (position, strategy) in strategies.iter().enumerate() {
        let last = position + 1 == strategies.len();
        match strategy {
            Strategy::Code => return by_code(http).await,
            Strategy::Interactive => match interactively(http).await? {
                Some(minted) => return Ok(minted),
                None if last => {
                    anyhow::bail!("no browser could be opened; run again with --code")
                }
                None => eprintln!(
                    "bridge-login: no browser could be opened, asking for the code instead"
                ),
            },
        }
    }
    anyhow::bail!("{USAGE}")
}

/// `Ok(None)` means only that no browser opened, which is the one condition
/// that moves on to the next strategy. Anything that goes wrong after the
/// browser opens is a failure of this login, not a reason to start another.
async fn interactively(http: &reqwest::Client) -> anyhow::Result<Option<Minted>> {
    let (listener, port) = callback::listen().await?;
    let redirect = format!("http://localhost:{port}{}", callback::PATH);
    let pkce = oauth::pkce();
    let state = oauth::nonce();
    let url = oauth::authorize_url(&pkce.challenge, &state, &redirect)?;

    if !browser::open(&url) {
        return Ok(None);
    }
    println!("bridge-login: opened your browser. If nothing appeared, visit:\n\n  {url}\n");

    let answer = callback::wait(&listener, CALLBACK_TIMEOUT).await?;
    if let Some(error) = answer.error {
        anyhow::bail!("the authorisation was refused: {error}");
    }
    anyhow::ensure!(
        answer.state.as_deref() == Some(state.as_str()),
        "the callback did not carry this login's state, so it did not come from it"
    );
    let code = answer.code.context("the callback carried no code")?;

    oauth::exchange_code(http, &code, &state, &pkce.verifier, &redirect)
        .await
        .map(Some)
}

async fn by_code(http: &reqwest::Client) -> anyhow::Result<Minted> {
    let pkce = oauth::pkce();
    let state = oauth::nonce();
    let url = oauth::authorize_url(&pkce.challenge, &state, oauth::MANUAL_REDIRECT_URL)?;

    println!(
        "bridge-login: visit this URL, authorise, then paste the code back here.\n\n  {url}\n"
    );
    print!("code: ");
    std::io::stdout().flush()?;

    let mut pasted = String::new();
    std::io::stdin()
        .read_line(&mut pasted)
        .context("reading the pasted code")?;
    let (code, pasted_state) = oauth::split_pasted_code(&pasted);
    anyhow::ensure!(!code.is_empty(), "no code was pasted");
    if let Some(pasted_state) = pasted_state {
        anyhow::ensure!(
            pasted_state == state,
            "the pasted value did not carry this login's state, so it did not come from it"
        );
    }

    oauth::exchange_code(
        http,
        &code,
        &state,
        &pkce.verifier,
        oauth::MANUAL_REDIRECT_URL,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(given: &[&str]) -> Vec<String> {
        given.iter().map(|arg| arg.to_string()).collect()
    }

    mod choosing_strategies {
        use super::*;

        /// The default says both: open a browser, and if there is none, ask.
        #[test]
        fn tries_the_browser_first_and_the_code_after_it_by_default() {
            let expected = vec![Strategy::Interactive, Strategy::Code];

            let actual = strategies(&args(&[])).unwrap();

            assert_eq!(actual, expected);
        }

        /// Asking for one narrows the list to it, so there is nothing left
        /// to fall through to.
        #[test]
        fn narrows_to_the_browser_alone_when_asked_for_it() {
            let expected = vec![Strategy::Interactive];

            let actual = strategies(&args(&["--interactive"])).unwrap();

            assert_eq!(actual, expected);
        }

        #[test]
        fn narrows_to_the_code_alone_when_asked_for_it() {
            let expected = vec![Strategy::Code];

            let actual = strategies(&args(&["--code"])).unwrap();

            assert_eq!(actual, expected);
        }

        #[test]
        fn rejects_a_flag_it_does_not_know() {
            let actual = strategies(&args(&["--browser"]));

            assert!(actual.is_err());
        }
    }
}
