#!/bin/sh
# Runs publish-extras.ts from the app's own directory, for the broker-run
# recipe, which exports NATS_URL for the test broker. From the repository root:
#
#   just --justfile mvp/justfile --working-directory mvp broker-run 'apps/claude-code-participant/scripts/publish-extras.sh'
set -eu
cd "$(dirname "$0")/.."
exec node --import tsx scripts/publish-extras.ts "$@"
