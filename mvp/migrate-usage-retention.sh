#!/bin/sh
# Move conv.v2.*.telemetry.usage from the diagnostic stream (90d retention) to
# the audit stream (unlimited) — usage stays telemetry (the conversation
# functions fine without publishing it, nats-spec's own test for the plane),
# but its RETENTION need is audit-grade: it is the only record of what a
# conversation cost, and diagnostic's 90-day cap silently deletes it.
#
# This corrects the same category error migrate-stream-retention.sh made for
# usage specifically: that script (rightly) treated turn/tool/pulse telemetry
# as safe to lose after 90 days, and (wrongly) lumped usage in with it. See
# docs/spec/nats-spec.md's Telemetry section and the 19 Jul incident it wrote
# up (a conversation's cost history was purged when that script ran, only
# recovered because the pre-purge backup happened to still exist).
#
# Dry run by default: prints the plan, touches nothing. Pass --apply to
# actually run it. NATS_URL overrides the default local broker.
#
# Order, and why:
#   1. Refuse to run --apply while bridge or towerd are running. Both publish
#      or read the subject being moved; running this live risks the exact
#      "telemetry landed in the gap between streams" loss this script exists
#      to avoid causing again. Quiesce first, migrate, then restart.
#   2. Back up conv-diagnostic in full before touching it — the backup is
#      what saved the 19 Jul data; there is no reason to run this once without
#      the same insurance.
#   3. Remove conv.v2.*.telemetry.usage from conv-diagnostic's subjects.
#      JetStream refuses overlapping subjects between streams, so this MUST
#      happen before conv-approval claims it. Removing it from the filter does
#      NOT delete the messages already stored under it (same as the original
#      script's own note) — they stay readable until step 5 purges them.
#   4. Add conv.v2.*.telemetry.usage to conv-approval's subjects. Steps 3 and 4
#      run back to back — the gap between them is where a live usage event
#      would be dropped by both streams, which is exactly why step 1 insists
#      nothing is running.
#   5. Copy every usage message conv-diagnostic already holds into
#      conv-approval (copy-usage-telemetry.mjs), verbatim, same subject — this
#      is what step 3/4 alone would NOT do: narrowing a stream's subjects only
#      changes what it captures going forward, not what it already has stored.
#   6. Purge conv-diagnostic of the now-migrated usage messages, once the copy
#      count is confirmed to match. Without this, conv-diagnostic keeps a
#      stale duplicate copy forever — not data loss, but a second source of
#      truth nobody should read from.
#
# A required separate follow-up, not done here: bridge/towerd's own
# AUDIT_SUBJECTS / DIAGNOSTIC_SUBJECTS constants (mvp/crates/towerd/src/
# ingest.rs) need to move `conv.v2.*.telemetry.usage` the same way, and both
# need rebuilding + restarting — otherwise towerd's audit consumer will not
# even ask for the subject it now needs, and the live usage view stops
# updating until that happens.

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
  echo "stop it first — steps 3/4 move the subject out from under its live ingest consumer" >&2
  exit 1
fi
if [ "$APPLY" = "1" ] && pgrep -f 'target/debug/bridge\|target/release/bridge' >/dev/null 2>&1; then
  echo "refusing to run: bridge appears to be running (pgrep -f bridge)" >&2
  echo "stop it first — a live turn publishing usage during steps 3/4 is exactly the loss window this script exists to close" >&2
  exit 1
fi

run() {
  if [ "$APPLY" = "1" ]; then
    echo "+ $*"
    "$@"
  else
    echo "(dry run) $*"
  fi
}

echo "# usage retention migration — server: $NATS_URL"
if [ "$APPLY" = "0" ]; then
  echo "# Dry run: printing the plan only. Re-run with --apply to execute."
fi
echo

TS="$(date +%Y%m%dT%H%M%S)"
STREAM_BACKUP_DIR="./stream-backups/conv-diagnostic-$TS"
echo "## 1. Back up conv-diagnostic to $STREAM_BACKUP_DIR"
if [ "$APPLY" = "1" ]; then
  echo "+ nats --server $NATS_URL stream backup conv-diagnostic $STREAM_BACKUP_DIR"
  mkdir -p "$STREAM_BACKUP_DIR"
  nats --server "$NATS_URL" stream backup conv-diagnostic "$STREAM_BACKUP_DIR"
  echo "backup written to $STREAM_BACKUP_DIR — restore with:"
  echo "  nats --server $NATS_URL stream restore conv-diagnostic $STREAM_BACKUP_DIR"
else
  echo "(dry run) nats --server $NATS_URL stream backup conv-diagnostic $STREAM_BACKUP_DIR"
fi
echo

DIAGNOSTIC_REMAINING='conv.v1.*.telemetry,conv.v2.*.telemetry.turn.started,conv.v2.*.telemetry.turn.ended,conv.v2.*.telemetry.turn.aborted,conv.v2.*.telemetry.turn.cancelled,conv.v2.*.telemetry.tool.use,agent.v1.*.telemetry.attached,agent.v1.*.telemetry.detached'
echo "## 2. Narrow conv-diagnostic's subjects to exclude conv.v2.*.telemetry.usage"
echo "##    (must happen before conv-approval can claim it — no overlapping subjects)"
run nats --server "$NATS_URL" stream edit conv-diagnostic \
  --subjects "$DIAGNOSTIC_REMAINING" \
  -f
echo

AUDIT_WITH_USAGE='conv.v1.*.changes,conv.v2.*.changes.>,approval.v1.*.lifecycle,conv.v2.*.telemetry.usage'
echo "## 3. Add conv.v2.*.telemetry.usage to conv-approval's subjects"
run nats --server "$NATS_URL" stream edit conv-approval \
  --subjects "$AUDIT_WITH_USAGE" \
  -f
echo

echo "## 4. Count conv-diagnostic's already-stored usage messages, to know how many to copy"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USAGE_COUNT=0
if [ "$APPLY" = "1" ]; then
  USAGE_COUNT="$(nats --server "$NATS_URL" stream subjects conv-diagnostic 'conv.v2.*.telemetry.usage' -j \
    | python3 -c 'import json,sys; print(sum(json.load(sys.stdin).values()))')"
  echo "conv-diagnostic holds $USAGE_COUNT conv.v2.*.telemetry.usage messages, still readable after the narrow above"
else
  echo "(dry run) would count conv-diagnostic's stored conv.v2.*.telemetry.usage messages here"
fi
echo

echo "## 5. Copy those messages into conv-approval"
if [ "$APPLY" = "1" ]; then
  run node "$SCRIPT_DIR/copy-usage-telemetry.mjs" conv-diagnostic "$USAGE_COUNT"
else
  echo "(dry run) node $SCRIPT_DIR/copy-usage-telemetry.mjs conv-diagnostic <count>"
fi
echo

echo "## 6. Once the copy is verified, purge conv-diagnostic of the migrated usage messages"
run nats --server "$NATS_URL" stream purge conv-diagnostic --subject 'conv.v2.*.telemetry.usage' -f
echo

if [ "$APPLY" = "0" ]; then
  echo "# Nothing was changed. Re-run with --apply to execute the plan above."
else
  echo "# Broker-side move done. Remaining, by hand:"
  echo "#  - update mvp/crates/towerd/src/ingest.rs's AUDIT_SUBJECTS/DIAGNOSTIC_SUBJECTS to match"
  echo "#  - update this repo's copy of migrate-stream-retention.sh's own subject lists to match"
  echo "#  - rebuild and restart towerd and bridge"
fi
