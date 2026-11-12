# Proof 14: whether a resume from tower is pure

**Question.** Does a resume from what tower holds send what a resume from
Claude Code's own record sends? The measure: replaying from tower shouldn't
change the cache prefix; if it does, the resume isn't pure, and the reason
should be known so the impurity can be accepted or not knowingly.

**Method.** Resume straight away from Claude Code's full record and from
tower alone; compare the first resumed requests piece by piece and their
cache reads.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 10, on Sonnet 5, test broker 31416. Branch `proof-14-pure-resume`
(b71d8f8, 2ed99d2, d62783b).

**Found.**
- History from tower replays identically to the full record (messages 0 to
  11; 9,460 tokens read from cache for both).
- Not pure: from tower, Claude Code re-sends the session context and
  attribution, and re-announces environment, model, date and MCP. It decides
  this from typed `attachment` entries.
- When tower also carries each attachment object, the two resumes matched
  (9,531 read, 0 written). Six types were needed: session_context,
  remote_session_change, environment, model, date, mcp_instructions_delta.
  Proof 16 later found the requests still differed in
  `diagnostics.previous_message_id` and `cc_prev_req`, which this comparison
  skipped, so "byte-identical" doesn't hold.
- Accepting the impurity costs about 1,400 tokens per resume, piling up
  (inferred).
- The first request after any resume misses the history cache because
  connector tools join later.
- Carrying the objects needs no spec change to work: an unknown field is
  dropped silently, and a new leaf moves staleness through `ts`.

**Resume comparison.** A resume from the published record against a resume
from Claude Code's own record, both after resuming: the comparison that
counts now. On one seed.
