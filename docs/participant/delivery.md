# Delivery to the stream

How what the participant publishes about a conversation reaches the stream.

## The rule

**No message is lost.** Nothing counts as undeliverable: what can't be
delivered now is delivered later. A broker that is down, a stream that
refuses, a store that can't be reached: each is retried, never dropped. The
one exception today is a message over the broker's size limit, which is
temporary (below).

Tower is meant to hold the whole conversation, so a message that never
reaches the stream defeats the point of publishing at all. Losing a message
is the failure the design exists to prevent, and where it can't prevent one,
the design changes.

## As built

- **One outbox per conversation, on disk:**
  `<config dir>/outbox/<conversation id>/`, owner-only. Everything published
  about a conversation goes through it: each `changes.message`,
  `changes.query.closed`, `attachment.attached` and `attachment.detached`.
  The world-level `ready`, `pulse`, `unavailable` and `offline` are plain
  publishes.
- **Written before the call returns.** The session store's `append()`
  returns once its entries are on disk (file synced, renamed, directory
  synced), not once the stream has them. A write that fails makes `append()`
  reject, so the SDK hands the batch over again; an entry whose uuid was
  already handed over is skipped.
- **Published until acknowledged.** A lane per conversation publishes its
  oldest message to the stream with the entry's uuid (or a minted id for the
  other events) as `Nats-Msg-Id`, waits for the stream's acknowledgement,
  deletes the file, and goes on. A publish that fails for any reason (no
  connection, no answer, no stream for the subject, the stream refusing it)
  is tried again after 250 ms, doubling to 5 s, without end; the messages
  behind it wait. Delivery order is the order the messages were handed over.
- **Files.** A message whose entry carries base64 files is written with the
  files' bytes beside it; the message already names each object
  (`<conversation id>/<message id>.<n>` in the durable bucket). Before the
  message is published the lane stores the objects, retrying if the store or
  the broker is unreachable.
- **Restart.** On connecting, the participant delivers whatever an earlier run
  left in the outbox, ahead of anything new for the same conversation.
- **The connection.** Once connected, the NATS client reconnects without
  limit.
- **Shutdown.** After `detached` is written, each lane delivers what the
  stream takes now and stops at the first message it won't; the rest stays
  on disk for the next run.
- **A write that fails** for `attached` rejects the `service` (`failed`) and
  the conversation is not served; for `detached` and a query's closure it is
  logged.
- Where the outbox lives, how it is keyed, the duplicate window and the
  connection options are values inside this design, free to change.

`apps/claude-code-participant/scripts/outbox-check.sh` checks this against the
test broker, stopping, pausing and restarting it (run it through the recipe
in CLAUDE.md).

## A broker unreachable at start

The participant exits; it doesn't wait. It exits through the rejected
connect, as a crash (Node's code 1). Undecided: whether it gets an exit code
of its own.

## Messages over the broker's size limit (MVP)

A message over the broker's `max_payload` (1 MB) is dropped and logged, and
the messages behind it go on. Until the MVP delivers them, throwing, or
dropping and logging, is accepted: an outbox can't help with a message the
broker will never take.

Base64 files already move to the durable bucket before publishing, so the
case left is large text, chiefly `tool_use.input`, which has no size limit.
How a large value is carried is a spec design, and open. Candidates: the
spec's `object` source shape at those places, or splitting across publishes.
How towerd would treat such a reference, given towerd already externalises
heavy values into `$ref`s itself, isn't known.

## Open

- A copy re-sent after the broker's 2-minute duplicate window could appear
  twice in towerd (it needs the SDK to hand a batch over again after a
  restart; not seen).
- An oversize message that carried files leaves its objects in the store.

Findings: [message loss investigation](../participant-findings/message-loss.md).
