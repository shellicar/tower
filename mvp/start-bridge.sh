#!/bin/sh
set -eu
cd "$(dirname "$0")"
cargo run -p bridge -- -c "$(cat config.jsonl)"
