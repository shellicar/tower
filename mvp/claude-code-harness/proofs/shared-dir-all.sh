#!/bin/sh
# Proof 17b: the kill-orphan case per variant, one after another (each case
# resets the one agent name, recovery-17b, so they can't overlap), each under
# strace, then the shared-dir analysis.
# Usage (from mvp/claude-code-harness/): sh proofs/shared-dir-all.sh <model> <tag> <variant>...
# strace -s 0: no written data is recorded (a token refresh would otherwise
# put the login's credentials in the trace); lengths, flags and offsets are.
set -u
model="$1"
tag="$2"
shift 2
mkdir -p runs
for v in "$@"; do
  out="runs/17b-$v-$tag"
  timeout 1200 strace -f -tt -y -s 0 -e trace=%process,openat,write,pwrite64,writev,pwritev,pwritev2,ftruncate,rename,renameat,renameat2,unlink,unlinkat,flock,fcntl,link,linkat,mkdir,mkdirat,rmdir -o "$out.strace" node proofs/recovery.mts case "$model" kill-orphan "$v" > "$out.log" 2>&1
  echo "$(date -u +%FT%TZ) $v exit $?" >> runs/17b-all.log
  sed -i -E 's/sk-ant-[A-Za-z0-9_-]+/sk-ant-[REDACTED]/g; s/((peer|child)Token\\":\\")[0-9a-f]+/\1[REDACTED]/g' "$out.strace"
  dir=$(sed -n 's/.*driver: case kill-orphan .*; dir \(.*\)$/\1/p' "$out.log" | head -1)
  node proofs/shared-dir-analysis.mts "$dir" "$out.strace" > "$out.analysis.txt" 2>&1
  echo "$(date -u +%FT%TZ) $v analysed $dir" >> runs/17b-all.log
done
