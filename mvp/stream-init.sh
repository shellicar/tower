#!/bin/sh
# Converges the broker's streams to the subject layout mvp/crates/towerd/src/
# ingest.rs declares (AUDIT_SUBJECTS / DIAGNOSTIC_SUBJECTS / EPHEMERAL_SUBJECTS)
# — from ANY starting state: no streams at all (fresh install), the original
# single conv-approval stream holding everything, the first retention split
# (usage still miscategorised under diagnostic), or already fully converged.
# Runs on every `docker compose up`, unattended, in the nats-box container —
# `down` does not remove the data volume, so this is the ONLY thing that ever
# needs to bring an existing broker's streams up to date; there is no separate
# migrate-*.sh to run by hand.
#
# The generic move, run once per subject that has drifted from its target
# stream (a fresh install has none to move — every subject starts unowned):
#   1. Read the subject's CURRENT owning stream, if any (`stream ls --subject`).
#   2. Remove it from that stream's subject list — JetStream refuses two
#      streams claiming the same subject, so this must happen before the
#      target stream can claim it. Removing a subject from a stream's config
#      does NOT delete messages already stored under it.
#   3. Add it to the target stream's subject list (creating the stream first
#      if this is its first subject).
#   4. Drain every message the OLD owner still holds under that subject and
#      republish it verbatim (same subject, same body) — it now lands in the
#      target stream, the only one listening for that subject.
#   5. Verify the republished count matches what was drained. Only then purge
#      the old owner of that subject — never before the count is confirmed.
#
# No external backup step (unlike the human-run mvp/migrate-*.sh scripts this
# supersedes): this runs unattended in a container with nowhere obvious to put
# one, so the safety property here is different and, for this purpose,
# stronger — nothing is ever purged until step 5's count-match confirms the
# copy landed, which a static backup file doesn't verify on its own.

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

# The stream (if any) currently configured to capture this subject. Empty if
# none does (a genuinely fresh install, or the target already owns it).
owning_stream() {
  nats_ stream ls --subject="$1" --names 2>/dev/null | tr -d '\r'
}

current_subjects() {
  nats_ stream info "$1" -j | jq -r '.config.subjects | join(" ")'
}

# Move one subject to the target stream, creating the stream on its first
# subject if it does not exist yet. No-op if the target already owns it.
ensure_subject() {
  subject="$1"
  target="$2"
  target_max_age="$3"

  owner="$(owning_stream "$subject")"
  if [ "$owner" = "$target" ]; then
    return 0 # already correct
  fi

  if ! stream_exists "$target"; then
    echo "creating $target with $subject"
    nats_ stream add "$target" \
      --subjects "$subject" \
      --storage file --retention limits --max-age "$target_max_age" --discard old --defaults
  else
    existing="$(current_subjects "$target")"
    echo "adding $subject to $target"
    nats_ stream edit "$target" --subjects "$existing $subject" -f
  fi

  if [ -z "$owner" ]; then
    return 0 # nobody held it before (fresh install) — nothing to migrate
  fi

  echo "migrating $subject: $owner -> $target"
  narrowed="$(current_subjects "$owner" | tr ' ' '\n' | grep -v -x -F "$subject" | tr '\n' ' ')"
  nats_ stream edit "$owner" --subjects "$narrowed" -f

  copy_subject "$subject" "$owner" "$target"
}

# Drain every message still held under $subject in $from (narrowing $from's
# config does not delete them) and republish verbatim so they land in $to,
# which now owns the subject. Verifies the count before purging $from.
copy_subject() {
  subject="$1"
  from="$2"
  to="$3"

  before="$(nats_ stream subjects "$from" "$subject" -j 2>/dev/null | jq '[.[]] | add // 0')"
  if [ "$before" = "0" ] || [ -z "$before" ]; then
    echo "  nothing stored under $subject in $from"
    return 0
  fi
  echo "  $before message(s) to move"

  consumer="migrate-$(date +%s)-$$"
  nats_ consumer add "$from" "$consumer" \
    --filter "$subject" --deliver all --ack none --replay instant --pull --defaults >/dev/null

  copied=0
  moved_ok=1
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
  ' > "/tmp/${consumer}.tsv" || moved_ok=0

  if [ "$moved_ok" = "1" ] && [ -s "/tmp/${consumer}.tsv" ]; then
    while IFS="$(printf '\t')" read -r subj body; do
      printf '%s' "$body" | nats_ pub "$subj" --force-stdin >/dev/null
      copied=$((copied + 1))
    done < "/tmp/${consumer}.tsv"
  fi
  rm -f "/tmp/${consumer}.tsv"
  nats_ consumer rm "$from" "$consumer" -f >/dev/null 2>&1 || true

  if [ "$copied" != "$before" ]; then
    echo "  copied $copied, expected $before — NOT purging $from, investigate before re-running" >&2
    exit 1
  fi
  echo "  copied $copied, verified — purging $subject from $from"
  nats_ stream purge "$from" --subject "$subject" -f >/dev/null
}

for subject in $AUDIT_SUBJECTS; do
  ensure_subject "$subject" "$AUDIT_STREAM" "$AUDIT_MAX_AGE"
done
for subject in $DIAGNOSTIC_SUBJECTS; do
  ensure_subject "$subject" "$DIAGNOSTIC_STREAM" "$DIAGNOSTIC_MAX_AGE"
done
for subject in $EPHEMERAL_SUBJECTS; do
  ensure_subject "$subject" "$EPHEMERAL_STREAM" "$EPHEMERAL_MAX_AGE"
done

# Converge each stream's final subjects (exactly the target list, no drift)
# and retention/discard settings — a plain re-run with nothing to migrate
# still lands here and fixes a hand-edited or partially-applied config.
echo "converging final subject lists and retention"
nats_ stream edit "$AUDIT_STREAM" --subjects "$(echo "$AUDIT_SUBJECTS" | tr ' ' ',')" \
  --retention limits --max-age "$AUDIT_MAX_AGE" --discard old -f
nats_ stream edit "$DIAGNOSTIC_STREAM" --subjects "$(echo "$DIAGNOSTIC_SUBJECTS" | tr ' ' ',')" \
  --retention limits --max-age "$DIAGNOSTIC_MAX_AGE" --discard old -f
nats_ stream edit "$EPHEMERAL_STREAM" --subjects "$(echo "$EPHEMERAL_SUBJECTS" | tr ' ' ',')" \
  --retention limits --max-age "$EPHEMERAL_MAX_AGE" --discard old -f

echo "stream-init converged"
