#!/bin/sh
# Runs author-check.ts; broker-run starts the test broker around it. See the
# comment at the top of author-check.ts.
set -eu
cd "$(dirname "$0")/.."
exec timeout 600 pnpm exec node --import tsx scripts/author-check.ts
