# How messages were lost, and what prevents it

**Question.** How messages are lost when a publish fails, and which approach
prevents it.

**Method.** Scripts (`probe.mjs`, `e0-baseline` to `e4-reject-large`,
`pump.mjs` with `AckedPublisher`, `MemoryStore`, `SqliteStore`, `lib.mjs`,
`child.mjs`) run through `broker-run` against the test broker; plus a read of
the NATS client's source and the SDK's documentation of
`SessionStore.append`. The scripts were in a session scratchpad under `/tmp`,
which is cleared at boot.

**Versions.** `@nats-io/transport-node` 3.4.0. Claude Code and Agent SDK
versions not recorded. Broker: `max_payload` 1,048,576; stream
`conv-approval` with `max_msg_size` -1 and a 2-minute duplicate window; a
JetStream publish with a message id is accepted up to 1,048,500 bytes of
payload.

**Found.** (As reported by the agent, not re-run.)
- Seen first: three messages lost during an outage, and after any loss every
  `say` was rejected `stale`.
- Broker down for seconds: every publish returned normally; one message of
  four was missing afterwards.
- Broker down 40 s: the client closed after 10 attempts (30.8 s); the next
  publish threw `ClosedConnectionError`; only the first message was stored.
- A 1.5 MB publish throws `max_payload size exceeded`.
- A core publish over a stream limit, or to a subject no stream covers,
  returns normally and stores nothing; `js.publish` throws.
- A, connection options only: survived 35 s down but still lost messages.
- B, JetStream acknowledgement plus a message id, with an in-memory queue:
  stored everything in order and detected the duplicate, but lost everything
  on SIGKILL. A permanent error classed as transient blocks the queue.
- C, a disk outbox (`node:sqlite`, WAL, `synchronous=FULL`): recovered
  everything after SIGKILL. A crash between the acknowledgement and the
  delete, after the duplicate window, gave a duplicate. A stream rejection
  stays in the outbox without blocking. Cost: 2.28 ms per insert (FULL),
  0.064 ms (NORMAL); acknowledgement 0.25 ms. `ts` must be taken when queued.
- D, spill to the object store: a 3 MB message became a 259-byte message and
  one object; the shape would need a spec change.
- The cause of the original loss: the publisher's builder had chosen
  "publish never rejects; a failure is logged and the rest goes out", a
  choice nobody ruled on.
- Also noticed: compaction summaries are left out although the model sees
  them; query start and close went through the same unacknowledged publish.

**Resume comparison.** Not about resume.

**Used by.** [delivery.md](../participant/delivery.md): the disk outbox was
chosen (as files, not sqlite).
