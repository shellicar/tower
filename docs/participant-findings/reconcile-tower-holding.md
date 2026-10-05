# What tower holds, and when: the reconcile

**Question.** Reconcile proof 24 (commit Claude Code's pieces) with proofs 16
and 20 (commit the messages as the model received them): what tower holds,
and at what moment each part is committed. R1: commit once known persisted.
R2: exactly what Claude Code builds its next query on. Placement of
reminders is semantic.

**Method.** First offline over proof 24's 229 recorded runs, then live: 16
rounds on four models, every option resumed. Evidence in the reconcile
worktree (`runs/rc-all-table.md`, `rc-all.analysis.jsonl`,
`rc-bare-resumes.md`, `rc-carriers.txt`); branch `reconcile-tower-holding`.

**Versions.** Not recorded (proof 24's recordings are 2.1.282).

**Found.**
- The prompt is persisted about 80 ms after its request file, but whether
  that request's form is the one kept is known only when a reply is kept
  (median 1.1 to 1.6 s, up to 21 s). So an as-received message can't be both
  committed at persistence and never change.
- Six options (entry, request, run, run+last, run+entry, next), each with
  its commit delay, form match and resume result per model. Resume depends
  only on which entries tower holds, not their form.
- Reminder placement differs by model: on Sonnet, Opus and Fable reminders
  are grouped into one system message after the user message; on Haiku they
  are folded into the user message or tool result. After an interrupt with
  nothing kept, the next request merges prompt, marker and next prompt.
- All six render in tower with no Claude Code-specific code. The as-received
  options need the request-body log, proof 20's selector, reply-to-request
  pairing and `rendered`. Predicting the form with Claude Code's own fold
  matched 181 of 181 on three models and 56 of 62 on Haiku.
- Its brief listed "no tower updates" and "tower is the authority" as
  settled; both rest only on the brief being sent, and "no tower updates" is
  contradicted by the frontend label changes since.

**Resume comparison.** Mostly the resumed request against Claude Code's own
record or the live request; unclear in places.

**Status.** Set aside when "what is committed follows Claude Code" was chosen
(see [running.md](../participant/running.md)).
