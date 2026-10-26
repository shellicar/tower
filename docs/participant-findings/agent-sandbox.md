# The agents' own sandbox: signing, docker and refusals

Three studies of the Bash sandbox that the agents building tower run in.
They concern how work gets done on the machine, not the participant itself.
What came of them is in CLAUDE.md, Running commands.

## Signing commits from a sandboxed agent

**Method.** Probes of which command forms Claude Code's settings exclude from
the sandbox (a pathspec probe of PID 1's name), and of what the sandbox
blocks.

**Found.**
- Excluded, so able to sign: a plain `git commit`, also with `LANG=C`,
  `timeout`, `2>&1`, or `;` between two commits. Sandboxed, so unable: `FOO=1`
  before it, a pipe, `git -C`, `git -c`, `/usr/bin/git`, `-m "$(...)"`.
- Unix sockets are blocked by seccomp whatever the path, so gpg-agent,
  keyboxd and ssh-agent are unreachable inside the sandbox.
- Host loopback over TCP looked reachable through the sandbox proxy for HTTP;
  the study warned this might include the live NATS on 4222 (untested).
  Stephen's account is that NATS doesn't get through the proxy (it terminates
  TLS, and NATS speaks first), and a curl to the test broker on 31416 from
  inside the sandbox failed. These accounts conflict; only the failed curl is
  observed.
- Signing options (a signing daemon, an SSH key file, a `sq` key file,
  unsigned then squashed or re-signed): untested.
- Holes in the `git commit *` exclusion: lefthook repos run working-tree code
  unsandboxed (not tower); `.git/worktrees/<name>/hooks` is writable and the
  global pre-commit runs it; other worktrees' `.git` files are writable, so
  one session could repoint another's worktree; an unsandboxed commit can read
  denied files through `--pathspec-from-file`, `-F` or `--template`; filter
  drivers in `.git/info/attributes`. Narrowing options: exclude only
  `git commit --no-verify *`, a fixed wrapper script, or an ask rule.

## Docker from the sandbox

**Found.** Docker fails inside the sandbox because seccomp refuses
`socket(AF_UNIX)`, not because of the socket file's permissions. The route
taken: exclude `docker compose -f compose.test.yaml *` and
`docker compose -f mvp/compose.test.yaml *` from the sandbox (in CLAUDE.md).
Not taken: `allowAllUnixSockets` (exposes the Docker socket, which is
root-equivalent, and more), `allowUnixSockets` (macOS only), retrying with the
sandbox off, a socket proxy. On Linux and WSL a sandboxed command can't reach
a host server on 127.0.0.1 (from documentation), so a sandboxed command can't
reach the test broker; the cause conflicts with Stephen's proxy account
above. Still to check from his terminals: WSL `docker ps` and
`just broker-run 'true'`, and the macOS docker context and socket paths.

## Does working around a sandbox failure raise refusals?

**Found.** Across all transcripts: 82 distinct auto-mode refusals, 64 from
real sessions, 17 for the reasons asked about (Safety Bypass Flag 11, 10 of
them after a failed or refused call; Self-Modification 3; Auto-Mode Bypass 2;
Instruction Poisoning 1). In 4 or 5 of the Safety Bypass cases the refused
call carried `dangerouslyDisableSandbox: true` right after a sandbox failure.
Refusals cluster within a turn. The pattern is narrow: retrying a failed
sandbox command with the sandbox off, or by another route to the same
effect, not any failure in general.
