# Proof 20: copying the conversation from the request body

**Question.** Approach A from proof 16 (copy what the model received from the
request body), judged on Sonnet, Opus and Fable. Haiku is reported but not
used to decide.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** Four models, twice each (the second round is the evidence); 111 run
dirs (37 Haiku, 26 Opus, 26 Fable, 22 Sonnet). Branch `proof-20-body-copy`
(9980985 to 3468ac0); no README section of its own.

**Found.**
- Proof 16's `thread` selector was wrong; a history-based selector found
  every main request (corpus: Sonnet 800 of 806, Opus 22 of 22, Fable 19 of
  19, no false positives).
- Blocks without entries are tied: tool additions to `deferred_tools_delta`,
  batching reminders by `attachment.text`. Retries and aborts are handled.
- Haiku spans 519 of 522.
- The resume is identical to a full-record resume on every model.
- Still broken in the corpus: 753 of 800.
- Rule breaks in the run: it routed around a blocked `sleep`; a research
  subagent read Stephen's transcripts; it read a tool-result file under
  `~/.claude/projects`.

**Resume comparison.** A resume from the published form against a resume
from Claude Code's full record, both after resuming.

**Status.** Set aside with proof 16.
