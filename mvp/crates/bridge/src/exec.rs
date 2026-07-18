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
        "description": "Run a bash command (bash -c) in the working directory. Prefer \
            `Exec` — structured, reviewable, and it already covers chaining (`;`/`&&`/`||`/ \
            `|`) and redirects. Reach for Bash only when you need actual shell features \
            Exec doesn't have: globbing, variable expansion, subshells, here-docs. \
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

pub fn exec_schema() -> Value {
    json!({
        "name": "Exec",
        "description": "Run a sequence of programs directly (no shell): each command joins \
            the NEXT via its `op`. Absent op = sequential (run next regardless, like `;`); \
            \"&&\" = run next only if this succeeds; \"||\" = run next only if this fails; \
            \"|\" = pipe this stdout into the next stdin. Precedence is bash's: \"|\" binds \
            tightest, then \"&&\"/\"||\" (equal, left to right). Omit op on the last command. \
            Structured — no shell string to parse or quote. Non-interactive: stdin is closed \
            on the first command of each pipeline, so a command that prompts fails rather \
            than hangs. Combined output is capped at 100 KB. The whole call requires one \
            human approval before any of it runs.",
        "input_schema": {
            "type": "object",
            "properties": {
                "commands": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "program": {
                                "type": "string",
                                "description": "The program to run (resolved on PATH, or an absolute path)."
                            },
                            "args": {
                                "type": "array",
                                "items": { "type": "string" },
                                "description": "Arguments to the program, unshelled — no quoting or globbing."
                            },
                            "cwd": {
                                "type": "string",
                                "description": "Working directory for this command. Defaults to the bridge's own cwd."
                            },
                            "env": {
                                "type": "object",
                                "additionalProperties": { "type": "string" },
                                "description": "Environment variables merged over the inherited environment."
                            },
                            "op": {
                                "type": "string",
                                "enum": ["&&", "||", "|"],
                                "description": "How THIS command joins the NEXT one. Absent = sequential."
                            },
                            "redirect": {
                                "type": "object",
                                "properties": {
                                    "stdout": {
                                        "type": "string",
                                        "description": "Redirect this command's stdout to this file path (overwrite)."
                                    },
                                    "stderr": {
                                        "type": "string",
                                        "description": "Redirect stderr to a file path, or the literal \"&1\" to merge it into wherever stdout goes."
                                    }
                                },
                                "additionalProperties": false
                            }
                        },
                        "required": ["program"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["commands"],
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
    cmd.arg("-c").arg(command);
    run_child(cmd, cancel).await
}

/// One command in an `Exec` call, as parsed from the tool's `commands` input.
#[derive(Debug, Clone)]
pub struct ExecCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: std::collections::HashMap<String, String>,
    pub op: Option<ExecOp>,
    pub redirect: Option<ExecRedirect>,
}

/// Absent op (`None` on the command) means sequential — there is no `Seq`
/// variant because "run next regardless" needs no state of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecOp {
    And,
    Or,
    Pipe,
}

impl ExecOp {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "&&" => Some(Self::And),
            "||" => Some(Self::Or),
            "|" => Some(Self::Pipe),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExecRedirect {
    pub stdout: Option<String>,
    /// A file path, or the literal "&1" meaning "wherever stdout goes".
    pub stderr: Option<String>,
}

/// Parse one command from its JSON block. `op`/`redirect` absent is fine —
/// tolerant of a missing optional field, never of a malformed required one.
fn parse_command(v: &Value) -> Result<ExecCommand, String> {
    let program = v["program"]
        .as_str()
        .ok_or("command missing \"program\"")?
        .to_owned();
    let args = v["args"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let cwd = v["cwd"].as_str().map(str::to_owned);
    let env = v["env"]
        .as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        })
        .unwrap_or_default();
    let op = match v["op"].as_str() {
        Some(s) => Some(ExecOp::parse(s).ok_or_else(|| format!("unknown op {s:?}"))?),
        None => None,
    };
    let redirect = v.get("redirect").map(|r| ExecRedirect {
        stdout: r["stdout"].as_str().map(str::to_owned),
        stderr: r["stderr"].as_str().map(str::to_owned),
    });
    Ok(ExecCommand {
        program,
        args,
        cwd,
        env,
        op,
        redirect,
    })
}

/// Parse the `Exec` tool's whole `commands` array. Request-level: a malformed
/// array fails the call before anything runs, per composition-model.md's
/// request-level-vs-item-level split — there is no per-item result to hang a
/// parse failure on until commands actually start.
pub fn parse_commands(input: &Value) -> Result<Vec<ExecCommand>, String> {
    input["commands"]
        .as_array()
        .ok_or("missing \"commands\"")?
        .iter()
        .map(parse_command)
        .collect()
}

/// One command's outcome within a run — the item-level result `Exec`'s array
/// is built from. `skipped` covers both `&&`/`||` short-circuiting AND a
/// sibling command's spawn failure aborting the rest of its pipeline group.
#[derive(Clone)]
pub(crate) struct CommandOutcome {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    /// None when the process never ran (skipped, or failed to spawn).
    status: Option<std::process::ExitStatus>,
    spawn_error: Option<String>,
    skipped: bool,
}

impl CommandOutcome {
    fn skipped() -> Self {
        Self {
            stdout: Vec::new(),
            stderr: Vec::new(),
            status: None,
            spawn_error: None,
            skipped: true,
        }
    }

    fn succeeded(&self) -> bool {
        self.status
            .as_ref()
            .is_some_and(std::process::ExitStatus::success)
    }
}

/// Run the whole forward-op chain: group into pipelines at `|` boundaries,
/// gate each pipeline's start on the previous one's exit per `&&`/`||`/absent,
/// short-circuiting the rest on cancellation. Returns one outcome per input
/// command, same length and order — the caller formats the tool_result from
/// this, never drops one.
pub async fn run_commands(
    commands: &[ExecCommand],
    cancel: &mut watch::Receiver<bool>,
) -> Vec<CommandOutcome> {
    let mut results: Vec<CommandOutcome> = Vec::with_capacity(commands.len());
    let mut i = 0;
    // Whether the previous pipeline's terminal command succeeded — gates the
    // next pipeline's start via the op that preceded it.
    let mut prev_ok = true;
    let mut skip_rest = false;
    while i < commands.len() {
        // A pipeline group is the run of commands joined by Pipe, ending at
        // the first command whose op is not Pipe (or end of list).
        let start = i;
        while commands[i].op == Some(ExecOp::Pipe) && i + 1 < commands.len() {
            i += 1;
        }
        let group = &commands[start..=i];
        // The op that PRECEDES this group is carried on the command just
        // before `start` (index start-1's op), since op is forward-pointing.
        let gate = if start == 0 {
            None
        } else {
            commands[start - 1].op
        };
        let run_this = !skip_rest
            && match gate {
                None | Some(ExecOp::Pipe) => true,
                Some(ExecOp::And) => prev_ok,
                Some(ExecOp::Or) => !prev_ok,
            };
        if run_this {
            let group_results = run_pipeline(group, cancel).await;
            prev_ok = group_results.last().is_some_and(CommandOutcome::succeeded);
            if *cancel.borrow() {
                skip_rest = true;
            }
            results.extend(group_results);
        } else {
            for _ in group {
                results.push(CommandOutcome::skipped());
            }
        }
        i += 1;
    }
    results
}

/// Run one pipeline group (commands joined by `|`) to completion or
/// cancellation. Non-terminal commands' stdout feeds the next command's
/// stdin directly (OS pipe, no buffering through this process); their own
/// stderr is still captured per-command. `redirect.stdout` on a non-terminal
/// command is ignored — its stdout is already spoken for by the pipe.
async fn run_pipeline(
    group: &[ExecCommand],
    cancel: &mut watch::Receiver<bool>,
) -> Vec<CommandOutcome> {
    let n = group.len();
    let mut children: Vec<tokio::process::Child> = Vec::with_capacity(n);
    let mut stdout_files: Vec<Option<std::fs::File>> = Vec::with_capacity(n);
    let mut stderr_files: Vec<Option<std::fs::File>> = Vec::with_capacity(n);
    let mut merge_flags: Vec<bool> = Vec::with_capacity(n);
    let mut next_stdin: Option<std::process::Stdio> = None;
    let mut spawned = 0;

    for (idx, c) in group.iter().enumerate() {
        let is_last = idx + 1 == n;
        let mut cmd = tokio::process::Command::new(&c.program);
        cmd.args(&c.args);
        if let Some(cwd) = &c.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &c.env {
            cmd.env(k, v);
        }
        cmd.stdin(next_stdin.take().unwrap_or_else(std::process::Stdio::null));
        // A file redirect on the terminal command bypasses capture; a
        // non-terminal command's stdout always feeds the pipe.
        let redirect_path = if is_last {
            c.redirect.as_ref().and_then(|r| r.stdout.as_deref())
        } else {
            None
        };
        let stdout_file = match redirect_path {
            Some(path) => match std::fs::File::create(path) {
                Ok(f) => Some(f),
                Err(e) => {
                    // Treat as a spawn failure for this command: nothing ran.
                    children_kill(&mut children).await;
                    let mut out = vec![CommandOutcome::skipped(); spawned];
                    out.push(CommandOutcome {
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                        status: None,
                        spawn_error: Some(format!("failed to open redirect {path}: {e}")),
                        skipped: false,
                    });
                    out.extend((idx + 1..n).map(|_| CommandOutcome::skipped()));
                    return out;
                }
            },
            None => None,
        };
        match &stdout_file {
            Some(f) => {
                cmd.stdout(f.try_clone().expect("clone redirect file handle"));
            }
            None => {
                cmd.stdout(std::process::Stdio::piped());
            }
        }
        // stderr: a real path opens its own file; "&1" rides whatever stdout
        // used (the same file if stdout redirected, else it stays piped and
        // is merged into the stdout section at format time — the two OS
        // pipes stay separate, so byte-for-byte interleaving isn't preserved,
        // only that both streams' content is present).
        let stderr_dest = c.redirect.as_ref().and_then(|r| r.stderr.as_deref());
        let stderr_file = match stderr_dest {
            Some("&1") => stdout_file
                .as_ref()
                .map(|f| f.try_clone().expect("clone redirect file handle")),
            Some(path) => match std::fs::File::create(path) {
                Ok(f) => Some(f),
                Err(e) => {
                    children_kill(&mut children).await;
                    let mut out = vec![CommandOutcome::skipped(); spawned];
                    out.push(CommandOutcome {
                        stdout: Vec::new(),
                        stderr: Vec::new(),
                        status: None,
                        spawn_error: Some(format!("failed to open redirect {path}: {e}")),
                        skipped: false,
                    });
                    out.extend((idx + 1..n).map(|_| CommandOutcome::skipped()));
                    return out;
                }
            },
            None => None,
        };
        let merge_stderr_into_stdout_capture = stderr_dest == Some("&1") && stdout_file.is_none();
        match &stderr_file {
            Some(f) => {
                cmd.stderr(f.try_clone().expect("clone redirect file handle"));
            }
            None => {
                cmd.stderr(std::process::Stdio::piped());
            }
        }
        cmd.kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);

        match cmd.spawn() {
            Ok(mut child) => {
                if stdout_file.is_none() && !is_last {
                    let out = child.stdout.take().expect("stdout was piped");
                    next_stdin = Some(child_stdout_to_stdio(out));
                }
                // is_last with no redirect: stdout stays piped, captured below.
                children.push(child);
                stdout_files.push(stdout_file);
                stderr_files.push(stderr_file);
                merge_flags.push(merge_stderr_into_stdout_capture);
                spawned += 1;
            }
            Err(e) => {
                children_kill(&mut children).await;
                let mut out = vec![CommandOutcome::skipped(); spawned];
                out.push(CommandOutcome {
                    stdout: Vec::new(),
                    stderr: Vec::new(),
                    status: None,
                    spawn_error: Some(format!("failed to spawn {}: {e}", c.program)),
                    skipped: false,
                });
                out.extend((idx + 1..n).map(|_| CommandOutcome::skipped()));
                return out;
            }
        }
    }

    // Drain what's still piped. A non-terminal command's stdout was already
    // taken above to feed the next command's stdin, so only the terminal
    // command ever has stdout left to drain here; a file-redirected stream
    // (either stdout or stderr) was never piped in the first place — the OS
    // writes it directly, so there is nothing to read on this side.
    type Drain = Option<tokio::task::JoinHandle<Vec<u8>>>;
    let mut stdout_tasks: Vec<Drain> = Vec::with_capacity(n);
    let mut stderr_tasks: Vec<Drain> = Vec::with_capacity(n);
    for child in children.iter_mut() {
        stdout_tasks.push(child.stdout.take().map(spawn_drain));
        stderr_tasks.push(child.stderr.take().map(spawn_drain));
    }

    let pgids: Vec<i32> = children
        .iter()
        .filter_map(|c| c.id().map(|id| id as i32))
        .collect();
    let wait_all = async {
        let mut statuses = Vec::with_capacity(children.len());
        for child in &mut children {
            statuses.push(child.wait().await);
        }
        statuses
    };
    let (statuses, cancelled) = tokio::select! {
        statuses = wait_all => (statuses, false),
        _ = crate::agent::cancelled(cancel) => {
            #[cfg(unix)]
            for pgid in &pgids {
                group_kill(*pgid).await;
            }
            let mut statuses = Vec::with_capacity(children.len());
            for child in &mut children {
                statuses.push(child.wait().await);
            }
            (statuses, true)
        }
    };

    let mut out = Vec::with_capacity(n);
    for (idx, status) in statuses.into_iter().enumerate() {
        let mut stdout = match stdout_tasks[idx].take() {
            Some(t) => t.await.unwrap_or_default(),
            None => Vec::new(),
        };
        let mut stderr = match stderr_tasks[idx].take() {
            Some(t) => t.await.unwrap_or_default(),
            None => Vec::new(),
        };
        // "&1" onto a captured (non-file) stdout: fold stderr's bytes into
        // stdout's now that both are read — two OS pipes stay separate above,
        // this is where the merge actually happens.
        if merge_flags[idx] {
            stdout.append(&mut stderr);
        }
        let status = status.ok();
        out.push(CommandOutcome {
            stdout,
            stderr,
            status,
            spawn_error: if cancelled {
                Some("cancelled by user".to_string())
            } else {
                None
            },
            skipped: false,
        });
    }
    out
}

/// Feed one child's stdout directly into the next child's stdin as an OS
/// pipe — no buffering through this process. Unix-only; the file is already
/// unix-specific throughout (process groups, signals).
#[cfg(unix)]
fn child_stdout_to_stdio(out: tokio::process::ChildStdout) -> std::process::Stdio {
    use std::os::unix::io::{FromRawFd, IntoRawFd};
    let fd = out
        .into_owned_fd()
        .expect("child stdout has no fd")
        .into_raw_fd();
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    std::process::Stdio::from(file)
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

#[cfg(unix)]
async fn children_kill(children: &mut [tokio::process::Child]) {
    for child in children.iter() {
        if let Some(id) = child.id() {
            group_kill(id as i32).await;
        }
    }
}
#[cfg(not(unix))]
async fn children_kill(_children: &mut [tokio::process::Child]) {}

/// Format `run_commands`' outcomes into the tool_result's (content, is_error)
/// halves: one labelled section per command, a combined 100 KB budget across
/// all of them (matching `run_bash`/`run_exec`'s single-command cap), a
/// skipped command noted but silent (it produced nothing to show). is_error
/// is true if any non-skipped command failed.
pub fn format_results(commands: &[ExecCommand], results: &[CommandOutcome]) -> (String, bool) {
    let mut content = String::new();
    let mut budget = MAX_OUTPUT_BYTES;
    let mut truncated = false;
    let mut any_error = false;

    for (i, (cmd, r)) in commands.iter().zip(results).enumerate() {
        let label = format!("$ {} {}", cmd.program, cmd.args.join(" "));
        content.push_str(&format!("[{}] {label}\n", i + 1));
        if r.skipped {
            content.push_str("  (skipped)\n");
            continue;
        }
        for (prefix, bytes) in [
            ("", r.stdout.as_slice()),
            ("stderr:\n", r.stderr.as_slice()),
        ] {
            if bytes.is_empty() {
                continue;
            }
            let take = bytes.len().min(budget);
            if take < bytes.len() {
                truncated = true;
            }
            content.push_str(prefix);
            content.push_str(&String::from_utf8_lossy(&bytes[..take]));
            if !content.ends_with('\n') {
                content.push('\n');
            }
            budget -= take;
        }
        let verdict = if let Some(e) = &r.spawn_error {
            any_error = true;
            e.clone()
        } else {
            match &r.status {
                Some(st) if st.success() => st.to_string(),
                Some(st) => {
                    any_error = true;
                    st.to_string()
                }
                None => {
                    any_error = true;
                    "did not complete".to_string()
                }
            }
        };
        content.push_str(&verdict);
        content.push('\n');
    }
    if truncated {
        content.push_str("[output truncated at 100 KB combined]\n");
    }
    (content.trim_end().to_string(), any_error)
}

/// The shared process discipline: non-interactive, own process group,
/// drained pipes capped at `MAX_OUTPUT_BYTES`, cooperative cancellation. The
/// caller has already set the program/args/cwd/env; this owns spawn onward.
async fn run_child(
    mut cmd: tokio::process::Command,
    cancel: &mut watch::Receiver<bool>,
) -> (String, bool) {
    cmd.stdin(std::process::Stdio::null())
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
    use super::{format_results, parse_commands, run_bash, run_commands};
    use serde_json::json;
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

    // Runs a full Exec call end to end: parse -> run -> format, the same path
    // agent.rs takes. `input` is the tool's raw `{"commands": [...]}` JSON.
    async fn run_input(
        input: serde_json::Value,
        cancel: &mut watch::Receiver<bool>,
    ) -> (String, bool) {
        let commands = parse_commands(&input).expect("valid commands");
        let results = run_commands(&commands, cancel).await;
        format_results(&commands, &results)
    }

    #[tokio::test]
    async fn exec_runs_a_program_directly_with_args() {
        let mut cancel = no_cancel();
        let input = json!({ "commands": [{ "program": "echo", "args": ["hello"] }] });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(!is_error);
        assert!(content.contains("hello"), "stdout absent: {content:?}");
    }

    #[tokio::test]
    async fn exec_honours_cwd_and_env() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [{
                "program": "sh", "args": ["-c", "pwd; echo $EXEC_TEST_VAR"],
                "cwd": "/tmp", "env": { "EXEC_TEST_VAR": "structured" }
            }]
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(!is_error);
        assert!(
            content.contains("/tmp") || content.contains("/private/tmp"),
            "cwd not honoured: {content:?}"
        );
        assert!(content.contains("structured"), "env absent: {content:?}");
    }

    #[tokio::test]
    async fn a_preset_cancel_kills_a_structured_command() {
        let (_tx, mut cancel) = watch::channel(true);
        let input = json!({ "commands": [{ "program": "sleep", "args": ["30"] }] });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(is_error);
        assert!(
            content.contains("cancelled by user"),
            "not reported cancelled: {content:?}"
        );
    }

    #[tokio::test]
    async fn sequential_absent_op_runs_both_regardless_of_the_first() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "sh", "args": ["-c", "exit 1"] },
                { "program": "echo", "args": ["second"] }
            ]
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(is_error, "the first command's failure should surface");
        assert!(
            content.contains("second"),
            "second command skipped: {content:?}"
        );
    }

    #[tokio::test]
    async fn and_skips_the_next_command_on_failure() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "sh", "args": ["-c", "exit 1"], "op": "&&" },
                { "program": "echo", "args": ["never"] }
            ]
        });
        let (content, _) = run_input(input, &mut cancel).await;
        // The label always echoes the args; what proves the skip is the
        // marker, not the absence of "never" (which the label itself carries).
        assert!(
            content.contains("(skipped)"),
            "skip not reported: {content:?}"
        );
    }

    #[tokio::test]
    async fn and_runs_the_next_command_on_success() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "true", "op": "&&" },
                { "program": "echo", "args": ["chained"] }
            ]
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(!is_error);
        assert!(content.contains("chained"));
    }

    #[tokio::test]
    async fn or_runs_the_next_command_only_on_failure() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "true", "op": "||" },
                { "program": "echo", "args": ["fallback"] }
            ]
        });
        let (content, _) = run_input(input, &mut cancel).await;
        assert!(
            content.contains("(skipped)"),
            "skip not reported: {content:?}"
        );
    }

    #[tokio::test]
    async fn pipe_feeds_stdout_into_the_next_stdin() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "printf", "args": ["a\\nb\\nc\\n"], "op": "|" },
                { "program": "wc", "args": ["-l"] }
            ]
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(!is_error);
        assert!(
            content.contains('3'),
            "pipe did not carry 3 lines through: {content:?}"
        );
    }

    #[tokio::test]
    async fn redirect_stdout_writes_to_a_file_instead_of_the_result() {
        let mut cancel = no_cancel();
        let path = std::env::temp_dir().join(format!("exec-test-{}.txt", uuid::Uuid::new_v4()));
        let input = json!({
            "commands": [{
                "program": "echo", "args": ["to-file"],
                "redirect": { "stdout": path.to_str().unwrap() }
            }]
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(!is_error);
        // Only the label (which echoes args) and the verdict line — no third
        // line carrying the actual stdout, which went to the file instead.
        assert_eq!(
            content.lines().count(),
            2,
            "expected label + verdict only, stdout leaked into the result: {content:?}"
        );
        let written = std::fs::read_to_string(&path).expect("redirect file written");
        assert!(written.contains("to-file"));
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn redirect_stderr_amp1_merges_into_stdout_destination() {
        let mut cancel = no_cancel();
        let path = std::env::temp_dir().join(format!("exec-test-{}.txt", uuid::Uuid::new_v4()));
        let input = json!({
            "commands": [{
                "program": "sh", "args": ["-c", "echo out; echo err 1>&2"],
                "redirect": { "stdout": path.to_str().unwrap(), "stderr": "&1" }
            }]
        });
        let (_, is_error) = run_input(input, &mut cancel).await;
        assert!(!is_error);
        let written = std::fs::read_to_string(&path).expect("redirect file written");
        assert!(
            written.contains("out") && written.contains("err"),
            "merge missing a stream: {written:?}"
        );
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn a_skipped_command_still_fills_its_result_slot() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "false", "op": "&&" },
                { "program": "echo", "args": ["a"] }
            ]
        });
        let commands = parse_commands(&input).expect("valid commands");
        let results = run_commands(&commands, &mut cancel).await;
        assert_eq!(results.len(), 2, "one result per input command, always");
    }
}
