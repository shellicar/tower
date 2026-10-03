#!/bin/sh
# Runs extras-check.ts from the participant's directory, where tsx resolves.
# NATS_URL comes from the caller; `just broker-run` sets it to the test broker.
set -eu
cd "$(dirname "$0")/.."
exec pnpm exec node --import tsx scripts/extras-check.ts
