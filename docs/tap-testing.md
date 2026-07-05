# Tap testing strategy

How implementations verify themselves against `tap-spec.md`. This is testing, not
contract: the spec says what the wire carries; this says how the missions prove they
carry it. Both mission briefs point here for their done-when.

## The problem

The spec's add-only discipline requires consumers to be lenient: skip unknown event
types, ignore unknown fields, tolerate unknown enum values. That leniency has a
cost: it hides mistakes. A producer that writes `stop_reason` where the spec says
`stopReason` breaks nothing visibly — consumers ignore what they don't recognise,
so the field reads as absent and a dashboard column goes quietly blank. Nothing
fails, so nothing gets fixed. Leniency conceals divergence; that is what leniency
is for. The contract forbids strictness at runtime, so strictness lives in tests,
where it costs nothing.

## Two artifacts, both data

- `spec/tap.v1.schema.json` — the event shapes as JSON Schema.
- `spec/fixtures/crash-resume.jsonl` — the spec's worked example as a loadable file.

The schema must not encode a closed world: `additionalProperties` stays permissive,
unknown event types are skipped by the harness rather than failed, known enum values
validate without rejecting others. Otherwise the tests enforce exactly the
closed-enum bug the spec forbids. The tolerance rules apply to test harnesses too.

## Conformance, per repo, in CI

Each implementation checks itself against the artifacts alone — no cross-repo
dependency, and a later implementation arrives with the same bar to clear.

- **Producers** (the node tap; later the Rust agent): drive a scripted session,
  capture what got published, normalise the volatile fields (ts, pid, run ids),
  then every event validates against the schema, and the captured sequence contains
  the fixture's required events as a per-run subsequence, extras allowed. Extras
  allowed is add-only honoured in the test: new optional events pass; a misshaped
  old one fails.
- **Consumers** (the dashboard; anything else): feed the fixture in, assert the
  projection from the spec's recommended-projection rules: one panel per
  conversation, timeline unbroken across the crash, pending approval voided when
  the run goes stale.

Runtime never checks conformance — the spec's tolerance rules forbid it, or every
addition becomes a breaking change. Strictness lives in CI, where it costs nothing.

## Integration, one check

Real tap, real broker, real dashboard fold: a scripted CLI session against a
JetStream-enabled broker, asserting the dashboard's projection at the end. One
compose file. This proves interop as a fact rather than an inference, and catches
what no schema can: ordering across events, timing, meaning.

Integration only proves the pair that ran, on the paths driven — the POC's
closed-enum defect passed integration because the fake model never emitted the
unknown value. Conformance covers what the scenario doesn't drive; integration
covers what shapes can't say. Neither substitutes for the other.

## Third parties

A stranger's implementation can't be put in this repo's CI, and doesn't need to be.
The kit is self-serve: validate against the schema, replay the fixture, check
yourself before you ship. The blast radius makes self-serve sufficient — a bad
consumer breaks only its own view; a bad producer pollutes only its own
conversations' panels. The subject tree contains the damage.

## The discipline that keeps both alive

When integration (or the field) finds a bug conformance missed, the fix lands
twice: in the code and in the schema/fixture, same commit. That is how the fixture
grows with the spec instead of going stale, and how each escaped bug class is
caught mechanically the next time.

## What this does not do

None of this checks meaning. A schema validates that `stopReason` is a string,
never that the projection rules were understood. Semantic drift stays a human
problem, caught by review — the same reviews that found the real defects in the
POC and in these documents. The tests shrink the mechanical drift class to one
reviewable artifact; the reading is still the floor.
