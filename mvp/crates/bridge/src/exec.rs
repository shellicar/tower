//! The Bash tool's process discipline (the simple tool; a structured
//! ExecV3-style tool is future work). Non-interactive by construction:
//! stdin is null (a command that prompts gets EOF and fails fast, never
//! hangs), stdout/stderr piped, no PTY anywhere. The child leads its own
//! process group so cancellation kills the whole tree, not just the shell.
//!
//! No timeout, deliberately: the human is the timeout. A running command is
//! visible in tower and cancellable; the cancel signal is what kills it.

use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

/// Combined output cap. Nothing near this belongs in a model request; the
/// stored side is towerd's ref externalisation, but the model-facing result
/// carries its own limit.
const MAX_OUTPUT_BYTES: usize = 100 * 1024;

pub fn bash_schema() -> Value {
    json!({
        "name": "Bash",
        "description": "Run a bash command (bash -c) in the working directory. \
            Non-interactive: stdin is closed, so commands that prompt will fail \
            rather than hang. Output is capped at 100 KB. Every command requires \
            human approval before it runs.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The command to run."
                }
            },
            "required": ["command"],
            "additionalProperties": false
        }
    })
}

/// Kill the child's whole process group: SIGTERM, a 500ms grace, SIGKILL.
/// A program that ignores TERM is reaped by the KILL and reports it; honest.
/// Unix-only; the Windows seam is a Job Object with KILL_ON_JOB_CLOSE, which
/// also closes the orphan gap POSIX leaves open (a hard-killed bridge cannot
/// run this function; its command trees outlive it, visibly stranded).
#[cfg(unix)]
async fn group_kill(pgid: i32) {
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
}

/// Run the command to completion or cancellation. Returns (content,
/// is_error), the tool_result's halves. The slot is always filled: a
/// cancelled command reports what it produced and how it died, because a
/// committed tool_use without a result is an invalid conversation.
pub async fn run_bash(command: &str, cancel: &mut watch::Receiver<bool>) -> (String, bool) {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-c")
        .arg(command)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return (format!("failed to spawn bash: {e}"), true),
    };
    let pgid = child.id().map(|id| id as i32);

    // Readers drain the pipes concurrently (a full pipe would deadlock the
    // child) and keep at most the cap each; combined enforcement below.
    let mut stdout_pipe = child.stdout.take().expect("stdout was piped");
    let mut stderr_pipe = child.stderr.take().expect("stderr was piped");
    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = (&mut stdout_pipe)
            .take((MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .await;
        // Drain the remainder so the child never blocks on a full pipe.
        let _ = tokio::io::copy(&mut stdout_pipe, &mut tokio::io::sink()).await;
        buf
    });
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = (&mut stderr_pipe)
            .take((MAX_OUTPUT_BYTES + 1) as u64)
            .read_to_end(&mut buf)
            .await;
        let _ = tokio::io::copy(&mut stderr_pipe, &mut tokio::io::sink()).await;
        buf
    });

    // The command races the cancel signal: the human is the timeout.
    let (status, cancelled) = tokio::select! {
        status = child.wait() => (status, false),
        _ = crate::agent::cancelled(cancel) => {
            if let Some(pgid) = pgid {
                #[cfg(unix)]
                group_kill(pgid).await;
            }
            (child.wait().await, true)
        }
    };

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
        if take < bytes.len() {
            truncated = true;
        }
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
        Ok(st) if cancelled => (format!("cancelled by user ({st})"), true),
        Ok(st) if st.success() => (st.to_string(), false),
        Ok(st) => (st.to_string(), true),
        Err(e) => (format!("wait failed: {e}"), true),
    };
    content.push_str(&verdict);
    (content, is_error)
}

#[cfg(test)]
mod tests {
    use super::run_bash;
    use tokio::sync::watch;

    // A cancel receiver that never fires: the human is not cancelling.
    fn no_cancel() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    #[tokio::test]
    async fn echo_succeeds_and_carries_stdout() {
        let mut cancel = no_cancel();
        let (content, is_error) = run_bash("echo hello", &mut cancel).await;
        assert!(!is_error);
        assert!(content.contains("hello"), "stdout absent: {content:?}");
    }

    #[tokio::test]
    async fn a_nonzero_exit_is_an_error() {
        let mut cancel = no_cancel();
        let (content, is_error) = run_bash("exit 3", &mut cancel).await;
        assert!(is_error);
        // The verdict carries the exit status.
        assert!(content.contains('3'), "status absent: {content:?}");
    }

    #[tokio::test]
    async fn stderr_is_captured_and_labelled() {
        let mut cancel = no_cancel();
        // The command still exits 0; only its stderr carried anything.
        let (content, is_error) = run_bash("echo oops 1>&2", &mut cancel).await;
        assert!(!is_error);
        assert!(
            content.contains("stderr:"),
            "stderr not labelled: {content:?}"
        );
        assert!(content.contains("oops"));
    }

    #[tokio::test]
    async fn output_over_the_cap_is_truncated() {
        let mut cancel = no_cancel();
        // Well over MAX_OUTPUT_BYTES (100 KB) of stdout.
        let (content, is_error) = run_bash("yes x | head -c 200000", &mut cancel).await;
        assert!(!is_error);
        assert!(
            content.contains("[output truncated at 100 KB]"),
            "no truncation notice present"
        );
    }

    #[tokio::test]
    async fn a_preset_cancel_kills_the_command_and_still_fills_the_slot() {
        // Cancel already high: the command never finishes, and the result
        // slot is still filled - a bare tool_use would be an invalid record.
        let (_tx, mut cancel) = watch::channel(true);
        let (content, is_error) = run_bash("sleep 30", &mut cancel).await;
        assert!(is_error);
        assert!(
            content.contains("cancelled by user"),
            "not reported cancelled: {content:?}"
        );
    }
}
