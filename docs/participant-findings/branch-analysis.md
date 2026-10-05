# Branches inside a query

**Question.** Does a single Claude Code ever branch inside a query, which
would need a parent on every message rather than on the query?

**Method.** Analysis of 3,811 transcripts from Stephen's CLI sessions and the
proof runs. The data was in `/tmp/branch-analysis/`, now gone.

**Versions.** Not recorded (the transcripts span his CLI's versions and the
proofs' 2.1.282).

**Found.**
- A single Claude Code never branches inside a query in what it sends. How
  each observed behaviour is expressed by a parent on the query:
  - Esc during thinking, then a new prompt: the new query's parent is the tip
    (in the CLI the cancelled prompt is a dead end; over the SDK the chain is
    straight).
  - `/rewind`, or a resume from an earlier point: the new query's parent is
    the earlier message.
  - A kill then recovery: a straight line in one query; the next prompt's
    query has the synthetic reply as its parent.
  - Esc mid-reply: a straight line.
  - A subagent's machine input attaching before its last reply (69 cases,
    cause unresolved): the new query's parent is the message before that
    reply.
  - Parallel tool calls look forked in the file (each result hangs off its
    own `tool_use` entry), but the request merges them, in written order. Not
    a branch.
  - Two processes writing one session (proof 17b, 8 cases): the only real
    branch inside a query. The spec handles it (one instance attached at a
    time; on replay the attached one wins), though it is a potential issue.
    Bridge's adopt replays in stream order, where overlapping writers would
    mix (inferred from code).

**Resume comparison.** Not about resume.

**Used by.** The query parent in
[spec-and-frontend.md](../participant/spec-and-frontend.md).
