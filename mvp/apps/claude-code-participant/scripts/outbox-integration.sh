#!/bin/sh
# Runs outbox-integration.mjs from the app directory, where tsx and the packages resolve.
# Meant to be run by `just broker-run`, which sets NATS_URL to the test broker.
set -eu
cd "$(dirname "$0")/.."
exec node --import tsx --test scripts/outbox-integration.mjs
