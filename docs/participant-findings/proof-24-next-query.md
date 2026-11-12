# Proof 24: committing the conversation Claude Code builds on

**Question.** Every way to commit, at a query's end, exactly what Claude Code
builds its next query on. The conversation is what the next query is built
on top of; a way to check it is that the cache prefix is the same, measured
through the token metrics.

**Method.** The probe is sent into the same running Claude Code: Claude
Code's own continuation (L) is the ground truth. A resume through a session
store holding each candidate commit (T) is compared with it: the history and
the cache numbers.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** Three live rounds on Sonnet, Opus and Fable, Haiku separately; 1,070
run dirs (303 Sonnet, 250 Opus, 247 Fable, 269 Haiku). Branch
`proof-24-next-query` (8cd81b5 to ff24375).

**Found.**
- Round 1: no way is exact at every ending. After an interrupt even a
  full-record resume differs from the live next query, because the
  deserialiser inserts "No response requested.". Output-limit and API-error
  endings conflict. All ways commit at `result`; the store was complete at
  `result` 77 of 77 times. The best reachable was the same request as a
  full-record resume.
- Round 2: option H met R1 (commit once known persisted) and R2 (exactly what
  Claude Code builds its next query on) at every ending on all four models:
  a hybrid commit, eager, holding a thinking-only entry until a sibling
  arrives; API-error entries carried but not shown; resume with
  `resumeSessionAt` set to the last non-system entry. The CLI appends to the
  transcript before the mirror frame. Opus caveat: a fresh resume sends
  `thread: create`.
- Stephen asked for confirmation; it wasn't confirmed.

**Resume comparison.** The resumed request against the live continuation
(before against after resuming). This is the earlier test, which Stephen
later said compared before and after rather than both methods after
resuming; it isn't the comparison that counts now.

**Status.** Its commit rules were set aside for now by "what is committed
follows Claude Code" (see [running.md](../participant/running.md)). See also
[reconcile](reconcile-tower-holding.md).
