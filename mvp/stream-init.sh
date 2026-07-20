#!/bin/sh
# Converges the broker's streams to the subject layout mvp/crates/towerd/src/
# ingest.rs declares (AUDIT_SUBJECTS / DIAGNOSTIC_SUBJECTS / EPHEMERAL_SUBJECTS)
# — from ANY starting state: no streams at all (fresh install), the original
# single conv-approval stream holding everything via wide wildcards, the
# first retention split (usage still miscategorised under diagnostic), or
# already fully converged. Runs on every `docker compose up`, unattended —
# `down` does not remove the data volume, so this is the ONLY thing that ever
# needs to bring an existing broker's streams up to date; there is no
# separate migrate-*.sh to run by hand.
#
# Two phases, in this order, and the order is why this works where a
# per-subject incremental approach did not (19 Jul, twice):
#
#   1. RELEASE — every stream that already exists is narrowed to the
#      intersection of what it currently holds and what it should FINALLY
#      hold. This only ever removes subjects, never adds, so it can never
#      conflict with another stream and is always safe to do first, for
#      every stream, in any order. Critically, this is what correctly
#      handles a WIDE legacy wildcard (conv.v2.*.telemetry.> on the original
#      single conv-approval stream): the intersection with conv-approval's
#      final list drops the wildcard entirely in one edit, rather than
#      trying to peel off one leaf subject at a time — which cannot detect
#      that a leaf like conv.v2.*.telemetry.turn.started overlaps a WIDER
#      registered subject it isn't textually equal to (the bug that broke
#      this twice: `nats stream ls --subject` matches literal registered
#      subjects, not overlap).
#   2. ACQUIRE — every stream is edited (or created) to its full final
#      subject list. By the time this runs, phase 1 has already released
#      every subject from wherever it was wrongly held, so no stream is
#      still claiming anything another stream needs — the acquire can
#      never hit JetStream's "subjects overlap" error.
#
# Then BACKFILL: narrowing a stream's subjects does not delete messages
# already stored under them (JetStream keeps historical data regardless of
# current config) — for every final subject, check every OTHER stream for
# messages already stored under it, drain and republish them verbatim so
# they land in the stream that now owns the subject, verify the count, and
# only then purge the source. Nothing is ever purged before its copy is
# verified.
#
# No external backup step (unlike the human-run mvp/migrate-*.sh scripts
# this supersedes): this runs unattended with nowhere obvious to put one, so
# the safety property here is different — nothing is purged until its copy
# is confirmed, which a static backup file doesn't verify on its own.

set -eu

NATS_URL="${NATS_URL:-nats://nats:4222}"

# Target layout — must track ingest.rs's AUDIT_SUBJECTS / DIAGNOSTIC_SUBJECTS
# / EPHEMERAL_SUBJECTS exactly; nothing here should ever diverge from that
# file, which is what actually reads these streams.
AUDIT_STREAM='conv-approval'
AUDIT_SUBJECTS='conv.v1.*.changes conv.v2.*.changes.> approval.v1.*.lifecycle conv.v2.*.telemetry.usage'
AUDIT_MAX_AGE='0'

DIAGNOSTIC_STREAM='conv-diagnostic'
DIAGNOSTIC_SUBJECTS='conv.v1.*.telemetry conv.v2.*.telemetry.turn.started conv.v2.*.telemetry.turn.ended conv.v2.*.telemetry.turn.cancelled conv.v2.*.telemetry.turn.aborted conv.v2.*.telemetry.tool.use agent.v1.*.telemetry.attached agent.v1.*.telemetry.detached'
DIAGNOSTIC_MAX_AGE='90d'

EPHEMERAL_STREAM='conv-ephemeral'
EPHEMERAL_SUBJECTS='conv.v1.*.deltas conv.v2.*.deltas approval.v1.*.telemetry agent.v1.*.telemetry.ready agent.v1.*.telemetry.pulse'
EPHEMERAL_MAX_AGE='3d'

ALL_STREAMS="$AUDIT_STREAM $DIAGNOSTIC_STREAM $EPHEMERAL_STREAM"

nats_() {
  nats --server "$NATS_URL" "$@"
}

# Wait for the broker to answer before doing anything else.
i=0
while [ "$i" -lt 30 ]; do
  if nats_ account info >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  echo "nats not ready, retrying ($i)..."
  sleep 1
done
if [ "$i" -ge 30 ]; then
  echo 'gave up waiting for nats' >&2
  exit 1
fi

stream_exists() {
  nats_ stream info "$1" >/dev/null 2>&1
}

current_subjects() {
  nats_ stream info "$1" -j | jq -r '.config.subjects | join(" ")'
}

# Intersection of two space-separated subject lists, space-separated out.
intersect() {
  a="$1"
  b="$2"
  for s in $a; do
    for t in $b; do
      if [ "$s" = "$t" ]; then
        echo "$s"
      fi
    done
  done
}

target_subjects_for() {
  case "$1" in
    "$AUDIT_STREAM") echo "$AUDIT_SUBJECTS" ;;
    "$DIAGNOSTIC_STREAM") echo "$DIAGNOSTIC_SUBJECTS" ;;
    "$EPHEMERAL_STREAM") echo "$EPHEMERAL_SUBJECTS" ;;
  esac
}
target_max_age_for() {
  case "$1" in
    "$AUDIT_STREAM") echo "$AUDIT_MAX_AGE" ;;
    "$DIAGNOSTIC_STREAM") echo "$DIAGNOSTIC_MAX_AGE" ;;
    "$EPHEMERAL_STREAM") echo "$EPHEMERAL_MAX_AGE" ;;
  esac
}

echo "## Phase 1: release every existing stream to current \u2229 final (safe, removal-only)"
for stream in $ALL_STREAMS; do
  if ! stream_exists "$stream"; then
    continue
  fi
  final="$(target_subjects_for "$stream")"
  kept="$(intersect "$(current_subjects "$stream")" "$final" | tr '\n' ' ')"
  if [ -z "$kept" ]; then
    echo "  $stream: nothing to keep yet, leaving as-is until phase 2 sets its real list"
    continue
  fi
  echo "  $stream -> $kept"
  nats_ stream edit "$stream" --subjects "$kept" -f >/dev/null
done
echo

echo "## Phase 2: acquire each stream's full final subject list"
for stream in $ALL_STREAMS; do
  final="$(target_subjects_for "$stream")"
  max_age="$(target_max_age_for "$stream")"
  final_csv="$(echo "$final" | tr ' ' ',')"
  if ! stream_exists "$stream"; then
    echo "  creating $stream"
    nats_ stream add "$stream" \
      --subjects "$final_csv" \
      --storage file --retention limits --max-age "$max_age" --discard old --defaults >/dev/null
  else
    echo "  converging $stream"
    nats_ stream edit "$stream" --subjects "$final_csv" \
      --retention limits --max-age "$max_age" --discard old -f >/dev/null
  fi
done
echo

# Drain every message already stored under $subject in $from and republish
# it verbatim so it lands in $to (which now owns the subject). Verifies the
# count before purging $from. A stream can hold historical messages under a
# subject its CURRENT config no longer lists — narrowing never deletes.
copy_subject() {
  subject="$1"
  from="$2"
  to="$3"

  before="$(nats_ stream subjects "$from" "$subject" -j 2>/dev/null | jq '[.[]] | add // 0')"
  if [ "$before" = "0" ] || [ -z "$before" ]; then
    return 0
  fi
  echo "  $subject: $before message(s) stored in $from, moving to $to"

  consumer="migrate-$(date +%s)-$$"
  nats_ consumer add "$from" "$consumer" \
    --filter "$subject" --deliver all --ack none --replay instant --pull --defaults >/dev/null

  copied=0
  nats_ consumer next "$from" "$consumer" --count "$before" --no-ack 2>/dev/null | awk -v RS='' '
    {
      n = split($0, lines, "\n")
      for (i = 1; i <= n; i++) {
        if (lines[i] ~ /^\[.*\] subj: /) {
          line = lines[i]
          sub(/^\[.*\] subj: /, "", line)
          sub(/ \/.*/, "", line)
          subj = line
        } else if (lines[i] ~ /^\{/) {
          print subj "\t" lines[i]
        }
      }
    }
  ' > "/tmp/${consumer}.tsv" || true

  if [ -s "/tmp/${consumer}.tsv" ]; then
    while IFS="$(printf '\t')" read -r subj body; do
      printf '%s' "$body" | nats_ pub "$subj" --force-stdin >/dev/null
      copied=$((copied + 1))
    done < "/tmp/${consumer}.tsv"
  fi
  rm -f "/tmp/${consumer}.tsv"
  nats_ consumer rm "$from" "$consumer" -f >/dev/null 2>&1 || true

  if [ "$copied" != "$before" ]; then
    echo "  $subject: copied $copied, expected $before — NOT purging $from, investigate before re-running" >&2
    exit 1
  fi
  echo "  $subject: copied $copied, verified — purging from $from"
  nats_ stream purge "$from" --subject "$subject" -f >/dev/null
}

echo "## Phase 3: backfill historical data from wherever it still sits"
for stream in $ALL_STREAMS; do
  for subject in $(target_subjects_for "$stream"); do
    for other in $ALL_STREAMS; do
      if [ "$other" = "$stream" ]; then
        continue
      fi
      copy_subject "$subject" "$other" "$stream"
    done
  done
done
echo

echo "stream-init converged"
