//! The one-shot listener the browser redirects back to.
//!
//! Port zero, so the operating system picks a free one: a previous attempt
//! still holding a port cannot collide, and the authorisation server does
//! not validate the redirect's port, so any is acceptable to it.
//!
//! It keeps accepting until a request actually carries the answer. A browser
//! will ask for `/favicon.ico`, and something on the machine may probe the
//! port; neither is the redirect, and treating the first connection as the
//! answer would abandon the login on a favicon.

use std::time::Duration;

use anyhow::Context;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub const PATH: &str = "/callback";

/// What came back. The authorisation server answers with a code or with an
/// error, and both arrive the same way.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// A bound listener and the port to put in the redirect URI.
pub async fn listen() -> anyhow::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("no local port could be bound for the login callback")?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

/// Wait for the redirect. Gives up rather than hanging: an operator who
/// closed the tab should get their shell back.
pub async fn wait(listener: &TcpListener, timeout: Duration) -> anyhow::Result<Callback> {
    tokio::time::timeout(timeout, accept_until_answered(listener))
        .await
        .map_err(|_| anyhow::anyhow!("no response from the browser within {timeout:?}"))?
}

async fn accept_until_answered(listener: &TcpListener) -> anyhow::Result<Callback> {
    loop {
        let (mut stream, _) = listener.accept().await.context("accepting the callback")?;
        let Some(target) = request_target(&mut stream).await else {
            continue;
        };
        let Some(callback) = callback_of(&target) else {
            answer(&mut stream, "404 Not Found", "Not the login callback.").await;
            continue;
        };
        let message = match &callback.error {
            Some(error) => format!("Login refused ({error}). You can close this tab."),
            None => "Login complete. You can close this tab.".to_string(),
        };
        answer(&mut stream, "200 OK", &message).await;
        return Ok(callback);
    }
}

/// The request target from the first line of a request, or nothing if what
/// arrived was not one.
fn target_of(request_line: &str) -> Option<&str> {
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    (method == "GET").then_some(target)
}

/// The redirect's parameters, or nothing if this request is not the
/// redirect. A `/callback` bearing neither a code nor an error is not an
/// answer either, so it is treated as something else knocking.
fn callback_of(target: &str) -> Option<Callback> {
    let url = reqwest::Url::parse(&format!("http://localhost{target}")).ok()?;
    if url.path() != PATH {
        return None;
    }
    let value = |wanted: &str| {
        url.query_pairs()
            .find(|(key, _)| key == wanted)
            .map(|(_, value)| value.into_owned())
    };
    let callback = Callback {
        code: value("code"),
        state: value("state"),
        error: value("error"),
    };
    (callback.code.is_some() || callback.error.is_some()).then_some(callback)
}

async fn request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = vec![0u8; 8192];
    let mut filled = 0;
    while filled < buffer.len() {
        let read = stream.read(&mut buffer[filled..]).await.ok()?;
        if read == 0 {
            return None;
        }
        filled += read;
        if let Some(end) = buffer[..filled].windows(2).position(|pair| pair == b"\r\n") {
            let line = String::from_utf8_lossy(&buffer[..end]).into_owned();
            return target_of(&line).map(str::to_string);
        }
    }
    None
}

/// Best effort: the operator's browser showing a blank tab does not change
/// whether the code arrived, so a failure to write the page is not a failure
/// to log in.
async fn answer(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!("<!doctype html><meta charset=\"utf-8\"><title>bridge-login</title><p>{message}</p>");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    mod request_line {
        use super::*;

        #[test]
        fn reads_the_target_out_of_a_get() {
            let expected = Some("/callback?code=abc");

            let actual = target_of("GET /callback?code=abc HTTP/1.1");

            assert_eq!(actual, expected);
        }

        #[test]
        fn ignores_a_method_the_redirect_never_uses() {
            let actual = target_of("POST /callback HTTP/1.1");

            assert_eq!(actual, None);
        }
    }

    mod parameters {
        use super::*;

        #[test]
        fn reads_the_code_and_state_from_the_redirect() {
            let expected = Callback {
                code: Some("the-code".to_string()),
                state: Some("the-state".to_string()),
                error: None,
            };

            let actual = callback_of("/callback?code=the-code&state=the-state");

            assert_eq!(actual, Some(expected));
        }

        #[test]
        fn reads_a_refusal_as_an_answer() {
            let expected = Some("access_denied".to_string());

            let actual = callback_of("/callback?error=access_denied").unwrap();

            assert_eq!(actual.error, expected);
        }

        /// The browser asks for this on its own, and answering it as though
        /// the login had come back would abandon the flow.
        #[test]
        fn does_not_mistake_a_favicon_request_for_the_redirect() {
            let actual = callback_of("/favicon.ico");

            assert_eq!(actual, None);
        }

        /// Something probing the port hits the right path with nothing in
        /// it, which is not an answer either.
        #[test]
        fn does_not_mistake_a_bare_callback_path_for_the_redirect() {
            let actual = callback_of("/callback");

            assert_eq!(actual, None);
        }
    }
}
