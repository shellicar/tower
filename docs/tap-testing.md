# Tap testing — v1

How implementations of `tap-spec.md` prove they comply: write the compliance check
once, test every implementation with the spec's fixture. The tap and the dashboard
build against the spec and never talk to each other; this page is how each proves,
alone, that it still speaks it.

## The problem

The spec's add-only discipline requires consumers to be lenient: skip unknown event
types, ignore unknown fields, tolerate unknown enum values. That leniency has a
cost: it hides mistakes. A producer that writes `stop_reason` where the spec says
`stopReason` breaks nothing visibly — consumers ignore what they don't recognise,
so the field reads as absent and a dashboard column goes quietly blank. Nothing
fails, so nothing gets fixed.

The contract itself forbids strictness at runtime. So strictness lives in tests,
where it costs nothing.

"It works" is not evidence of compliance. Leniency conceals divergence — that is
what leniency is for.

## The kit

Two artifacts, both data, living next to the spec:

- `spec/tap.v1.schema.json` — the event shapes, as JSON Schema.
- `spec/fixtures/crash-resume.jsonl` — the spec's worked example, as a file.

The fixture is not a second source of truth that could disagree with the spec — it
is the worked example, promoted from prose. When the example changes, both change
in the same commit.

## Producer tests

For the node tap, the stage-4 agent, and any producer anyone writes. In the
producer's own repo:

1. Drive the scenario: a run, a turn, a tool use with its approval, a crash, a
   resume.
2. Capture what was published.
3. Normalise the volatile fields: `ts`, `pid`, run and conversation ids.
4. Assert every event validates against the schema — this is what catches a wrong
   field name mechanically.
5. Assert the captured sequence contains the fixture's events, in order. Extras
   are allowed.

"Extras allowed" is add-only honoured in the test: a producer emitting a new
optional event still passes; one that misshapes an existing event fails — in the
repo that caused it, the day it was caused.

## Consumer tests

For the dashboard and any other client. In the consumer's own repo:

1. Feed the fixture in as the event stream.
2. Assert the projection matches the spec's recommended projection: one panel,
   continuity unbroken across the crash; the first run stale on heartbeat silence;
   its pending approval voided with it.

The recommended-projection section becomes assertions instead of advice —
independent consumers projecting consistently is checked, not hoped.

## Third parties

A stranger's implementation can't be put in this repo's CI, and doesn't need to
be. The kit is self-serve: validate against the schema, replay the fixture, check
yourself before you ship. The blast radius makes self-serve sufficient — a bad
consumer breaks only its own view; a bad producer pollutes only its own
conversations' panels. The subject tree contains the damage.

## What this does not claim

These tests prove agreement with the spec's example — nothing more. If the
contract itself is wrong, no test here can see it; only use can. The integration
test is a live run, and it stays the ground truth: tests pin agreement; reality is
observed by running.
