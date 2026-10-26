# Proof 16: publishing as the model received it

**Question.** What it takes to publish the conversation in the form the
model received it (approach A: copy from the request body; B: reimplement
Claude Code's fold), and to resume from that. Where a reminder sits in what
the model received is semantic, not presentation.

**Method.** Live seeds plus an offline corpus of 230 recorded runs; the
publish step compared against real request bodies; resumes compared against a
resume from Claude Code's full record.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 95, on Sonnet 5. Branch `proof-16-semantic-form` (188ba0d to
b3006d0), off `proof-14-pure-resume`.

**Found.**
- `OTEL_LOG_RAW_API_BODIES` is documented. The noise floor between requests is
  `device_id` and `cc_prompt_id`.
- A matched the body in 10 live seeds but failed attribution on
  `deferred_tools_delta` and on reminders folded into tool results.
- B fails when capabilities change.
- The resume matches the full record when `load()` carries entries with no
  blocks (at least an empty `session_context`).
- A depends on the raw body log and a `thread` selector; B on undocumented
  2.1.282 internals.
- Proof 14's "byte-identical" skipped `diagnostics.previous_message_id` and
  `cc_prev_req`, which differ.

**Resume comparison.** A resume from the published form against a resume
from Claude Code's full record, both after resuming.

**Status.** Set aside when "what is committed follows Claude Code" was
chosen (see [running.md](../participant/running.md)).
