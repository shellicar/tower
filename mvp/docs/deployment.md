# Deployment

What the NATS broker holds for tower, and what creates each part. The
contract these meet is in `docs/spec/`; this page says how the deployment in
`mvp/compose.yaml` provides it.

## Streams

`mvp/stream-init.sh` creates the three JetStream streams and keeps them in
this shape. Each one uses file storage, limits retention and discards the
oldest messages first.

| Stream            | Maximum age | Subjects |
|-------------------|-------------|----------|
| `conv-approval`   | none        | `conv.v1.*.changes`, `conv.v2.*.changes.>`, `conv.v2.*.attachment.>`, `approval.v1.*.lifecycle`, `conv.v2.*.telemetry.usage` |
| `conv-diagnostic` | 90 days     | `conv.v1.*.telemetry`, `conv.v2.*.telemetry.turn.started`, `conv.v2.*.telemetry.turn.ended`, `conv.v2.*.telemetry.turn.cancelled`, `conv.v2.*.telemetry.turn.aborted`, `conv.v2.*.telemetry.tool.use`, `agent.v1.*.telemetry.attached`, `agent.v1.*.telemetry.detached` |
| `conv-ephemeral`  | 3 days      | `conv.v1.*.deltas`, `conv.v2.*.deltas`, `approval.v1.*.telemetry`, `agent.v1.*.telemetry.ready`, `agent.v1.*.telemetry.pulse` |

`conv-approval` is the record of every conversation, so nothing in it
expires. `conv-diagnostic` holds telemetry that is useful for debugging.
`conv-ephemeral` holds traffic that later messages replace, such as streaming
deltas and liveness pulses. It is kept only long enough for a consumer that
falls behind to catch up.

No stream captures a `.requests` subject (`docs/spec/nats.md`, Storage).

The subject lists match `AUDIT_SUBJECTS`, `DIAGNOSTIC_SUBJECTS` and
`EPHEMERAL_SUBJECTS` in `mvp/crates/towerd/src/ingest.rs`. A towerd test
fails if the two disagree.

## Object store buckets

The spec asks for two object stores, transit and durable
(`docs/spec/conversation.md`, Transit and durable object stores).

| Bucket    | Store   | Maximum age | Created by |
|-----------|---------|-------------|------------|
| `durable` | durable | none        | `mvp/stream-init.sh` |
| `attach`  | transit | 1 hour by default | towerd, at startup, if missing |

**`durable`** holds every file an agent commits to a conversation. stream-init
creates it with file storage and no maximum age. If the bucket already exists
with a maximum age, stream-init sets it back to none. Its backing stream is
`OBJ_durable`.

**`attach`** carries a say's files from the sender to the agent. towerd only
sets the maximum age when it creates the bucket; it does not change an
existing one.

## Running it

`docker compose up -d` in `mvp/` starts the broker and runs stream-init once.
stream-init runs on every `up` and brings an existing broker to the shape
above, so there is no separate migration step.

`mvp/compose.test.yaml` is the same layout on port 31416, with no volume, for
`just broker-run`.

## When to update this page

Update it in the same change whenever `mvp/stream-init.sh` changes, or the
subject lists in `mvp/crates/towerd/src/ingest.rs` change.
