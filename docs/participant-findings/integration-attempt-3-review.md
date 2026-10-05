# Review of the third integration attempt's code

A read-only review of attempt 3's code, written as what a fresh builder
needs to know. Builders of the foundation, shutdown and leftovers pieces
worked from it. Every fact is an agent finding drawn from proofs 1 to 26 and
attempt 3; "observed" means a run, "code" means read from the code. Attempt 3
ran Agent SDK 0.3.282 and Claude Code 2.1.282; per-fact versions aren't
recorded.

## Configuration and launch

1. Max tokens reach Claude Code only through `CLAUDE_CODE_MAX_OUTPUT_TOKENS`,
   read afresh per request; deleting it mid-run gives Claude Code's default of
   64,000. The SDK never reports the value sent; an over-limit value is capped
   silently. Observed.
2. The thinking display must be set explicitly; with none, or `omitted`,
   Claude Code asks for `updates`. `showThinkingSummaries` doesn't help.
   Observed on four models.
3. `settingSources: []` blocks CLAUDE.md, but connectors, the account's
   plugins and telemetry posts still arrive through the login. Observed.
4. The parent session's environment leaks unless stripped; `TMUX` and
   `TMUX_PANE` still reach Claude Code.
5. Unresolved: `API_TIMEOUT_MS` changed through `applyFlagSettings` had no
   effect in proof 24, yet attempt 3 relied on it.
6. A live `applyFlagSettings({permissions})` replaces the whole permissions
   object. Observed.
7. A broker persists only with JetStream on the volume (`-sd /data`).
   Inferred.
8. An unset `NATS_URL` means the live broker on 4222.

## Launching Claude Code

9. A resume through the session store (when `load()` returns entries) runs in
   a temporary config dir, `/tmp/claude-resume-<uuid>`. The transcript and
   pid file land there. The SDK copies `.claude.json`, `.config.json` and a
   filtered settings.json, but not skills, CLAUDE.md, rules, agents or
   commands. It deletes the dir after Claude Code exits while the host lives,
   and leaves it if the host is killed. Observed (the copying inferred from
   the SDK).
10. A resumed Claude Code starts only after the SDK writes that dir, so its
    pid isn't known when `query()` returns.
11. The spawn hook must never change `CLAUDE_CONFIG_DIR`, or the SDK drops the
    store's mirror frames. Inferred from an SDK warning, untested.
12. `CLAUDE_SECURESTORAGE_CONFIG_DIR` must be set in the spawn hook, because
    the SDK's resume route overrides `options.env`. `''` under a private HOME
    gives "Not logged in"; the absolute real `~/.claude` works. Observed.
13. `setpriv` works only if the hook spawns the real binary directly. With it,
    a SIGKILLed host's Claude Code gets SIGINT and exits in about 2.4 to 2.9 s
    with its partial reply kept; without it, Claude Code runs its whole turn
    unsupervised (35 to 64 s). On a JavaScript-exception death the SDK sends
    SIGTERM anyway. A capture wrapper doubles a group SIGINT. Observed.
14. Running without `setpriv` was untested in attempt 3 (later exercised by
    the leftovers live checks).
15. Skills: `skills/` must exist before start; a resume with no link reports
    "Loaded 0 unique skills"; `reloadSkills()` blocks input up to 30 s while
    claude.ai skill sync is on (code); a removed skill is never announced; a
    folder with `.claude-plugin/plugin.json` loads as a plugin, hooks and MCP
    included.
16. Opening the `user` setting source runs a clean-up on paths hard-coded to
    the real home: a reason for the private HOME.
17. What the private HOME breaks: the shell snapshot sources no rc files; Read
    and Write resolve `~` to the private home; Claude Code's git reads the
    private `.gitconfig`; `/tmp/claude-1000/` and `cc-socks` stay shared.
    Observed.
18. Nothing in the real home was changed by Claude Code's own processes, on
    four models. Observed.
19. Auto mode: the `dangerous-tool-use-2026-09-03` beta stays on once set,
    but a resumed Claude Code's first request lacks it; a tool call reaches
    the store 1.2 to 1.8 s late; Haiku 4.5 falls back to another mode.
    Observed.
20. Connectors off works under `settingSources: []`; with them on, the first
    request after each resume carries only Bash and misses the cache.
    Observed.
21. Additional directories are lost on every resume route; under
    `settingSources: []`, `--add-dir` loads no skills. Observed.
22. A session store makes the SDK pass `--session-mirror`, and `result`
    arrives only after the turn's appends. Observed.

## The requests

23. `interrupt()` keeps the partial reply and adds "[Request interrupted by
    user]" (or a rejected tool result) within about 40 ms; `interrupt()` to
    `result` takes 4 to 28 ms, and the store is complete at `result` (77 of
    77 and 94 of 94 runs). Observed.
24. An interrupt during a tool: the tool ran, but the model is told it was
    rejected (`toolDenialKind: "user-rejected"`). Observed.
25. What survives depends on when the interrupt lands: nothing before the
    first byte or during thinking; thinking plus partial text mid-text; no
    partial call mid tool-input; the call kept and its result replaced during
    tool execution. Observed.
26. Under auto mode, an interrupt 2 s into a tool can land in the permission
    check. Observed.
27. An interrupted query ends `error_during_execution` with `is_error: true`;
    an API-error ending is `subtype: 'success'` with `is_error: true`.
    Observed.
28. A thinking-only reply never ends a query in 2.1.282; Claude Code nudges
    and asks again. Observed.
29. Claude Code starts turns itself when a background agent or shell
    finishes: a second `init`, a reply and a `result` with
    `origin: task-notification`; the opening user message isn't sent to the
    host. After recovery, a leftover's queued notification replays. Observed.
30. A prompt sent mid-turn gets no user entry; it becomes a `queued_command`
    attachment and reaches the model as a system reminder. Observed.
31. A prompt with a client uuid keeps it; the SDK echoes prompts only with
    `--replay-user-messages`. Observed.
32. `set_cwd` is undocumented and idle-only, has a `needs_trust` handshake,
    and starts a new server-side thread. After it, the SDK's `cwd` decides
    where a resume runs, and a file store keyed by project splits the
    conversation. Observed.
33. SDK assistant messages carry `stop_reason: null` and start-of-message
    usage; final values are in stream events or the store. Observed.
34. A usage limit shows as `api_retry` with status 429 and as an `is_error`
    result; the weekly-limit wording was missed once. Observed.
35. Claude Code sends requests that aren't the main loop, with the same model
    and thinking; telling the main request apart needs a `thread` or
    non-empty `tools`.
36. JetStream consumers must be deleted after each read, or reads hit the
    1,000-consumer limit. Observed.

## Shutdown

37. Exiting straight after the queries end cuts off the SDK's removal of
    `/tmp/claude-resume-*`. (Doesn't apply while `load()` returns null.)
    Observed.
38. SIGINT straight to Claude Code works like `interrupt()`: partial kept,
    exit 0 in about 0.8 s. Observed.
39. SIGTERM straight to Claude Code: no partial and no marker, exit 143 in
    about 0.8 s; the request in flight isn't cancelled (one conversation wrote
    its full reply 2.5 s later); a running tool is recorded as "Exit code
    137". Observed.
40. Tool child processes get SIGTERM about 55 ms after Claude Code stops.
    Observed.
41. The SDK's abort closes input, waits exactly 2.000 s, then sends SIGTERM;
    it never writes a partial reply and loses 2 to 9 lines. Observed.
42. Three presses 0 ms apart: the host exited within 3 ms and the store
    missed 4 to 5 entries.
43. A terminal Ctrl-C reaches the whole process group, so each Claude Code
    commits and exits by itself and the host's interrupts then fail.
    Observed.
44. A second SIGINT to a Claude Code already shutting down does no harm.
    Observed.
45. A test driver that fails mid-run must stop what it started, or the next
    serve meets leftovers. Observed.

## Before serving

46. Pid files are not enough to find leftovers: Claude Code deletes
    `sessions/<pid>.json` 3 to 27 ms after SIGINT or SIGTERM but runs on 2.5
    to 2.9 s, and resumed ones keep their pid file in `/tmp/claude-resume-*`
    (18,386 of 26,072 samples wrongly allowed). Observed. (This sits against
    fact 39's 0.8 s exit after SIGTERM; the leftovers review used this one to
    set the scan's SIGTERM wait to 5 s.)
47. The tag scan found every Claude Code in 84 runs and 168 conversations,
    including serves 1 to 7 ms after host death. Observed.
48. Edge cases the scan must handle: a main thread looks like a zombie for
    about 11 ms; reading an environment fails with EACCES in a process's last
    1 to 13 ms (try other threads); an environment can read as empty;
    processes vanish mid-scan; tools inherit the tag; a background tool can
    hold the serve. Observed.
49. Read `/proc/<pid>/cmdline` in full; a copy cut at 100 characters missed
    the bundled binary's path.
50. Signal only while the start time (field 22 of `/proc/<pid>/stat`, read
    after the last `)`) still matches.
51. The stop must finish before recovery, or a leftover writes after the
    check. Observed.
52. Nothing refuses two processes on one session; serving beside an orphan
    forks the record, and the next resume drops one branch silently. Observed
    and code.
53. In attempt 3 the SIGTERM and SIGKILL steps never signalled a real
    leftover (1,135 serves found nothing in 1,119 cases).
54. Recovery read the files directly, because `importSessionToStore` reads
    `CLAUDE_CONFIG_DIR` from the process environment; proof 17's version
    added 4 to 9 late entries after a SIGKILL.
55. A reboot loses a resumed conversation's entries that lived only in
    `/tmp/claude-resume-*`, and the check still reports nothing missing.
    Accepted.
56. `performance.timeOrigin + now()` drifts 140 to 170 ms from `Date.now()`.
    Observed.
57. The scan reads every process environment the user owns (a privacy risk).
58. Never tested: a native crash, out of memory, a reused pid, two writers
    under blind recovery.

## What attempt 3's code did against the record

Reference for what the fresh build avoided: `extraArgs:
{'setting-sources': 'user'}` undoing `settingSources: []`; a hard-coded NATS
address; the SDK system-prompt shape; `service` minting ids; no UUID check;
say-busy only for says, so self-started turns weren't busy; cancel ignoring
the query id; the stop on every serve.
