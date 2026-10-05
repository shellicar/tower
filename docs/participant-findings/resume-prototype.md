# Resuming from what was published: the prototype

**Question.** Does a resume from what was published send the same API
request as a resume from Claude Code's own record, and if not, which
published data explains each difference?

**Method.**
- The real participant and real Claude Code on the test broker (through the
  broker-run recipe); every message on `conv.v2.<id>.>` recorded live.
- With `PROOF_PUBLISH_ENTRIES=1`, every main-chain entry with a uuid was
  also published raw on a new leaf `conv.v2.<id>.changes.entry`.
- `PublishedLoader.ts` rebuilt `load()` three ways: `raw`; `messages` with
  named fields added back one at a time; `file` (Claude Code's own record
  handed back line for line, as a control). `PublishedHistory.ts` read
  `changes` from JetStream.
- Each method ran in its own process, with the local record deleted first for
  every method except `local` (the reference). The final run read a
  republished copy on a fresh broker. The working directory was outside any
  git repo. Requests captured with `OTEL_LOG_RAW_API_BODIES`.
- Seven shapes: text, thinking, a tool call, parallel tool calls, a mid-turn
  typed message, a background task finishing, one `/compact`.

**Versions.** Claude Code 2.1.285 (the billing header shows
`cc_version=2.1.285.01a`), Agent SDK 0.3.285, model claude-sonnet-5-5.

**Runs.** r2 (text only), r3 (all shapes), r4 (the evidence, `proof/out/r4/`:
`matrix.md`, `report.md`, `report.json`, `usage.md`, and each method's probe
request). One live conversation per shape; `local` ran 3 times per shape (up
to 8 on text and compact); `file` up to 9 on text and compact. Field
ablations on all shapes. Branch `proof/resume-from-published`, 6 commits
(57bb48c to a053e52), unmerged by design.

**Found.**
- After normalising four values (the device id, the private home path, the
  prompt id in the billing header, and the config dir path), six shapes sent
  the same request as `local`; `/compact` didn't. Without that
  normalisation no shape is identical: see below.
- Fields that made the difference: `message.id` (gives
  `diagnostics.previous_message_id`, and groups parallel pieces);
  `requestId` (`cc_prev_req`); `turnPosition`; `message.model` (without it the
  thinking block is dropped); the tool-result fields (the classifier
  context); `queued_command`; `wireToolInputs` (original key order); `origin`
  and string content on the task notification; removing any attachment kind
  except `credential_org` changed the messages.
- Needed beyond what is published: `message.id`, `requestId`,
  `turnPosition`, `message.model`, `wireToolInputs`, `toolUseResult`,
  `serverClassifierContext`, `sourceToolAssistantUUID`, `origin`,
  `queueSkipAttachments`, whether a user entry's content was a string, the
  whole raw `system` entry, and every non-message entry.
- Not needed in these runs: `parentUuid` (order was never varied),
  `timestamp`, `promptId`, `entrypoint`, `version`, `gitBranch`, assistant
  usage and stop reason, `resumeSessionAt` (changed nothing).
- Cache: with the full field set, five of the six non-compact shapes read
  exactly the same tokens from cache as `local`; a missing field lowers the
  read. Cache creation was about 850 to 950 tokens higher than `local` in
  each shape (not investigated).
- **Why no store resume is identical (a follow-up read of the SDK and the r4
  requests):** when a resume has a session store and `load()` returns
  entries, the SDK makes `<tmpdir>/claude-resume-<uuid>`, writes the entries
  there, copies credentials and settings, and sets `CLAUDE_CONFIG_DIR` to it.
  Claude Code renders that path into a generated sandbox block, the
  safeguards block, and (after `/compact`) the memory directory in the system
  prompt. The uuid is random, so even two store resumes can't match. The
  participant's private home is random per process too, so two local resumes
  differ there. No SDK option sets the temp dir.
- Limits: one model, one version, one conversation per shape; attachment
  exclusion tested on text only; images and documents untested; the system
  prompt flipped between two texts in some resumes.
- Seen, not changed: `Presence` decides resume from the local record, so with
  no record it starts a new session; the say precondition reads the local
  record's tip; subagent entries aren't published.
- Choices the prototype made that nobody ruled on: a new leaf
  `changes.entry` carrying the raw entry (with `ts`, so towerd would count it
  as activity); a new dependency `@nats-io/jetstream`; the stream name
  hard-coded; a say accepted mid-turn; `PROOF_*` variables read at call
  sites; `resumeSessionAt` set; the first entry kept when a uuid repeats;
  synthesised `informational` system entries; `/compact` sent as text
  blocks; a per-field loader; and, unlisted, comparing only after
  normalisation.

**Resume comparison.** A resume from the published store against a resume
from Claude Code's own record, both after resuming: the comparison that
counts now. Under "identical", no shape passes; with the four values
normalised, six of seven do.

**Used by.** [resume.md](../participant/resume.md).
