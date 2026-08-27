//! Handing a URL to whatever the desktop uses to open one.
//!
//! Whether this works is the entire question the interactive strategy turns
//! on, so it answers plainly: opened, or not. A headless machine, a session
//! with no desktop, or a platform with no opener all come back the same way,
//! and the caller moves to the strategy that needs no browser.

/// The platform's opener, and the arguments before the URL. Windows' `start`
/// is a shell builtin rather than a program, and its first quoted argument
/// is the window title, so the empty string is a placeholder that stops the
/// URL being swallowed as one.
fn opener(url: &str) -> Option<(&'static str, Vec<String>)> {
    match std::env::consts::OS {
        "macos" => Some(("open", vec![url.to_string()])),
        "windows" => Some((
            "cmd",
            vec!["/C".to_string(), "start".to_string(), String::new(), url.to_string()],
        )),
        "linux" => Some(("xdg-open", vec![url.to_string()])),
        _ => None,
    }
}

/// Try to open the URL, reporting whether it went anywhere. A non-zero exit
/// counts as not opened: `xdg-open` returns one when no handler is
/// configured, which is exactly the headless case this has to catch.
pub fn open(url: &str) -> bool {
    let Some((program, args)) = opener(url) else {
        return false;
    };
    std::process::Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The URL has to be the last argument on every platform, or the opener
    /// receives the placeholder title as the thing to open.
    #[test]
    fn passes_the_url_as_the_final_argument() {
        let expected = Some("https://example.test/auth".to_string());

        let actual =
            opener("https://example.test/auth").and_then(|(_, args)| args.last().cloned());

        assert_eq!(actual, expected);
    }
}
