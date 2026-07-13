#!/usr/bin/env bash
# One command brings the mvp up: towerd + vite with hot reload.
# NATS is not started here — the broker runs separately and is expected up
# (docker compose up -d). Ctrl-C tears the lot down.
# The web app is http://localhost:5173 (vite, hot reload, proxying /ws and
# /ref to towerd); towerd also serves any built dist on 8080.
set -euo pipefail
cd "$(dirname "$0")"

# Build/install first so the runs below start together, not serially compiling.
cargo build --workspace
pnpm --dir frontend install

pids=()
run() {
  local name=$1
  shift
  ( "$@" 2>&1 | sed "s/^/[$name] /" ) &
  pids+=($!)
}

trap 'kill 0' EXIT INT TERM

run towerd cargo run -q -p towerd
run web    pnpm --dir frontend dev

echo "mvp up: web http://localhost:5173 · towerd http://127.0.0.1:8080 · Ctrl-C stops everything"
wait
