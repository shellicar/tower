#!/bin/sh
# Proof 21: each case and variant given, one after another (each case resets
# the one agent name, orphans-21, so they can't overlap), each under a
# signal-only trace.
# Usage (from mvp/claude-code-harness/):
#   sh proofs/orphans-all.sh <model> <tag> <case>:<variant>...
# strace records no syscalls at all (-e trace=none, seccomp-bpf so they don't
# stop), and no data (-s 0): only the signals listed as each is delivered
# (with the sending pid) and each process's exit, with wall-clock times.
set -u
model="$1"
tag="$2"
shift 2
mkdir -p runs
for cv in "$@"; do
  c="${cv%%:*}"
  v="${cv#*:}"
  out="runs/21-$c-$v-$tag"
  timeout 1500 strace -f --seccomp-bpf -tt -s 0 -e trace=none -e signal=SIGINT,SIGTERM,SIGUSR2,SIGPIPE,SIGHUP,SIGQUIT,SIGABRT,SIGSEGV -o "$out.strace" node proofs/orphans.mts case "$model" "$c" "$v" > "$out.log" 2>&1
  echo "$(date -u +%FT%TZ) $c $v $tag exit $?" >> runs/21-all.log
done
