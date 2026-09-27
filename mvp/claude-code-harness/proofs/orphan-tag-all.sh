#!/bin/sh
# Proof 25: each case and variant given, one after another (each case resets
# the one agent name, orphans-25, so they can't overlap), each under a
# signal-only trace, as proof 21's orphans-all.sh.
# Usage (from mvp/claude-code-harness/):
#   sh proofs/orphan-tag-all.sh <model> <tag> <case>:<variant>...
# strace records no syscalls (-e trace=none, seccomp-bpf so they don't stop)
# and no data (-s 0): only the signals listed as each is delivered (with the
# sending pid) and each process's exit, with wall-clock times.
set -u
model="$1"
tag="$2"
shift 2
mkdir -p runs
for cv in "$@"; do
  c="${cv%%:*}"
  v="${cv#*:}"
  out="runs/25-$c-$v-$tag"
  timeout 1500 strace -f --seccomp-bpf -tt -s 0 -e trace=none -e signal=SIGINT,SIGTERM,SIGUSR2,SIGPIPE,SIGHUP,SIGQUIT,SIGABRT,SIGSEGV,SIGKILL -o "$out.strace" node proofs/orphan-tag.mts case "$model" "$c" "$v" > "$out.log" 2>&1
  echo "$(date -u +%FT%TZ) $c $v $tag exit $?" >> runs/25-all.log
done
