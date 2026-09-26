#!/bin/sh
# Proof 7, Q2: three Ctrl-C presses with three Claude Codes mid-turn, press 1
# by interrupt or by abort, delivered to the host only or to its process
# group (a terminal), 1000 ms apart and 0 ms apart (GAPS overrides: 100 and
# 3000 were also run).
# From mvp/claude-code-harness/:  sh proofs/stopped-q2.sh <model>
set -u
model=$1
mkdir -p runs
for gap in ${GAPS:-1000 0}; do
  for stage1 in press-interrupt press-abort; do
    for delivery in host group; do
      out=runs/q2-$stage1-$delivery-$gap.out
      timeout 400 node --disable-warning=ExperimentalWarning proofs/stopped.mts drive "$model" $stage1 $delivery $gap > $out 2>&1
      dir=$(grep -o 'runs/[^ ]*stopped-drive-[a-z0-9-]*' $out | head -1)
      echo "$stage1 $delivery gap=$gap -> $dir"
      [ -n "$dir" ] && mv $out $dir/driver-stdout.txt
    done
  done
done
