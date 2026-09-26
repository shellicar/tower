#!/bin/sh
# Runs a command with a private /etc: a user + mount namespace, /etc
# overlaid with a throwaway upper directory, then dropped back to the
# caller's own uid/gid in a nested user namespace. Writes under /etc (proof
# 19's /etc/claude-code/.claude/skills) land in the upper directory, which is
# removed afterwards; the real /etc is never written. Linux only.
#
#   proofs/private-etc.sh <command> [args...]
set -eu
uid=$(id -u)
gid=$(id -g)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/tower-proof-19-etc-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/upper" "$scratch/work"
unshare --user --map-root-user --mount sh -c '
  set -eu
  mount -t overlay overlay -o "lowerdir=/etc,upperdir=$1/upper,workdir=$1/work" /etc
  shift
  exec unshare --user --map-user="$1" --map-group="$2" env P19_PRIVATE_ETC=1 "$@"
' sh "$scratch" "$uid" "$gid" "$@"
