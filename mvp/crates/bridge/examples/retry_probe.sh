#!/bin/sh
# A throwaway probe, not product code — the shell counterpart to
# attach_probe.rs: drives bridge's connect-phase retry (retry.rs) against a
# network that is not there, and shows what the console actually says.
#
# Every outbound HTTP request is aimed at a port nothing listens on, so the
# messages call never reaches a server and every attempt is the `NoResponse`
# arm. The status arms (429, 5xx, retry-after, the spend cap) cannot be forced
# from out here and are covered by retry.rs's own tests instead.
#
# Run it through broker-run, which is what keeps it off the fleet's broker:
#
#     cargo build -p bridge
#     RETRY_LINE='{"retry":{"maxRetries":3,"baseDelayMs":500,"maxDelayMs":4000,"retryAfterCapMs":60000}}' \
#       just broker-run 'sh crates/bridge/examples/retry_probe.sh'
#
# RETRY_LINE   the control line to send; empty sends none, which is bridge's
#              behaviour before any retrying existed (one attempt, then abort)
# CANCEL_AFTER seconds to wait before cancelling the query, to watch a cancel
#              land during a backoff wait rather than after it
# HOLD         seconds to keep bridge's stdin open before it exits
set -eu

BRIDGE="${BRIDGE:-./target/debug/bridge}"
LOG="${LOG:-/tmp/retry-probe-stderr.log}"
: > "$LOG"

HTTPS_PROXY='http://127.0.0.1:9'
HTTP_PROXY='http://127.0.0.1:9'
ANTHROPIC_API_KEY='probe-key-not-real'
export HTTPS_PROXY HTTP_PROXY ANTHROPIC_API_KEY

{
	printf '%s\n' '{"model":{"name":"claude-sonnet-5","maxTokens":8192}}'
	if [ -n "${RETRY_LINE:-}" ]; then
		printf '%s\n' "$RETRY_LINE"
	fi
	printf '%s\n' '{"spawn":{}}'
	sleep "${HOLD:-25}"
} | "$BRIDGE" 2>>"$LOG" | while IFS= read -r line; do
	printf 'stdout <- %s\n' "$line"
	conv=$(printf '%s' "$line" | jq -r '.conversationId // empty')
	if [ -n "$conv" ]; then
		printf 'probe  -> say into %s\n' "$conv"
		reply=$(nats --server "$NATS_URL" req --timeout=20s --raw \
			"conv.v2.$conv.requests.say" \
			"{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"from\":{\"kind\":\"human\"},\"text\":\"probe\",\"precondition\":{\"tip\":null}}") \
			|| reply=''
		printf 'probe  <- %s\n' "$reply"
		query=$(printf '%s' "$reply" | jq -r '.id // empty')
		if [ -n "${CANCEL_AFTER:-}" ] && [ -n "$query" ]; then
			sleep "$CANCEL_AFTER"
			printf 'probe  -> cancel %s at %s\n' "$query" "$(date -u +%H:%M:%S)"
			nats --server "$NATS_URL" req --timeout=20s --raw \
				"conv.v2.$conv.requests.cancel" \
				"{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"from\":{\"kind\":\"human\"},\"id\":\"$query\"}" \
				|| printf 'probe  -> cancel returned non-zero\n'
		fi
	fi
done

printf '\n--- bridge stderr ---\n'
cat "$LOG"
