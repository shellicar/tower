#!/bin/sh
# Split conv-approval's single retention policy into the three categories
# decided in review: audit (unlimited), diagnostic (90d), ephemeral (3d).
# See docs/mvp/tower-v1-design.md / the session's own retention-category
# discussion — audit is the committal record (conv changes, approval
# lifecycle); diagnostic is telemetry with real debugging/cost value (turn/
# tool/usage events, agent attach/detach); ephemeral is pure liveness noise
# and in-progress streaming, superseded the instant it lands (deltas,
# heartbeats, agent ready/pulse).
#
# Dry run by default: prints the plan, touches nothing. Pass --apply to
# actually run it. NATS_URL overrides the default local broker.
#
# Order matters and is deliberately conservative:
#   1. Narrow conv-approval's own subjects to audit-only FIRST. JetStream
#      refuses to create a stream whose subjects overlap an existing one —
#      conv-approval still claims every subject until this runs, so the new
#      streams cannot be created before it (this bit a live run: creating
#      conv-diagnostic first failed outright with "subjects overlap with an
#      existing stream", nothing was created or changed). This does open a
#      brief window — the moment between this step and step 2/3 — where
#      diagnostic/ephemeral traffic is published but no stream captures it;
#      accepted as a few possibly-lost low-value events, not a correctness
#      problem.
#   2. Create conv-diagnostic and conv-ephemeral fresh (additive, reversible
#      — new empty streams, no existing data touched). No backfill: nothing
#      in either category was going to outlive 30 days under the old
#      single-stream rule anyway, so there is nothing meaningful to migrate.
#   3. Purge conv-approval of the diagnostic/ephemeral messages it already
#      holds from before the narrowing — narrowing a stream's subjects does
#      not retroactively delete what is already stored under them, so this
#      step is what actually makes conv-approval audit-only end to end.
#   4. Only now set conv-approval's max_age to unlimited (0) — doing this
#      before the purge would make the leftover diagnostic/ephemeral
#      messages unlimited too, by accident.
#
# NOT done here, a required separate follow-up: towerd's ingest currently
# reads every category through one filtered consumer on one stream. Once
# diagnostic/ephemeral traffic stops flowing into conv-approval, ingest needs
# its own change to consume all three streams (three consumers, three
# cursors) or usage/liveness folding goes dark silently. This script is the
# broker-side half only.

set -eu

NATS_URL="${NATS_URL:-nats://127.0.0.1:4222}"
APPLY=0
for arg in "$@"; do
  if [ "$arg" = "--apply" ]; then
    APPLY=1
  fi
done

if [ "$APPLY" = "1" ] && pgrep -f 'towerd' >/dev/null 2>&1; then
  echo "refusing to run: towerd appears to be running (pgrep -f towerd)" >&2
  echo "stop it first — step 3 narrows conv-approval's subjects out from under its live ingest consumer" >&2
  exit 1
fi

AUDIT_SUBJECTS='conv.v1.*.changes,conv.v2.*.changes.>,approval.v1.*.lifecycle'
DIAGNOSTIC_SUBJECTS='conv.v1.*.telemetry,conv.v2.*.telemetry.>,agent.v1.*.telemetry.attached,agent.v1.*.telemetry.detached'
EPHEMERAL_SUBJECTS='conv.v1.*.deltas,conv.v2.*.deltas,approval.v1.*.telemetry,agent.v1.*.telemetry.ready,agent.v1.*.telemetry.pulse'

run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    "$@"
  else
    echo "(dry run) $*"
  fi
}

echo "# Stream retention migration — server: $NATS_URL"
if [ "$APPLY" = "0" ]; then
  echo "# Dry run: printing the plan only. Re-run with --apply to execute."
fi
echo

echo "## 1. Narrow conv-approval's subjects to audit-only (must happen before"
echo "##    the new streams are created — JetStream refuses overlapping subjects)"
run nats --server "$NATS_URL" stream edit conv-approval \
  --subjects "$AUDIT_SUBJECTS" \
  --retention limits --discard old -f
echo

echo "## 2. Create conv-diagnostic (max_age 90d) if it does not exist"
if nats --server "$NATS_URL" stream info conv-diagnostic >/dev/null 2>&1; then
  echo "conv-diagnostic already exists, skipping create"
else
  run nats --server "$NATS_URL" stream add conv-diagnostic \
    --subjects "$DIAGNOSTIC_SUBJECTS" \
    --storage file --retention limits --max-age 90d --discard old --defaults
fi
echo

echo "## 3. Create conv-ephemeral (max_age 3d) if it does not exist"
if nats --server "$NATS_URL" stream info conv-ephemeral >/dev/null 2>&1; then
  echo "conv-ephemeral already exists, skipping create"
else
  run nats --server "$NATS_URL" stream add conv-ephemeral \
    --subjects "$EPHEMERAL_SUBJECTS" \
    --storage file --retention limits --max-age 3d --discard old --defaults
fi
echo

echo "## 4. Purge conv-approval of the now-out-of-scope diagnostic/ephemeral subjects"
for subject in $(echo "$DIAGNOSTIC_SUBJECTS,$EPHEMERAL_SUBJECTS" | tr ',' ' '); do
  run nats --server "$NATS_URL" stream purge conv-approval --subject "$subject" -f
done
echo

echo "## 5. Set conv-approval's max_age to unlimited"
run nats --server "$NATS_URL" stream edit conv-approval --max-age 0 -f
echo

if [ "$APPLY" = "0" ]; then
  echo "# Nothing was changed. Re-run with --apply to execute the plan above."
fi
