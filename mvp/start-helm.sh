#!/bin/sh
set -eu
cd "$(dirname "$0")"
HELM_BRIDGE_PATH=./target/debug/bridge cargo run -p helm -- --adopt 8c280151-78f5-48e2-9c3a-2e856a582c01 -c "$(cat config.jsonl)"
