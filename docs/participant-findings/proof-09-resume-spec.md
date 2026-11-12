# Proof 9: resuming from tower's spec

**Question.** Can a conversation resume from what tower's actual `conv.v2`
subjects carry, and what does it need?

**Method.** Published `changes.message` (id = Claude Code's uuid),
`changes.query` and `telemetry.usage` per usage frame, checked against
hand-transcribed spec schemas, then resumed.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (42 of 44 runs logged
it).

**Runs.** 44, on Sonnet 5. Branch `proof-9-resume-spec` (0443549).

**Found.**
- Resume works at both grains (entry and API message) if `load()` adds the
  model name (from telemetry) and the API-message grouping (from `turnId`).
- From `changes` alone, thinking is lost; at entry grain a parallel tool
  result is replaced by "[Tool result missing due to internal error]".
- A NATS-only resume re-sends the reminders; the hybrid reproduces exactly.
- Claude Code checks `message.model` only loosely on resume: any valid model
  name keeps thinking.
- No spec change was required.

**Resume comparison.** The resumed request against the live seed's context
(before against after). Not the comparison that counts now.

**Used by.** [running.md](../participant/running.md): each piece its own
message with `turnId` per response; the model isn't conversation state.
