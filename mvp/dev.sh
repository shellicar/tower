#!/usr/bin/env bash
# One command brings the mvp up: towerd + vite with hot reload.
# NATS is not started here — the broker runs separately and is expected up
# (docker compose up -d). Ctrl-C tears the lot down.
# The web app is http://localhost:$WEB_PORT (vite, hot reload, proxying /ws
# and /ref to towerd); towerd also serves any built dist on $TOWER_BIND.
set -euo pipefail
cd "$(dirname "$0")"

# The v2 tower runs alongside the v1 one on the same machine: its own db,
# its own port, its own vite port. All overridable from the environment.
export TOWER_BIND="${TOWER_BIND:-127.0.0.1:8081}"
export TOWER_DB="${TOWER_DB:-tower-v2.db}"
WEB_PORT="${WEB_PORT:-5174}"

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
run web    pnpm --dir frontend dev -- --port "$WEB_PORT"

echo "mvp up: web http://localhost:$WEB_PORT · towerd http://$TOWER_BIND (db $TOWER_DB) · Ctrl-C stops everything"
wait
