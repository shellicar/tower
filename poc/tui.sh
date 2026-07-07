#!/usr/bin/env bash
# Attach the terminal client to an agent. Defaults to agent-one:
#   ./tui.sh            → attaches to agent-one
#   ./tui.sh agent-two  → attaches to agent-two
set -euo pipefail
cd "$(dirname "$0")"
exec cargo run -q -p tui -- "${1:-agent-one}"
