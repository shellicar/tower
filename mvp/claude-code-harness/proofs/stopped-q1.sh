#!/bin/sh
# Proof 7, Q1: each stop method at each point, once under strace (signals and
# exits attributed) and once without it (timings free of strace overhead).
# From mvp/claude-code-harness/:  sh proofs/stopped-q1.sh <model> [method ...]
set -u
model=$1; shift
methods=${*:-abort interrupt sigint sigterm}
mkdir -p runs
for method in $methods; do
  for point in reply tool; do
    for traced in yes no; do
      out=runs/q1-$method-$point-$traced.out
      if [ $traced = yes ]; then
        timeout 300 strace -f -ttt -e trace=%process,kill,tgkill,tkill -o runs/q1.strace \
          env PROOF7_STRACED=yes node --disable-warning=ExperimentalWarning proofs/stopped.mts stop "$model" $method $point > $out 2>&1
      else
        timeout 300 node --disable-warning=ExperimentalWarning proofs/stopped.mts stop "$model" $method $point > $out 2>&1
      fi
      dir=$(grep -o 'runs/[^ ]*stopped-one-[a-z]*' $out | head -1)
      echo "$method $point traced=$traced -> $dir"
      if [ $traced = yes ] && [ -n "$dir" ]; then
        mv runs/q1.strace $dir/strace.txt
        node --disable-warning=ExperimentalWarning proofs/stopped.mts --analyse $dir > /dev/null
      fi
      [ -n "$dir" ] && mv $out $dir/proof-stdout.txt
    done
  done
done
