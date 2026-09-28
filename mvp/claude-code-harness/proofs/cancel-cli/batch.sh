#!/bin/sh
# Runs cancel-cli scenarios one after another (one agent, one config dir, so
# never in parallel), each under a timeout, logging to runs/.
#   sh proofs/cancel-cli/batch.sh <log name> <scenario> [<scenario> ...]
cd "$(dirname "$0")/../.." || exit 1
log="runs/cancel-cli-batch-$1.log"
shift
for s in "$@"; do
  echo "=== $(date -u +%H:%M:%S) $s" >> "$log"
  timeout 600 node proofs/cancel-cli/run.mts "$s" >> "$log" 2>&1
  echo "=== $(date -u +%H:%M:%S) $s exit=$?" >> "$log"
done
echo "=== batch done" >> "$log"
