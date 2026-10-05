# When `reloadSkills()` can be called

**Question.** When can the participant call `reloadSkills()`, and what does
it do?

**Method.** Code reading.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Found.**
- `reloadSkills()` clears Claude Code's record of the skills already shown,
  rescans, and emits `commands_changed`; the model gets the whole list at the
  next context point.
- Removals are never announced to the model: the listing is add-only, and
  each reload re-sends the full list.
- It runs immediately, mid-turn included, and blocks Claude Code's input loop
  while awaited (up to 30 s with claude.ai skill sync).
- A new skills directory isn't watched; it must exist before Claude Code
  starts.
- Claude's inference, not decided: the participant needn't call
  `reloadSkills()`, since Claude Code watches the directory itself.

**Resume comparison.** Not about resume.

**Used by.** [skills.md](../participant/skills.md).
