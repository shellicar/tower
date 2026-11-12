# Proof 8: where a resumable conversation can live

**Question.** Can a conversation resume from a file store, a NATS-only store
and a hybrid, and what must each entry carry?

**Method.** `proofs/resume-store.mts`, on the test broker (31416), adding
`@nats-io/jetstream` 3.4.0. Each run's `summary.txt` compares the first
request after the resume, message by message, against the context the seed
conversation's model had.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282 (29 of 33 runs logged
it).

**Runs.** 33, on Sonnet 5. Branch `proof-8-resume-store` (819cf69).

**Found.**
- All three resumed correctly, twice each. The hybrid resumed from NATS alone
  (as a second machine would).
- Only user and assistant entries give the same history; Claude Code re-sends
  its reminders. Relinking isn't needed.
- Each entry needs `type`; `uuid` and `parentUuid` (without them only the last
  message comes back, silently); `timestamp` (without it, "No conversation
  found"); `message.role` and `message.content`; and `message.model` on
  assistant entries with thinking (without it thinking is dropped silently).
- Entries rebuilt with new uuids sent the same history.
- A stream `PROOF8` was left on the test broker.

**Resume comparison.** The resumed request against the live seed's context
(before against after), and on history content only, not full request
identity. Not the comparison that counts now (see
[resume.md](../participant/resume.md)).
