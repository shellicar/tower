# How Claude Code draws each kind of message

**Question.** How Claude Code's terminal shows each kind of message, as a
reference for tower showing a conversation the way Claude Code does.

**Method.** Two sources, kept apart: Stephen's own screen (screenshots he
took in session f92f0592 on 2 to 3 Oct, matched to rows by the text he wrote
beside them), and reading Claude Code's code. Times are his local time
(UTC+10).

**Versions.** Claude Code 2.1.285 to 2.1.287.

**Found.**
- **Seen on his screen:** a subagent hand-back, collapsed or verbose;
  "No response requested." not drawn at all; shell tool calls; a `!` command;
  the caveat not drawn (but sent to the model); images in a prompt; skill
  text not drawn; the turn-finished line ("done ..."); the usage-limit
  message; alerts on a sticky line above the input, including "Update
  installed".
- **Seen, per the study, without a matched screenshot:** your prompt (a
  chevron row), Claude's reply (a bullet), the task-finished green-dot row,
  an Agent tool call "Backgrounded agent", "Waiting for 1 background agent to
  finish", a recap ("※ recap"), the usage-limit dot lines, the continue
  nudge not drawn, a slash command's chevron row.
- **From code only, never seen:** thinking (italic, dim); the compaction
  summary ("Compact summary (ctrl+o to expand)"); the interrupt marker
  ("Interrupted · What should Claude do instead?"); other API-error text (a
  red row); the live usage-limit status.
- **Model-side, not screen:** what a `!` command sends to the model.
- The single line above the input is reserved for temporary messages (usage
  limits, update notices, key hints); they don't appear in the transcript.
- The caveat's wording changed between versions, so what is published has to
  be the stored text, not a reconstruction.
- With verbose off, Claude Code collapses messages; tower should do the same
  by default.
- Examples to look at: a transcript-only notice in session 6dc93a22 line
  2177; a usage-limit run in 8687f5f6 lines 1078 to 1089; "No response
  requested." in 8b117118 line 59.

**Resume comparison.** Not about resume.

**Used by.** [publishing.md](../participant/publishing.md), Display.
