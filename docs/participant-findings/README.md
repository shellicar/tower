# Participant findings

One file per proof or investigation behind the Claude Code participant: what
it set out to find, what went into it, and what it found. The participant's
docs (`docs/participant/`) point here wherever something rests on a finding.

Unless a file says otherwise, a finding is what the agent that ran it
reported; versions and run counts were checked on disk, the findings
themselves were not re-run.

## Two resume comparisons

Several proofs compare requests around a resume. They made one of two
different comparisons, and each file says which:

- **Before against after:** the first request after a resume compared with
  the live conversation's next request (or the seed's context).
- **Both methods after resuming:** a resume from the published store compared
  with a resume from Claude Code's own record. This is the comparison the
  target makes: the same messages array, given the same system prompt and
  tools (see [resume.md](../participant/resume.md)).

A pass on the first doesn't show the second.

## The proof harness

Proofs 1 to 26 ran on the proof harness (`mvp/claude-code-harness/`, branch
`claude-code-harness`, commits 9330fdb, 65996d0, 390b3b9, d049330, then
ce55fd8 for proof 1). It is isolated: `settingSources: []`, the parent
Claude Code session's environment stripped, the SDK's bundled Claude Code
binary, a shared login (credentials may be read from `~/.claude`; the login
is not config), per-proof working dirs under
`~/.local/state/tower-claude-code-harness/work/`, and each run recorded raw
(the binary's argv, stdin, stdout and stderr, the SDK messages, a copy of the
config dir). It sits in the pnpm workspace. The config dir is reset with
`pnpm reset-config-dir <name>`, never by an agent running `rm`.

- Every proof branch pins Agent SDK 0.3.282, and every run that logged a
  version ran Claude Code 2.1.282, except `cancel-cli` (the interactive CLI,
  2.1.283).
- **Config dirs:** the harness first gave every run a fresh config dir, which
  was never Stephen's decision; it is one config dir per agent, reused across
  its runs. Proofs 2 to 19 sit on the old per-run harness; proof 17b and
  proofs 20 to 26, minimum entries, store commit and resume, the cancel
  branches and attempt 3 sit on the fixed one (ba7194d).
- Proof branches are local and not pushed, except `research-macos-keychain`
  and `proof-26-home`, pushed as `feature/research/macos-keychain` and
  `feature/research/proof-26-home`. Run directories are gitignored and live
  only in the proof worktrees.
- Risk seen: running `npx biome` once executed an unrelated npm package
  `biome@0.3.3` from an npx cache.

An earlier attempt (23 to 25 Sep) ran its proofs with Claude Code as one
long-lived streaming-input `query()`, a choice written into a proof brief and
never put to Stephen. Its code was deleted and its findings are not evidence.
(Streaming input was later chosen by Stephen, for background tasks.)

## The files

| File | Question | Resume comparison |
|---|---|---|
| [proof-01-thinking](proof-01-thinking.md) | Summarised thinking | n/a |
| [proof-02-entries-to-messages](proof-02-entries-to-messages.md) | Transcript entries and SDK messages | n/a |
| [proof-03-session-store](proof-03-session-store.md) | The session store as the commit signal | neither |
| [proof-04-live-changes](proof-04-live-changes.md) | What can change on a running Claude Code | n/a |
| [proof-05-subagents-and-shells](proof-05-subagents-and-shells.md) | Subagents and shells | n/a |
| [proof-06-max-tokens](proof-06-max-tokens.md) | Max tokens | n/a |
| [proof-07-killed-outright](proof-07-killed-outright.md) | Stopping and killing mid-turn | neither |
| [proof-08-resume-store](proof-08-resume-store.md) | Where a resumable conversation can live | before against after |
| [proof-09-resume-spec](proof-09-resume-spec.md) | Resuming from tower's spec | before against after |
| [proof-10-directories-permissions](proof-10-directories-permissions.md) | Working directories and permissions | n/a |
| [proof-11-context](proof-11-context.md) | CLAUDE.md and context | n/a |
| [proof-12-skills-dir](proof-12-skills-dir.md) | Skills from a dynamic directory | n/a |
| [proof-13-resume-cwd](proof-13-resume-cwd.md) | Resuming after a cwd change | mostly before against after |
| [proof-14-pure-resume](proof-14-pure-resume.md) | Whether a resume from tower is pure | both methods after resuming |
| [proof-15-machine-messages](proof-15-machine-messages.md) | Messages Claude Code writes itself | n/a |
| [proof-16-semantic-form](proof-16-semantic-form.md) | Publishing as the model received it | both methods after resuming |
| [proof-17-recovery](proof-17-recovery.md) | Recovering blind | neither |
| [proof-17b-shared-dir](proof-17b-shared-dir.md) | Two processes on one session | neither |
| [proof-18-connectors](proof-18-connectors.md) | Keeping connectors out | neither (cache after resume) |
| [proof-19-skills-plain](proof-19-skills-plain.md) | Skills without a prefix | n/a |
| [proof-20-body-copy](proof-20-body-copy.md) | Copying from the request body | both methods after resuming |
| [proof-21-orphans](proof-21-orphans.md) | Stopping an orphaned Claude Code | neither |
| [proof-22-skills-user-level](proof-22-skills-user-level.md) | Skills through the user level | neither |
| [proof-23-commit-timing](proof-23-commit-timing.md) | When Claude Code commits | mixed |
| [proof-24-next-query](proof-24-next-query.md) | Committing what the next query builds on | before against after |
| [proof-25-orphan-tag](proof-25-orphan-tag.md) | Tagging Claude Codes to find leftovers | neither |
| [proof-26-home](proof-26-home.md) | Keeping out of the user's home | neither |
| [minimum-entries](minimum-entries.md) | Minimum entries for a resume | neither (store against store) |
| [macos-keychain](macos-keychain.md) | The login on macOS | n/a |
| [store-commit-resume](store-commit-resume.md) | Committing every entry, resuming at the last | before against after (mid); near both methods (end) |
| [cancel-scenarios](cancel-scenarios.md) | Cancel and kill, SDK and CLI | unclear |
| [branch-analysis](branch-analysis.md) | Branches inside a query | n/a |
| [integration-attempts](integration-attempts.md) | The integration attempts | before against after |
| [integration-attempt-3-review](integration-attempt-3-review.md) | What a fresh builder needs from attempt 3 | n/a |
| [reconcile-tower-holding](reconcile-tower-holding.md) | What tower holds, and when | mostly before against after |
| [foundation-probes](foundation-probes.md) | Giving Claude Code the required values | n/a |
| [leftovers-live-checks](leftovers-live-checks.md) | The leftover scan against real processes | n/a |
| [shutdown-live-checks](shutdown-live-checks.md) | Three-stage shutdown against real processes | n/a |
| [piece-live-checks](piece-live-checks.md) | Bus, publisher, kit, cancel, author, ready | n/a |
| [message-loss](message-loss.md) | How messages were lost | n/a |
| [what-the-model-sees](what-the-model-sees.md) | What the model sees, entry by entry | neither |
| [claude-code-rendering](claude-code-rendering.md) | How Claude Code draws each kind | n/a |
| [resume-prototype](resume-prototype.md) | Resuming from what was published | both methods after resuming |
| [resume-requirements](resume-requirements.md) | What a resume needs | mixed |
| [extras-design](extras-design.md) | Two designs for extra messages | n/a |
| [defaults-survey](defaults-survey.md) | What Claude Code sends by default | n/a |
| [reload-skills](reload-skills.md) | When `reloadSkills()` can be called | n/a |
| [trailing-thinking](trailing-thinking.md) | When a thinking-only reply is kept | n/a |
| [towerd-durable-fetch](towerd-durable-fetch.md) | Whether towerd can show durable files | n/a |
| [sandbox-under-sdk](sandbox-under-sdk.md) | Claude Code's sandbox under the SDK | n/a |
| [agent-sandbox](agent-sandbox.md) | The agents' own sandbox | n/a |
| [claude-cli-errors](claude-cli-errors.md) | How claude-cli shows errors | n/a |
| [lint-compare](lint-compare.md) | Biome against Oxlint, Oxfmt, dprint | n/a |
| [participant-updates](participant-updates.md) | Keeping Claude Code current | n/a |
| [subagent-stop](subagent-stop.md) | How subagents can be stopped | n/a |
| [bridge-gap](bridge-gap.md) | The participant against bridge | n/a |
| [cadence](cadence.md) | How long pieces took | n/a |
| [parked-elsewhere](parked-elsewhere.md) | Problems found outside the participant | n/a |

Evidence that is gone: the committer options report
(`/tmp/committer-options/final-report.md`), the branch analysis data
(`/tmp/branch-analysis/`) and the lint comparison scratch
(`/tmp/lint-compare/`) were in `/tmp`, which is cleared at boot.
