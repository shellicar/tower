# Extras: a study of two designs

**Question.** For each kind of "extra" message the model or the user sees:
how it is sent to the API, whether it goes to the model (its visibility),
how it could be published, and how hard that is. Two harnesses have their own
message formats; the aim is to carry what both need without a generic format
that loses information. Two designs to engage with, nothing recommended.

**Method.** An agent's design study over 21 kinds, then two prototypes built
from it, one per design.

**Versions.** Not recorded.

**Found.**
- What the participant published (as of 3 Oct, before the reply-author
  change): every `system` entry as role `system` with its subtype and fields
  lost, so a turn-finished line publishes empty content.
- Towerd reads `changes.message` into exactly `ts, id, queryId, turnId, role,
  from, content` (`crates/wire/src/conv.rs`). An added envelope field never
  reaches a frontend without towerd, WS spec and frontend changes; only
  `content` passes through verbatim, and unknown block types show folded.
- Towerd marks unread for any `assistant` message, so synthetic API errors
  and "No response requested." mint unread. Ordering is by `ts` with no
  tie-break.
- `isMeta` is origin, not visibility, so either design needs a per-kind
  classifier.
- The SDK stream carries more than the participant reads:
  `system/notification` (key, text, priority, color, timeout_ms, mirroring
  the terminal's notification queue), `rate_limit_event`, `api_retry`. The
  first is the candidate alert channel; whether alerts fire there headless
  isn't established.
- Which kinds occur with no terminal: hand-back, task notice, interrupt
  marker, compaction, reminders, turn-finished line, "No response
  requested.", API errors, thinking. Not today: images, mid-turn messages,
  `!`. Not established: idle nudge, date change, continue nudge, recap,
  usage-limit lines, alerts.
- Needs common to both designs: the extra's own time; visibility unknown or
  late (thinking); visibility changing after compaction; three carriers
  (envelope fields, a flag inside a content block, a new leaf); message or
  block as the unit; order and `ts` ties; the classifier.
- **Design A (generic):** `audience {model, user}`, `userContent`, `at`,
  `scope` on `changes.message`. **Design B (typed):** A plus `kind` and
  `fields`. Per-kind examples, effort, breakage and the bridge counterpart
  for all 21 kinds are in the study.
- Prototypes: `proto/extras-generic` (towerd migration 16 adding four nullable
  columns, Svelte, `scripts/extras-check.sh`) and `proto/extras-typed`
  (migration 16 adding one `extras` JSON column, `scripts/publish-extras.ts`).
  Neither touches Leptos; neither was looked at in a browser; the two
  migrations differ, so each needs its own `TOWER_DB`. Their briefs left four
  things for the builders to pick: the role for hidden or user-only assistant
  entries, `from` for hand-backs, the carrier for the new fields, and the
  default for an unclassified entry.
- Code issues noticed: a reworded interrupt marker would publish as a prompt
  carrying the say's `from`; a slash-command record publishes as a prompt;
  a compaction's preserved-message list names uuids the store never got.

**Resume comparison.** Not about resume.

**Used by.** [publishing.md](../participant/publishing.md), Extras.
