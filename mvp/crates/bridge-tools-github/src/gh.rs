//! Spawning gh with the privileged credential.
//!
//! The credential is read from the Keychain here, at spawn time, and goes
//! into this one child's environment. It is never held in a cell, never
//! logged, and never reaches any other process: a rotation takes effect on
//! the next call because there is nothing to have gone stale.
//!
//! The ambient GitHub environment is removed before the token is provided,
//! so a variable inherited from bridge's own environment can never be what
//! gh authenticates with.

use std::path::Path;

use tokio::io::AsyncReadExt;

/// Combined output cap, matching bridge's own tool output limit. gh prints a
/// URL and a line or two; anything near this is a runaway.
const MAX_OUTPUT_BYTES: usize = 100 * 1024;

pub(crate) async fn run(
    subcommand: &str,
    args: &[String],
    cwd: &Path,
    account: &str,
) -> (String, bool) {
    let token = match bridge_secrets::read(account) {
        Ok(token) => token,
        Err(e) => {
            return (
                format!(
                    "credential {account:?} could not be read: {:#}",
                    anyhow::Error::new(e)
                ),
                true,
            );
        }
    };

    let mut cmd = tokio::process::Command::new("gh");
    cmd.arg("pr").arg(subcommand).args(args);
    cmd.current_dir(cwd);
    for name in crate::AMBIENT_ENV {
        cmd.env_remove(*name);
    }
    cmd.env(crate::TOKEN_ENV, token);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // The caller cancels by dropping this future; the child dies with it
        // rather than outliving the turn that asked for it.
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return (format!("failed to spawn gh: {e}"), true),
    };
    // Drained concurrently: a full pipe would deadlock the child.
    let stdout_task = spawn_drain(child.stdout.take().expect("stdout was piped"));
    let stderr_task = spawn_drain(child.stderr.take().expect("stderr was piped"));
    let status = child.wait().await;
    let stdout = stdout_task.await.unwrap_or_default();
    let stderr = stderr_task.await.unwrap_or_default();

    let mut content = String::new();
    let mut budget = MAX_OUTPUT_BYTES;
    let mut truncated = false;
    for (label, bytes) in [("", stdout.as_slice()), ("stderr:\n", stderr.as_slice())] {
        if bytes.is_empty() {
            continue;
        }
        let take = bytes.len().min(budget);
        truncated |= take < bytes.len();
        content.push_str(label);
        content.push_str(&String::from_utf8_lossy(&bytes[..take]));
        if !content.ends_with('\n') {
            content.push('\n');
        }
        budget -= take;
    }
    if truncated {
        content.push_str("[output truncated at 100 KB]\n");
    }
    let (verdict, is_error) = match &status {
        Ok(st) if st.success() => (st.to_string(), false),
        Ok(st) => (st.to_string(), true),
        Err(e) => (format!("wait failed: {e}"), true),
    };
    content.push_str(&verdict);
    (content, is_error)
}

fn spawn_drain(
    mut pipe: impl tokio::io::AsyncRead + Unpin + Send + 'static,
) -> tokio::task::JoinHandle<Vec<u8>> {
    tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = (&mut pipe)
            .take((MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .await;
        let _ = tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await;
        buf
    })
}
