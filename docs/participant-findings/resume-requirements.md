# What a resume from published messages needs

**Question.** What a resume from published messages needs, compiled from the
proofs and the participant's code, against what is published.

**Method.** An agent compiled R1 to R22 from the proof results (proofs 2, 8,
9, 13, 14, 15, 16, 20, 23, 24 and the minimum entries proof) and read the
epic's code. None of it ran against the real participant's published
messages.

**Versions.** The proofs ran Claude Code 2.1.282 on an SDK-driven harness
(SDK 0.3.282), mostly on Sonnet 5.

**Found.** Each requirement, how well it is proven, and whether it was met on
3 Oct:

| | Requirement | Proven | Met |
|---|---|---|---|
| R1 | User and assistant entries as entries (`type`, role, content) | yes | partly (no `type`; files as references) |
| R2 | `uuid` per entry (without it only the last message comes back) | yes | yes |
| R3 | The `parentUuid` chain | yes | no |
| R4 | `timestamp` present (without it "No conversation found") | presence only | no (`ts` is publish time) |
| R5 | `message.model` on assistant entries with thinking (else thinking dropped) | yes | no |
| R6 | `message.id` shared by one response's pieces (entry grain loses a parallel tool result) | yes | partly (`turnId`, no `message.id`) |
| R7 | Response ids (`msg_...`, `requestId`) for an identical request | yes | no |
| R8 | Thinking with its signature | inferred | yes |
| R9 | Typed `attachment` entries (six types in one seed) | on one seed | no |
| R10 | Attachments' `rendered` | yes | no |
| R11 | The minimum set (user, assistant, environment, model, session_context, date, mcp_instructions_delta, remote_session_change, agent_listing_delta, queued_command, compact_boundary, total_tokens_reminder) | yes (153 Sonnet pickups; four models) | no |
| R12 | Even an empty `session_context` | yes | no |
| R13 | `deferred_tools_delta` plus `prompt_snapshot` or `deferred_tools_record` with connectors on | on 4 pickups, model-dependent | no |
| R14 | `compact_boundary` plus the entries its metadata names | 2 pickups | no |
| R15 | `queued_command` | 1 pickup | no |
| R16 | `isMeta` user entries | the cwd notice; others inferred | no |
| R17 | Order | only in published order | partly |
| R18 | `resumeSessionAt` at the last non-system entry from `load()` (112 of 112) | yes | no (`load()` returns null) |
| R19 | Hold a thinking-only entry until a sibling, drop it at `result` | yes | no |
| R20 | API-error entries (needed on Haiku without `resumeSessionAt`; can go with it) | yes | published |
| R21 | A complete store at `result` | yes | partly (the outbox now delivers) |
| R22 | Model-dependent folding | yes | no |

- Droppable: off-chain kinds, `credential_org`, `system:api_error`,
  `system:stop_hook_summary`, and `prompt_snapshot` on Sonnet except at
  compaction. Not droppable: the rendering attachments, `queued_command`,
  `compact_boundary`, `deferred_tools_*` with connectors, and preserved
  entries. Never covered: `turn_duration`, `away_summary`, `informational`,
  `local_command`.
- Never tested: shuffled order, `logicalParentUuid`, request-identity fields,
  the original `timestamp` value, a resume across versions, SDK against
  interactive entries, image bytes, values over 1 MB, subagent entries, more
  attachment types, compaction on other models.
- Extra fields on `changes.message` are lawful under add-only rules and are
  dropped silently by wire, towerd, bridge's adopt and helm; a new `changes.`
  leaf is a closed-set question, and towerd treats any event with `ts` as
  activity.

**Resume comparison.** Mixed and not labelled per requirement. R9 and R14
rest on store-against-record resumes (the comparison that counts now); R11,
R18 and R20 rest on comparisons against the live next request.

**Used by.** [resume.md](../participant/resume.md). See also the
[resume prototype](resume-prototype.md), which tested many of these live.
