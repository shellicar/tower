//! The Bash tool's process discipline (the simple tool; a structured
//! ExecV3-style tool is future work). Non-interactive by construction:
//! stdin is null (a command that prompts gets EOF and fails fast, never
//! hangs), stdout/stderr piped, no PTY anywhere. The child leads its own
//! process group so cancellation kills the whole tree, not just the shell.
//!
//! Cancellation is one bound on a running command: it is visible in tower and
//! the cancel signal kills it. `Exec` carries a second, stated by the caller,
//! because the human is not always watching: a child that never exits blocks
//! the turn, which leaves the query open and the conversation unable to be
//! spoken to until someone kills the process by hand.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};

use serde_json::{Value, json};
use std::num::NonZeroU32;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::sync::watch;

/// One `Exec` call as the model asked for it: the commands, and the time the
/// caller says the whole call may take. The ceiling that may cut the ask down
/// is not here, because it belongs to the host rather than the call.
#[derive(Debug, Clone)]
pub struct ExecCall {
    pub commands: Vec<ExecCommand>,
    pub timeout_s: NonZeroU32,
}

/// What the call may actually run for, given what this host allows. Refused
/// rather than clamped: a clamped call leaves the caller planning against a
/// number that will never happen, and it never learns the limit exists.
pub fn resolve_timeout(asked: NonZeroU32, ceiling: Option<NonZeroU32>) -> Result<Duration, String> {
    match ceiling {
        Some(ceiling) if asked > ceiling => Err(format!(
            "timeout of {asked}s exceeds this host's maximum of {ceiling}s. Ask for {ceiling}s or \
             less, or run the work in a form that finishes inside it."
        )),
        _ => Ok(Duration::from_secs(u64::from(asked.get()))),
    }
}

/// Combined output cap. Nothing near this belongs in a model request; the
/// stored side is towerd's ref externalisation, but the model-facing result
/// carries its own limit.
const MAX_OUTPUT_BYTES: usize = 100 * 1024;

/// Disabled for now (agent.rs no longer registers this schema) — Exec is
/// preferred and covers the same ground. Kept, not deleted: dynamic
/// per-conversation tool enable/disable is real future work, and re-offering
/// Bash is then a one-line change, not a rewrite.
#[allow(dead_code)]
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

/// Every word of this is a constant of the build, the ceiling included: the
/// tools array heads the cached prompt prefix, so text that varied with what a
/// host configured would cost that host its whole prefix the moment it did.
/// The description says a maximum may exist and what happens when a call
/// exceeds it, which is what the model needs to recognise the refusal; only the
/// refusal itself names the number.
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
            than hangs. Combined output is capped at 100 KB. Every call states a `timeout`, and \
            the whole call is killed and returns an error when it fires. The whole \
            call requires one human approval before any of it runs.",
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
                                "description": "Working directory for this command. Defaults to the conversation's own cwd."
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
                },
                "timeout": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Seconds this whole call may run before every command in it is \
                        killed. Required, and it is your own expectation: state the time you think \
                        the work needs, so a call that runs past it tells you the expectation was \
                        wrong. A local command (reading a file, a git status) is done in seconds; \
                        reaching the network, installing, or building can want minutes. A host may \
                        set a maximum: a call asking for longer than that host allows is refused \
                        before anything runs, and the refusal names the limit."
                }
            },
            "required": ["commands", "timeout"],
            "additionalProperties": false
        }
    })
}

/// Kill whole process groups: SIGTERM to every one, a single 500ms grace,
/// then SIGKILL to every one. A program that ignores TERM is reaped by the
/// KILL and reports it; honest.
///
/// The grace is per kill, never per group. Waiting once per group in turn
/// multiplies it by the number of things being killed, so a call would outlive
/// its own deadline by longer the more commands it chained. Every kill in this
/// module goes through here for that reason, one process group or many.
///
/// Unix-only; the Windows seam is a Job Object with KILL_ON_JOB_CLOSE, which
/// also closes the orphan gap POSIX leaves open (a hard-killed bridge cannot
/// run this function; its command trees outlive it, visibly stranded).
#[cfg(unix)]
async fn groups_kill(pgids: &[i32]) {
    for pgid in pgids {
        unsafe {
            libc::kill(-*pgid, libc::SIGTERM);
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    for pgid in pgids {
        unsafe {
            libc::kill(-*pgid, libc::SIGKILL);
        }
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

/// The call's timeout as asked for: required, and whole positive seconds. The
/// type refuses zero and anything negative on its own; absence and a malformed
/// value are refused here, before any command runs.
fn parse_timeout(input: &Value) -> Result<NonZeroU32, String> {
    let secs = input["timeout"]
        .as_u64()
        .and_then(|secs| u32::try_from(secs).ok())
        .ok_or(
            "missing or malformed \"timeout\": whole seconds this call may run before it is killed",
        )?;
    NonZeroU32::new(secs).ok_or_else(|| "\"timeout\" must be at least 1 second".to_string())
}

/// Parse the `Exec` tool's whole input: the commands, and the timeout the call
/// states. Request-level: a malformed array or a missing timeout fails the call
/// before anything runs, per composition-model.md's request-level-vs-item-level
/// split — there is no per-item result to hang a parse failure on until
/// commands actually start.
pub fn parse_call(input: &Value) -> Result<ExecCall, String> {
    let timeout_s = parse_timeout(input)?;
    let commands = input["commands"]
        .as_array()
        .ok_or("missing \"commands\"")?
        .iter()
        .map(parse_command)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ExecCall {
        commands,
        timeout_s,
    })
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
    /// Set to the call's timeout when this command was killed for exceeding
    /// it. Carries the value so the result can name the number the caller
    /// itself chose.
    timed_out: Option<Duration>,
}

impl CommandOutcome {
    fn skipped() -> Self {
        Self {
            stdout: Vec::new(),
            stderr: Vec::new(),
            status: None,
            spawn_error: None,
            skipped: true,
            timed_out: None,
        }
    }

    fn succeeded(&self) -> bool {
        self.status
            .as_ref()
            .is_some_and(std::process::ExitStatus::success)
    }
}

/// The environment this bridge process carries, which is the base every Exec
/// child starts from. The one place it is read: everything below takes the
/// environment as a value, so what a child would get can be decided without
/// spawning one.
pub fn ambient_env() -> BTreeMap<OsString, OsString> {
    std::env::vars_os().collect()
}

/// The environment an Exec child should have: the base, the call's own
/// variables over it, then the resolved credentials' removals, then their
/// forced values.
///
/// The order is the guarantee. The removals run after the call's own
/// variables, so a call naming a stripped variable itself cannot decide what
/// the child authenticates as, and the forced values run last so nothing the
/// call asked for displaces them.
///
/// `case_insensitive_names` is how the platform reads a variable name, passed
/// in rather than read here so both answers are testable on any host. Windows
/// matches names without regard to case, so stripping GH_TOKEN has to take a
/// host's `Gh_Token` with it; every other platform holds the two apart as
/// different variables.
pub fn child_env(
    base: &BTreeMap<OsString, OsString>,
    call_env: &std::collections::HashMap<String, String>,
    credentials: &crate::credentials::ExecCredentials,
    case_insensitive_names: bool,
) -> BTreeMap<OsString, OsString> {
    let mut env = base.clone();
    for (name, value) in call_env {
        set(&mut env, name, value, case_insensitive_names);
    }
    for name in &credentials.strip {
        unset(&mut env, name, case_insensitive_names);
    }
    for (name, value) in &credentials.provide {
        set(&mut env, name, value, case_insensitive_names);
    }
    env
}

/// Case-preserving, like the platform itself: a name already in the
/// environment keeps the spelling it arrived with and takes the new value, so
/// the later layer wins whichever way either layer spelled it.
fn set(env: &mut BTreeMap<OsString, OsString>, name: &str, value: &str, case_insensitive: bool) {
    let key = match case_insensitive {
        true => existing_name(env, name).unwrap_or_else(|| name.into()),
        false => name.into(),
    };
    env.insert(key, value.into());
}

fn unset(env: &mut BTreeMap<OsString, OsString>, name: &str, case_insensitive: bool) {
    match case_insensitive {
        true => env.retain(|held, _| !held.eq_ignore_ascii_case(name)),
        false => {
            env.remove(OsStr::new(name));
        }
    }
}

fn existing_name(env: &BTreeMap<OsString, OsString>, name: &str) -> Option<OsString> {
    env.keys()
        .find(|held| held.eq_ignore_ascii_case(name))
        .cloned()
}

/// Run the whole forward-op chain: group into pipelines at `|` boundaries,
/// gate each pipeline's start on the previous one's exit per `&&`/`||`/absent,
/// short-circuiting the rest on cancellation. Returns one outcome per input
/// command, same length and order — the caller formats the tool_result from
/// this, never drops one.
pub async fn run_commands(
    commands: &[ExecCommand],
    timeout: Duration,
    base: &BTreeMap<OsString, OsString>,
    credentials: &crate::credentials::ExecCredentials,
    cancel: &mut watch::Receiver<bool>,
) -> Vec<CommandOutcome> {
    // One deadline for the whole call, not one per command: the caller stated
    // what the call may take. It starts here rather than at parse time, so a
    // wait for human approval spends the human's time, not the command's.
    let deadline = tokio::time::Instant::now() + timeout;
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
            let group_results =
                run_pipeline(group, timeout, base, credentials, cancel, deadline).await;
            prev_ok = group_results.last().is_some_and(CommandOutcome::succeeded);
            if *cancel.borrow() || group_results.iter().any(|r| r.timed_out.is_some()) {
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
    timeout: Duration,
    base: &BTreeMap<OsString, OsString>,
    credentials: &crate::credentials::ExecCredentials,
    cancel: &mut watch::Receiver<bool>,
    deadline: tokio::time::Instant,
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
        cmd.env_clear();
        cmd.envs(child_env(base, &c.env, credentials, cfg!(windows)));
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
                        timed_out: None,
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
                        timed_out: None,
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
                    timed_out: None,
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
    // Cancellation and the deadline end the run the same way: kill the whole
    // process group, then reap, so the outcomes still report what each command
    // produced before it died.
    let (statuses, ending) = tokio::select! {
        statuses = wait_all => (statuses, Ending::Ran),
        _ = crate::agent::cancelled(cancel) => {
            (kill_and_reap(&mut children, &pgids).await, Ending::Cancelled)
        }
        _ = tokio::time::sleep_until(deadline) => {
            // Who was already dead when the deadline arrived, before the kill
            // makes every child look the same. `wait` after this returns the
            // status `try_wait` cached, so reaping here costs the caller
            // nothing.
            let finished: Vec<bool> = children
                .iter_mut()
                .map(|child| matches!(child.try_wait(), Ok(Some(_))))
                .collect();
            (kill_and_reap(&mut children, &pgids).await, Ending::TimedOut { finished })
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
            spawn_error: match &ending {
                Ending::Cancelled => Some("cancelled by user".to_string()),
                Ending::Ran | Ending::TimedOut { .. } => None,
            },
            skipped: false,
            // Only what the kill actually killed: a command that had already
            // exited reports the status it exited with.
            timed_out: match &ending {
                Ending::TimedOut { finished } if !finished[idx] => Some(timeout),
                _ => None,
            },
        });
    }
    out
}

/// How a pipeline stopped: on its own, or because something killed it.
/// `TimedOut` carries which children were already finished when the deadline
/// arrived, one flag per child in spawn order.
enum Ending {
    Ran,
    Cancelled,
    TimedOut { finished: Vec<bool> },
}

async fn kill_and_reap(
    children: &mut [tokio::process::Child],
    pgids: &[i32],
) -> Vec<std::io::Result<std::process::ExitStatus>> {
    #[cfg(unix)]
    groups_kill(pgids).await;
    let mut statuses = Vec::with_capacity(children.len());
    for child in children.iter_mut() {
        statuses.push(child.wait().await);
    }
    statuses
}

/// Feed one child's stdout directly into the next child's stdin as an OS
/// pipe — no buffering through this process.
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
#[cfg(windows)]
fn child_stdout_to_stdio(out: tokio::process::ChildStdout) -> std::process::Stdio {
    use std::os::windows::io::{FromRawHandle, IntoRawHandle};
    let handle = out
        .into_owned_handle()
        .expect("child stdout has no handle")
        .into_raw_handle();
    let file = unsafe { std::fs::File::from_raw_handle(handle) };
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
    let pgids: Vec<i32> = children
        .iter()
        .filter_map(|child| child.id().map(|id| id as i32))
        .collect();
    groups_kill(&pgids).await;
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
    let mut timed_out: Option<Duration> = None;

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
        let verdict = if let Some(limit) = r.timed_out {
            any_error = true;
            timed_out = Some(limit);
            format!("killed: exceeded the {}s timeout", limit.as_secs())
        } else if let Some(e) = &r.spawn_error {
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
    // The model reads this and decides the next move, so say what the limit was
    // and that repeating the call unchanged will hit it again.
    if let Some(limit) = timed_out {
        content.push_str(&format!(
            "[the call exceeded its {}s timeout and was killed. Running it again unchanged will \
             hit the same limit: change what it does, bound its work, or state a timeout that \
             matches what the command really needs.]\n",
            limit.as_secs()
        ));
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
                groups_kill(&[pgid]).await;
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
    use super::{
        Duration, NonZeroU32, ambient_env, child_env, exec_schema, format_results, parse_call,
        resolve_timeout, run_bash, run_commands,
    };
    use crate::credentials::ExecCredentials;
    use serde_json::json;
    use std::collections::{BTreeMap, HashMap};
    use std::ffi::{OsStr, OsString};
    use tokio::sync::watch;

    fn seconds(n: u32) -> NonZeroU32 {
        NonZeroU32::new(n).expect("a positive number of seconds")
    }

    // A cancel receiver that never fires: the human is not cancelling.
    fn no_cancel() -> watch::Receiver<bool> {
        watch::channel(false).1
    }

    // No credentials configured: the child inherits this process's
    // environment untouched, which is bridge's behaviour before any
    // `credentials` line arrives.
    fn no_credentials() -> ExecCredentials {
        ExecCredentials::default()
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
        mut input: serde_json::Value,
        cancel: &mut watch::Receiver<bool>,
    ) -> (String, bool) {
        // A timeout is required, so a test that isn't about the timeout gets one
        // generous enough never to fire. No ceiling: what a host allows is not
        // what these tests are about.
        if input["timeout"].is_null() {
            input["timeout"] = json!(30);
        }
        let call = parse_call(&input).expect("valid commands");
        let timeout = resolve_timeout(call.timeout_s, None).expect("no ceiling");
        let results = run_commands(
            &call.commands,
            timeout,
            &ambient_env(),
            &no_credentials(),
            cancel,
        )
        .await;
        format_results(&call.commands, &results)
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
            ],
            "timeout": 30
        });
        let call = parse_call(&input).expect("valid commands");
        let results = run_commands(
            &call.commands,
            Duration::from_secs(30),
            &ambient_env(),
            &no_credentials(),
            &mut cancel,
        )
        .await;
        assert_eq!(results.len(), 2, "one result per input command, always");
    }

    /// The guarantee the whole credential model rests on: an Exec child
    /// cannot reach GitHub with anything but what this host handed it. The
    /// provider's variables are set on the call itself here, which is the
    /// stronger case — they are removed after whatever set them, and a
    /// variable inherited from the base goes by that same removal.
    #[test]
    fn a_providers_ambient_variables_are_absent_while_its_credential_is_present() {
        let configured = crate::credentials::parse_credentials(&json!({
            "github-default": { "provider": "github", "account": "gh-reader" }
        }))
        .expect("valid credentials");
        let mut provide = crate::credentials::active_forced_env(&configured);
        provide.push(("GH_TOKEN".to_string(), "the-configured-token".to_string()));
        let credentials = ExecCredentials {
            strip: crate::credentials::active_strip_list(&configured),
            provide,
        };
        let mut call = ambient_call();
        call.insert(
            "GH_CONFIG_DIR".to_string(),
            "/the/operators/own/session".to_string(),
        );

        let actual = child_env(&host_env(), &call, &credentials, CASE_SENSITIVE);

        assert_eq!(
            value(&actual, "GH_TOKEN").as_deref(),
            Some("the-configured-token"),
            "the configured credential is what the child carries"
        );
        assert_eq!(
            value(&actual, "GITHUB_TOKEN"),
            None,
            "GITHUB_TOKEN survived"
        );
        assert_eq!(
            value(&actual, "SSH_AUTH_SOCK"),
            None,
            "an ssh agent would authenticate git around the token"
        );
        assert_ne!(
            value(&actual, "GH_CONFIG_DIR").as_deref(),
            Some("/the/operators/own/session"),
            "the call chose where gh reads its session"
        );
        assert_eq!(
            value(&actual, "PATH").as_deref(),
            Some("/usr/bin"),
            "only the provider's own variables are touched"
        );
    }

    /// The case the rule turns on: a github credential exists, so the
    /// provider is active and governs Exec, but nothing is bound to exec.
    /// The child ends up with no way to authenticate at all, which is what
    /// leaves the privileged tools as the only route on that host.
    #[test]
    fn a_provider_configured_for_the_tools_alone_still_denies_an_exec_child() {
        let credentials = crate::credentials::parse_credentials(&json!({
            "github-privileged": { "provider": "github", "account": "gh-holder" }
        }))
        .expect("valid credentials");
        let config = crate::credentials::parse_tools(&json!({
            "github": { "credentials": "github-privileged" }
        }))
        .expect("valid tools");
        let resolved = crate::credentials::exec_credentials(&credentials, &config)
            .expect("binding nothing to exec is not an error");

        let actual = child_env(&host_env(), &ambient_call(), &resolved, CASE_SENSITIVE);

        assert_eq!(value(&actual, "GH_TOKEN"), None);
        assert_eq!(value(&actual, "GITHUB_TOKEN"), None);
        assert_eq!(value(&actual, "SSH_AUTH_SOCK"), None);
        let forced = bridge_tools_github::dead_config_dir()
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            value(&actual, "GH_CONFIG_DIR"),
            Some(forced),
            "gh must find no session to fall back to"
        );
    }

    /// A host that configured nothing keeps the environment it always had.
    /// Removing a route and replacing it are one act, so a provider nobody
    /// opted into is not governed at all.
    #[test]
    fn an_unconfigured_host_leaves_an_exec_child_alone() {
        let resolved = crate::credentials::exec_credentials(
            &crate::credentials::Credentials::default(),
            &crate::credentials::ToolsConfig::default(),
        )
        .expect("an unconfigured host is not an error");

        let actual = child_env(&host_env(), &ambient_call(), &resolved, CASE_SENSITIVE);

        assert_eq!(value(&actual, "GH_TOKEN").as_deref(), Some("ambient"));
        assert_eq!(value(&actual, "GITHUB_TOKEN").as_deref(), Some("ambient"));
        assert_eq!(
            value(&actual, "SSH_AUTH_SOCK").as_deref(),
            Some("/tmp/agent.sock")
        );
        assert_eq!(
            value(&actual, "GH_CONFIG_DIR").as_deref(),
            Some("/the/hosts/own/session"),
            "an unconfigured provider must not be governed"
        );
    }

    /// Windows reads a variable name without regard to case, so a host's own
    /// spelling of a stripped name is the same variable and goes with it.
    #[test]
    fn case_insensitive_names_strip_the_hosts_own_spelling() {
        let credentials = ExecCredentials {
            strip: vec!["GH_TOKEN".to_string()],
            provide: Vec::new(),
        };
        let base = named_env(&[("Gh_Token", "the-hosts-own")]);
        let expected: Vec<(String, String)> = Vec::new();

        let actual = child_env(&base, &call_env(&[]), &credentials, CASE_INSENSITIVE);

        assert_eq!(entries_named(&actual, "GH_TOKEN"), expected);
    }

    /// Everywhere else the two spellings are two different variables, and
    /// only the one named is removed.
    #[test]
    fn case_sensitive_names_strip_the_name_as_written_alone() {
        let credentials = ExecCredentials {
            strip: vec!["GH_TOKEN".to_string()],
            provide: Vec::new(),
        };
        let base = named_env(&[("Gh_Token", "the-hosts-own")]);
        let expected = vec![("Gh_Token".to_string(), "the-hosts-own".to_string())];

        let actual = child_env(&base, &call_env(&[]), &credentials, CASE_SENSITIVE);

        assert_eq!(entries_named(&actual, "GH_TOKEN"), expected);
    }

    /// The later layer decides the value however either layer spelled the
    /// name, and the environment keeps the spelling it already had.
    #[test]
    fn case_insensitive_names_let_a_call_replace_the_hosts_own_spelling() {
        let base = named_env(&[("Path", "/the/hosts/bin")]);
        let call = call_env(&[("PATH", "/the/calls/bin")]);
        let expected = vec![("Path".to_string(), "/the/calls/bin".to_string())];

        let actual = child_env(&base, &call, &no_credentials(), CASE_INSENSITIVE);

        assert_eq!(entries_named(&actual, "PATH"), expected);
    }

    #[test]
    fn case_sensitive_names_leave_a_differently_spelled_host_variable_beside_it() {
        let base = named_env(&[("Path", "/the/hosts/bin")]);
        let call = call_env(&[("PATH", "/the/calls/bin")]);
        let expected = vec![
            ("PATH".to_string(), "/the/calls/bin".to_string()),
            ("Path".to_string(), "/the/hosts/bin".to_string()),
        ];

        let actual = child_env(&base, &call, &no_credentials(), CASE_SENSITIVE);

        assert_eq!(entries_named(&actual, "PATH"), expected);
    }

    /// How Windows reads a variable name, and how everywhere else does.
    const CASE_INSENSITIVE: bool = true;
    const CASE_SENSITIVE: bool = false;

    /// The base environment a test supplies for itself, in place of whatever
    /// the bridge process happens to be carrying. Its own GH_CONFIG_DIR is
    /// what an unconfigured host must be left with.
    fn host_env() -> BTreeMap<OsString, OsString> {
        named_env(&[
            ("PATH", "/usr/bin"),
            ("GH_CONFIG_DIR", "/the/hosts/own/session"),
        ])
    }

    /// A call that sets the provider's variables on itself.
    fn ambient_call() -> HashMap<String, String> {
        call_env(&[
            ("GH_TOKEN", "ambient"),
            ("GITHUB_TOKEN", "ambient"),
            ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
        ])
    }

    fn named_env(pairs: &[(&str, &str)]) -> BTreeMap<OsString, OsString> {
        pairs
            .iter()
            .map(|(name, value)| (OsString::from(*name), OsString::from(*value)))
            .collect()
    }

    fn call_env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect()
    }

    fn value(env: &BTreeMap<OsString, OsString>, name: &str) -> Option<String> {
        env.get(OsStr::new(name))
            .map(|v| v.to_string_lossy().into_owned())
    }

    /// Every entry the platform would read under this name, spelling and all.
    fn entries_named(env: &BTreeMap<OsString, OsString>, name: &str) -> Vec<(String, String)> {
        env.iter()
            .filter(|(held, _)| held.eq_ignore_ascii_case(name))
            .map(|(held, value)| {
                (
                    held.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
            .collect()
    }

    #[tokio::test]
    async fn a_command_that_outlives_its_timeout_is_killed_and_names_the_value() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [{ "program": "sleep", "args": ["30"] }],
            "timeout": 1
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(is_error, "a timeout is an error: {content:?}");
        assert!(
            content.contains("exceeded the 1s timeout"),
            "the timeout it was given is not named: {content:?}"
        );
    }

    #[tokio::test]
    async fn a_command_inside_its_timeout_is_untouched() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [{ "program": "echo", "args": ["quick"] }],
            "timeout": 30
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(!is_error);
        assert!(content.contains("quick"), "stdout absent: {content:?}");
    }

    #[tokio::test]
    async fn the_timeout_bounds_the_whole_call_not_each_command() {
        let mut cancel = no_cancel();
        // Two seconds each against a three second bound: per-command the pair
        // would both finish, so surviving the first and dying in the second is
        // what proves the deadline spans the call.
        let input = json!({
            "commands": [
                { "program": "sleep", "args": ["2"] },
                { "program": "sleep", "args": ["2"] }
            ],
            "timeout": 3
        });
        let (content, is_error) = run_input(input, &mut cancel).await;
        assert!(is_error);
        assert!(
            content.contains("exceeded the 3s timeout"),
            "the call was not killed at its own bound: {content:?}"
        );
    }

    #[tokio::test]
    async fn a_timeout_leaves_the_rest_of_the_chain_unrun() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "sleep", "args": ["30"] },
                { "program": "echo", "args": ["after"] }
            ],
            "timeout": 1
        });
        let (content, _) = run_input(input, &mut cancel).await;
        assert!(
            content.contains("(skipped)"),
            "a command after the timeout still ran: {content:?}"
        );
    }

    #[tokio::test]
    async fn a_timed_out_call_says_that_repeating_it_will_not_help() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [{ "program": "sleep", "args": ["30"] }],
            "timeout": 1
        });
        let (content, _) = run_input(input, &mut cancel).await;
        assert!(
            content.contains("Running it again unchanged will hit the same limit"),
            "the result gives the model nothing to act on: {content:?}"
        );
    }

    #[tokio::test]
    async fn a_command_that_finished_before_the_deadline_reports_its_own_status() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "printf", "args": ["x"], "op": "|" },
                { "program": "sleep", "args": ["30"] }
            ],
            "timeout": 1
        });
        let (content, _) = run_input(input, &mut cancel).await;
        assert!(
            content.contains("exit status: 0"),
            "a command that had already exited lost its status: {content:?}"
        );
    }

    #[tokio::test]
    async fn only_the_commands_the_timeout_killed_are_reported_as_killed() {
        let expected = 1;
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "printf", "args": ["x"], "op": "|" },
                { "program": "sleep", "args": ["30"] }
            ],
            "timeout": 1
        });

        let (content, _) = run_input(input, &mut cancel).await;
        let actual = content.matches("killed: exceeded").count();

        assert_eq!(actual, expected, "in: {content:?}");
    }

    /// One grace for the whole call, not one per command: five commands used to
    /// cost five 500ms waits, so the call outran its own deadline by 2.5s.
    #[tokio::test]
    async fn the_kill_grace_does_not_grow_with_the_number_of_commands() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "sleep", "args": ["30"] }
            ],
            "timeout": 1
        });

        let started = std::time::Instant::now();
        let (content, _) = run_input(input, &mut cancel).await;
        let actual = started.elapsed();

        assert!(
            actual < Duration::from_millis(2500),
            "the grace was paid per command: {actual:?}, {content:?}"
        );
    }

    /// The other site that kills several things at once: a spawn failure tears
    /// down whatever already started, and that teardown gets one grace too.
    #[tokio::test]
    async fn a_spawn_failure_kills_what_started_with_one_grace() {
        let mut cancel = no_cancel();
        let input = json!({
            "commands": [
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "sleep", "args": ["30"], "op": "|" },
                { "program": "no-such-program-on-this-machine" }
            ],
            "timeout": 30
        });

        let started = std::time::Instant::now();
        let (content, is_error) = run_input(input, &mut cancel).await;
        let actual = started.elapsed();

        assert!(
            actual < Duration::from_millis(1500),
            "the grace was paid per child: {actual:?}, {is_error}, {content:?}"
        );
    }

    #[test]
    fn a_call_without_a_timeout_is_refused() {
        let actual = parse_call(&json!({ "commands": [{ "program": "echo" }] }));

        assert!(actual.is_err());
    }

    #[test]
    fn a_timeout_of_zero_is_refused() {
        let actual = parse_call(&json!({ "commands": [{ "program": "echo" }], "timeout": 0 }));

        assert!(actual.is_err());
    }

    #[test]
    fn a_negative_timeout_is_refused() {
        let actual = parse_call(&json!({ "commands": [{ "program": "echo" }], "timeout": -30 }));

        assert!(actual.is_err());
    }

    #[test]
    fn a_call_keeps_the_timeout_it_asked_for() {
        let expected = seconds(30);

        let actual = parse_call(&json!({ "commands": [{ "program": "echo" }], "timeout": 30 }))
            .expect("valid call")
            .timeout_s;

        assert_eq!(actual, expected);
    }

    #[test]
    fn with_no_ceiling_the_call_runs_for_what_it_asked_for() {
        let expected = Duration::from_secs(30);

        let actual = resolve_timeout(seconds(30), None);

        assert_eq!(actual.expect("no ceiling"), expected);
    }

    #[test]
    fn with_no_ceiling_even_an_extravagant_timeout_stands() {
        let expected = Duration::from_secs(86400);

        let actual = resolve_timeout(seconds(86400), None);

        assert_eq!(actual.expect("no ceiling"), expected);
    }

    #[test]
    fn a_timeout_under_the_ceiling_is_left_alone() {
        let expected = Duration::from_secs(30);

        let actual = resolve_timeout(seconds(30), Some(seconds(900)));

        assert_eq!(actual.expect("under the ceiling"), expected);
    }

    #[test]
    fn a_timeout_at_the_ceiling_is_allowed() {
        let expected = Duration::from_secs(900);

        let actual = resolve_timeout(seconds(900), Some(seconds(900)));

        assert_eq!(actual.expect("at the ceiling"), expected);
    }

    #[test]
    fn a_timeout_over_the_ceiling_is_refused_rather_than_clamped() {
        let actual = resolve_timeout(seconds(901), Some(seconds(900)));

        assert!(actual.is_err());
    }

    #[test]
    fn a_refusal_names_the_ceiling_the_host_allows() {
        let actual = resolve_timeout(seconds(901), Some(seconds(900))).expect_err("over");

        assert!(
            actual.contains("900"),
            "the caller cannot see what it may ask for: {actual:?}"
        );
    }

    /// The tools array heads the cached prompt prefix, so one host's
    /// configuration showing up in it would cost that host the whole prefix.
    #[test]
    fn the_schema_never_names_a_number_a_host_configured() {
        let schema = exec_schema();

        let actual = schema["input_schema"]["properties"]["timeout"]["description"]
            .as_str()
            .expect("timeout is described")
            .to_owned();

        assert!(
            !actual.contains("900"),
            "a host's own ceiling reached the cached prefix: {actual:?}"
        );
    }

    #[test]
    fn the_schema_warns_that_a_maximum_may_apply() {
        let schema = exec_schema();

        let actual = schema["input_schema"]["properties"]["timeout"]["description"]
            .as_str()
            .expect("timeout is described")
            .to_owned();

        assert!(
            actual.contains("maximum") && actual.contains("refused"),
            "the model cannot know the refusal exists before it meets one: {actual:?}"
        );
    }

    #[test]
    fn the_schema_requires_a_timeout() {
        let expected = json!(["commands", "timeout"]);

        let actual = exec_schema()["input_schema"]["required"].clone();

        assert_eq!(actual, expected);
    }
}

#[cfg(test)]
mod key_order_proof {
    #[test]
    fn round_tripping_a_tool_call_through_serde_json_value_preserves_key_order() {
        // Regression guard for the `preserve_order` feature on serde_json
        // (mvp/Cargo.toml): without it, this round-trip would alphabetize to
        // {"args":...,"op":...,"program":...} regardless of the input order —
        // which is exactly what a model actually wrote gets silently reordered
        // to on the way into telemetry.tool.use's "input": block["input"].
        let input = r#"{"program":"ps","args":["aux"],"op":"|"}"#;
        let v: serde_json::Value = serde_json::from_str(input).unwrap();
        let out = serde_json::to_string(&v).unwrap();
        assert_eq!(out, input, "key order was not preserved: {out}");
    }
}
