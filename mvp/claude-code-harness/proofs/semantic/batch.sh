#!/bin/sh
# Resume each named seed run from five sources, one after another; with
# --republish, first rebuild its tower conversations from the recorded run.
# Prints "<seed run> <source> <resume run>" per resume, then BATCH-DONE.
cd "$(dirname "$0")/../.."
REPUBLISH=0
[ "$1" = "--republish" ] && { REPUBLISH=1; shift; }
for seed in "$@"; do
  S=$(python3 -c "import json;print(json.load(open('$seed/seed.json'))['sessionId'])")
  [ $REPUBLISH = 1 ] && node proofs/semantic-form.mts republish "$seed"
  for src in full A B A-silent B-silent; do
    PROOF16_FIRST_DELAY_MS=20000 timeout 300 node proofs/semantic-form.mts resume claude-sonnet-5 $src $S > runs/final-$S-$src.out 2>&1
    echo "$seed $src $(grep -m1 -o 'runs/[^;]*' runs/final-$S-$src.out)"
  done
done
echo BATCH-DONE
