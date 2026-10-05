# Proof 23: when Claude Code commits

**Question.** When does Claude Code commit, judged against the next request's
history? The working model to test: commit once Claude Code has committed;
a thinking block is either whole or absent, so aborting during thinking
cancels the whole request, while aborting during anything else still
commits what was said.

**Method.** Commit options scored against the next request's history from
the same live Claude Code (the ground truth). After an abort, the probe also
goes into a store resume and a transcript resume; after an interrupt, a
transcript resume compares what is on disk with what the running Claude Code
had in memory.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** Each cell twice on Sonnet 5, Opus 5.5, Fable 5.1 and Haiku 4.5; 361
run dirs. Branch `proof-23-commit-timing` (0af5175 to 39f9365, add5c1d,
116efa2).

**Found.**
- A reply's entries are written together, median 15 ms after
  `message_stop`, not block by block.
- The prompt reaches the transcript about 80 ms after the request file.
- Thinking-only replies are written, then dropped.
- Sonnet, Opus and Haiku requests often carry only the new messages
  (`thread: continue`).
- A per-ending table of what is kept (in the branch's README). The working
  model holds for thinking and for an interrupt mid-text, but not mid
  tool-call input, during tool execution, or for abort.
- No single signal tells exactly when to commit.

**Resume comparison.** Mixed: commit options against the live ground truth;
after an abort, a store resume and a transcript resume both after resuming
(close to the comparison that counts now); after an interrupt, disk against
memory.

**Used by.** [running.md](../participant/running.md) (when something counts
as committed).
