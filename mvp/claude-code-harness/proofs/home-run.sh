#!/bin/sh
# Proof 26: run one option under a file-access trace (no contents: -s 0) and
# read the trace. From mvp/claude-code-harness/:
#   sh proofs/home-run.sh <model> <option>
set -eu
model=$1
option=$2
stamp=$(date -u +%Y%m%dT%H%M%SZ)
trace=runs/$stamp-p26-$option.strace
log=runs/$stamp-p26-$option.log
timeout 900 strace -f -y -ttt -s 0 -e trace=%file,%process,bind,connect -o "$trace" node proofs/home.mts "$model" "$option" > "$log" 2>&1 || echo "proof exit $?" >> "$log"
out=$(sed -n 's/.*; out \(.*\)$/\1/p' "$log" | head -1)
fix=$(sed -n 's/.*; fixtures \([^;]*\); out .*/\1/p' "$log" | head -1)
state=$HOME/.local/state/tower-claude-code-harness
node proofs/home-trace.mts "$trace" "$out/phases.json" "home=$fix/home" "$fix" "$state/config-dirs/p26-$option" "$state/work/p26-$option" > "$out/home-trace.txt"
python3 proofs/home-trace-brief.py "$out/home-trace.txt" > "$out/home-trace-brief.txt"
mv "$trace" "$log" "$out/"
echo "$out"
