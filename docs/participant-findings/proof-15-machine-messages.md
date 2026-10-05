# Proof 15: which messages Claude Code writes itself

**Question.** Which messages Claude Code writes itself, how they are flagged,
and which reach the model. (The working understanding: `user` is the client's
side of the API, `assistant` the model's.)

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 4 scenarios, on Sonnet 5. Branch `proof-15-machine-messages`
(37d0176).

**Found.**
- No single flag marks "Claude Code wrote this".
- Unflagged ones that reach the model: interrupt markers, `/model` and
  `/compact` records, skill slash-command records, compaction summaries.
  Claude Code itself recognises its markers by 8 fixed text prefixes.
- Misleading flags: `isVisibleInTranscriptOnly`, `queueTranscriptOnly`, and
  `toolDenialKind: "user-rejected"` from an interrupt.
- Host prompts carry `promptSource: "sdk"`; mid-turn messages become
  `queued_command`; `origin` is never stamped by Claude Code (the SDK says a
  keyboard host "must stamp {kind:'human'}").
- `isApiErrorMessage` entries and `<synthetic>` entries never reach the
  model, but "No response requested." would.
- Attachments with `rendered` reach the model.

**Resume comparison.** Not about resume.

**Used by.** [publishing.md](../participant/publishing.md) (roles, `from`,
the classifier). See also [what the model sees](what-the-model-sees.md).
