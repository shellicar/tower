#!/bin/sh
# Proof 17: every case, fresh and resumed, in four lanes. Each case is its
# own driver; the check matches by session id, so lanes don't see each other.
# Usage (from mvp/claude-code-harness/): sh proofs/recovery-all.sh <model>
set -u
model="$1"
mkdir -p runs
lane() {
  for spec in "$@"; do
    set -- $spec
    timeout 1200 node proofs/recovery.mts case "$model" "$1" "$2" > "runs/recovery-$1-$2.log" 2>&1
    echo "$(date -u +%FT%TZ) $1 $2 exit $?" >> runs/recovery-all.log
  done
}
lane "press1 fresh" "press1 resumed" "press2 fresh" "press2 resumed" "press3 fresh" &
lane "press3 resumed" "kill fresh" "kill resumed" "abort fresh" "abort resumed" &
lane "kill-orphan fresh" "kill-orphan resumed" "crash fresh" "crash resumed" "kill-twice resumed" &
lane "claude-kill fresh" "claude-kill resumed" "reboot fresh" "reboot resumed" "reboot-later fresh" "reboot-later resumed" &
wait
