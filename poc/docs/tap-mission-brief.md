# Tap mission brief — stage 1 (See)

The SC's direction for the mission that builds the NATS event tap in the node CLI
(`~/repos/@shellicar/claude-cli`). This is the input to the planning pipeline — the
intent conversation starts from here. It is not the mission, and it is not a second
spec: where this document and the spec disagree, the spec wins.

## Goal

From `roadmap.md` stage 1: the ~110-session fleet becomes visible — "mission X quiet
2 hours." Retires window-hopping as monitoring.

## Contract

Three committed docs in `~/repos/@shellicar/tower/docs` are the contract. The spec
is authoritative; nothing here restates it.

- `tap-spec.md` — the wire contract: glossary, subjects and versioning, events,
  configuration, tolerance rules, the worked example.
- `tap-testing.md` — how the implementation proves it carries the contract; the
  done-when points here.
- `roadmap.md` — stage 1's scope and the principles the stages keep.

## Vocabulary

"Session" is retired as overloaded. The terms are **conversation**, **run**,
**label**, **location** — defined in the spec's glossary. The mission uses them.

## Deliverables

- The tap in the node CLI: publishes the spec's v1 events on the conversation's
  events subject. Pure-JS NATS client — deliberately no new native dependencies
  (roadmap stage 1). Configuration per the spec: `tap { enabled, url }`; disabled
  is the default and has zero effect; enabled fails fast at startup.
- The conformance artifacts from `tap-testing.md`: `spec/tap.v1.schema.json` and
  `spec/fixtures/crash-resume.jsonl` (the spec's worked example promoted to a
  file), with producer conformance running in CI.
- A NATS subscribe script showing a real session's events — the live demonstration
  that the tap publishes what the spec says.

## Exclusions — ruled, not omissions

- No text deltas: monitoring, not mirroring (spec).
- No `phase_done`: reserved for stage 2, orchestration — the SC ruled it out of
  phase 1 (spec).
- The dashboard mission is deliberately held until the tap lands — the tap is the
  riskier half, and a spec correction is cheaper before the second consumer
  exists. Do not build against the dashboard or assume it.

## Escalation

Questions of spec intent go back to the SC. A gap the contract docs do not answer
is a question, not a space to fill.
