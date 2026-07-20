#!/usr/bin/env bash
# One command brings the mvp up: towerd + the leptos frontend with hot reload.
# NATS is not started here — the broker runs separately and is expected up
# (docker compose up -d). Ctrl-C tears the lot down.
# The web app is http://localhost:8082 (trunk serve, hot reload, proxying /ws,
# /ref and /attachment to towerd); towerd also serves any built dist on $TOWER_BIND.
set -euo pipefail
cd "$(dirname "$0")"

# The v2 tower runs alongside the v1 one on the same machine: its own db,
# its own port. Overridable from the environment; the trunk port itself is
# fixed in frontend-leptos/Trunk.toml (8082).
export TOWER_BIND="${TOWER_BIND:-127.0.0.1:8081}"
export TOWER_DB="${TOWER_DB:-tower-v2.db}"

command -v trunk >/dev/null || { echo "dev.sh needs trunk (frontend-leptos's dev server): cargo install trunk" >&2; exit 1; }

# Build/install first so the runs below start together, not serially compiling.
cargo build --workspace
cargo build --manifest-path frontend-leptos/Cargo.toml

pids=()
run() {
  local name=$1
  shift
  ( "$@" 2>&1 | sed "s/^/[$name] /" ) &
  pids+=($!)
}

trap 'kill 0' EXIT INT TERM

run towerd cargo run -q -p towerd
( cd frontend-leptos && run web trunk serve ) &
pids+=($!)

echo "mvp up: web http://localhost:8082 · towerd http://$TOWER_BIND (db $TOWER_DB) · Ctrl-C stops everything"
wait
