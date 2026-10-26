# The integration attempts

Before the fresh build, the proofs were put together into one participant to
show where they conflicted or raised new issues: does it work, and where it
doesn't, what can be done. These attempts were set aside on 29 Sep for the
fresh build. Their code is reference only.

## The first attempt

Branch `integration-participant`. The later account says it too was judged
against a wrong wording of R1; that wasn't checked for this attempt. Branch
`integration-participant-2` is kept only as evidence of an incident on 27 Sep;
nothing here comes from it.

**Method.** Live runs per ending on Sonnet, Opus and Fable (Haiku reported).
Code in `proofs/integration/`; evidence in `runs/int-*/table.md` on the
branch. Versions not recorded in the task file.

**Found.**
- Worked: tower held what the model received at every ending; a same-machine
  restart equalled live; killed-and-served passed; the home was untouched;
  skills behaved as in plain Claude Code; two participants were isolated.
- Failure 1: an interrupt during a tool leaves tower ending on a tool call
  with no result, and a tower-only resume gets "[Tool result missing due to
  internal error]".
- Failure 2: when tower has moved on, the first machine's prompt is lost and a
  gap appears in the chain.
- Failure 3: a conversation first resumed from tower lives in
  `/tmp/claude-resume-*`, deleted on a clean exit, so later restarts go to
  tower without the unclosed part.
- Ways through tried (all marked undecided): a held-carrier (a new
  `changes.held` leaf), commit-dangling, cut-dangling (no), load-unbacked,
  anchor-fallback, materialise (writes Claude Code's internal format), record
  (`load()` returns the participant's own recording).
- Also: the rule depends on `OTEL_LOG_RAW_API_BODIES`; under auto mode a tool
  call reaches the store 1.2 to 1.8 s late; `applyFlagSettings({env})`
  changes env per request live; Haiku has no auto mode, so a restart differs;
  a leftover's queued background notification is replayed after recovery.
- Confirmation run: 83 of 85, 82 of 85, 81 of 85 across three models; a
  restart from the participant's own recording passed on all three.
- Its brief listed "tower is the authority and a commit is a fact" and
  "skills via the `user` source" as settled; both rest only on the brief
  being sent.

**Resume comparison.** The resumed request against the live next request.

## Attempt 3

Branch `integration-participant-3` (tip 0ba3832). README section "The
integration proof, attempt 3"; `proofs/integration/invariant.mts`;
`stage3/report.md`, `grids.txt`, `home.md` hold per-model, per-ending
verdicts.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282. 1,254 run dirs across
four models.

**Found.** Its first run as one thing: the hybrid store (local record first,
tower's tip checked before use, tower for a conversation the machine never
had), the private HOME, the orphan tag and recovery. On Sonnet, "run+last"
showed content failures at the output-limit, API-error, thinking,
tool-input and first-byte endings, and shape-only failures elsewhere. It was
judged by a check built on the wrong wording of R1, so its failures aren't
measured against Stephen's rule. Choices its agents made without him: a fix
near the excluded anchor fallback, what the check counts as truth, and a
stage agent changing the check after being told not to.

**Resume comparison.** Tower against live requests; a round trip through a
Claude Code resumed from tower was never counted as a pass.

What a fresh builder needed from its code is in the
[attempt 3 code review](integration-attempt-3-review.md).
