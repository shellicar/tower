#!/usr/bin/env bash
# One command brings the POC up: fake-model, two agents, tower backend, vite.
# NATS is not started here — the broker runs separately and is expected up.
# Ctrl-C tears the lot down. The tui needs a real terminal: run ./tui.sh separately.
set -euo pipefail
cd "$(dirname "$0")"

# Build first so the runs below start together, not serially compiling.
cargo build --workspace

pids=()
run() {
  local name=$1
  shift
  ( "$@" 2>&1 | sed "s/^/[$name] /" ) &
  pids+=($!)
}

trap 'kill 0' EXIT INT TERM

run model   cargo run -q -p fake-model
run agent1  cargo run -q -p agent -- --id agent-one
run agent2  cargo run -q -p agent -- --id agent-two
# --static-dir passed absolute-ish so the backend works from this directory too,
# not only from tower/backend/ (its default is relative to the launch cwd).
run backend cargo run -q -p tower-backend -- --static-dir tower/frontend/dist
run web     pnpm --dir tower/frontend dev

echo "POC up: web http://localhost:5173 · backend http://localhost:8091 · Ctrl-C stops everything"
wait
