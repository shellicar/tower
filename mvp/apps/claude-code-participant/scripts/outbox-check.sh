#!/bin/sh
# Runs outbox-check.ts; broker-run starts the test broker around it. See the
# comment at the top of outbox-check.ts.
set -eu
cd "$(dirname "$0")/.."
exec pnpm exec node --import tsx scripts/outbox-check.ts
