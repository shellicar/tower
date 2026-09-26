#!/bin/sh
# Proof 20: for one model, seed each scenario and resume each seed from
# Claude Code's full record and from what A published (strict, every no-block
# entry, only session_context). Prints "SEED ..." and "RESUME ..." lines from
# the runs, then BATCH-DONE. From mvp/claude-code-harness/:
#   proofs/semantic/batch20.sh <model> [scenario...]
cd "$(dirname "$0")/../.."
MODEL=$1; shift
SCENARIOS=${*:-main limit}
for sc in $SCENARIOS; do
  OUT=runs/p20-batch-$(date -u +%Y%m%dT%H%M%S)-$MODEL-$sc
  timeout 900 node proofs/body-copy.mts seed "$MODEL" "$sc" > "$OUT-seed.out" 2>&1
  SEEDLINE=$(grep '^SEED ' "$OUT-seed.out")
  echo "$SEEDLINE"
  S=$(echo "$SEEDLINE" | cut -d' ' -f2)
  [ -z "$S" ] && { echo "seed $sc failed: $OUT-seed.out"; continue; }
  for src in full A A-silent A-silent-sc full; do
    PROOF20_FIRST_DELAY_MS=20000 timeout 300 node proofs/body-copy.mts resume "$MODEL" $src "$S" > "$OUT-resume-$src.out" 2>&1
    grep '^RESUME ' "$OUT-resume-$src.out" || echo "RESUME $src FAILED $OUT-resume-$src.out"
  done
done
echo BATCH-DONE
