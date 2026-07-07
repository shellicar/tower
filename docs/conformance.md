# Conformance

How implementations prove they carry the specs — `nats-spec.md`,
`conversation-spec.md`, `approval-spec.md`. This is testing, not contract: the
specs say what the wire carries; this says how an implementation proves it.
The fixture set lives in `scenarios.md`.

## The problem

The add-only discipline requires consumers to be lenient: skip unknown types,
ignore unknown fields, tolerate unknown enum values. That leniency has a cost:
it hides mistakes. A producer that writes `stop_reason` where the spec says
`stopReason` breaks nothing visibly — consumers ignore what they don't
recognise, so the field reads as absent and a dashboard column goes quietly
blank. Nothing fails, so nothing gets fixed. Leniency conceals divergence;
that is what leniency is for. The contract forbids strictness at runtime, so
strictness lives in tests, where it costs nothing.

## Artifacts, all data

- Per-concern JSON Schemas: the message shapes of `conv.v1` and `approval.v1`.
- Fixture files: the scenarios of `scenarios.md` as loadable captures,
  authored during implementation and kept alive by fix-lands-twice.

Tower authors the artifacts; each implementation carries **verbatim copies**
— colocation, not coupling. No cross-repo dependency until the specs are
stable. Central authorship keeps drift in one reviewable place: if the
artifacts are wrong, every implementation is wrong *together*, which preserves
interop while the fix lands once.

The schemas must not encode a closed world: `additionalProperties` stays
permissive, unknown types are skipped by harnesses rather than failed, known
enum values validate without rejecting others. Otherwise the tests enforce
exactly the closed-world bug the specs forbid. The tolerance rules apply to
test harnesses too.

## Conformance, per repo, in CI

Each implementation checks itself against the artifacts alone — no cross-repo
dependency, and a later implementation arrives with the same bar to clear.
Three roles:

- **Producers**: drive a scripted session, capture what got published per
  subject, normalise the volatile fields (`ts`, and every minted id —
  `queryId`, `turnId`, `messageId`, `approvalId`), then every message
  validates against its schema and each subject's capture contains the
  fixture's required entries as a subsequence, extras allowed. Extras allowed
  is add-only honoured in the test: new optional events pass; a misshaped old
  one fails.
- **Consumers**: replay the fixtures and assert **the specs' own folds** —
  latest revision per message, the reachable set from the tip, queries grouped
  by `queryId` and closed by `end_turn`, the approval outstanding set
  (raised + pulse = pending, silence = void, settled = done).
- **Servicers**: scripted request/reply exchanges asserting the reply
  discipline — `say` accepted with an id; a stale premise rejected `stale`;
  `cancel` answered honestly (`already_complete`, `not_found`); an approval
  answered twice gets `already_settled` second; an unsupported operation is
  answered `rejected: unsupported`, because compliance is answering, not
  implementing.

Runtime never checks conformance — the tolerance rules forbid it, or every
addition becomes a breaking change. Strictness lives in CI, where it costs
nothing.

## Integration, one check

Real bridge agent, real JetStream-enabled broker, real consumer fold: a
scripted session end to end, asserting the consumer's projection at the close.
One compose file. This proves interop as a fact rather than an inference, and
catches what no schema can: per-subject ordering, the absence of cross-subject
ordering assumptions, timing, meaning.

Integration only proves the pair that ran, on the paths driven — the POC's
closed-enum defect passed integration because the fake model never emitted the
unknown value. Conformance covers what the scenario doesn't drive; integration
covers what shapes can't say. Neither substitutes for the other.

## Third parties

A stranger's implementation can't be put in this repo's CI, and doesn't need
to be. The kit is self-serve: validate against the schemas, replay the
fixtures, check yourself before you ship. The blast radius makes self-serve
sufficient — a bad consumer breaks only its own view; a bad producer pollutes
only its own entities' subjects. The subject tree contains the damage.

## The discipline that keeps it all alive

When integration (or the field) finds a bug conformance missed, the fix lands
twice: in the code and in the schema/fixture, same commit. That is how the
fixtures grow with the specs instead of going stale, and how each escaped bug
class is caught mechanically the next time.

## What this does not do

None of this checks meaning. A schema validates that `stopReason` is a string,
never that the folds were understood. Semantic drift stays a human problem,
caught by review — the same reviews that found the real defects in the POC and
in these documents. The tests shrink the mechanical drift class to reviewable
artifacts; the reading is still the floor.
