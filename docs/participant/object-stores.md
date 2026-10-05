# Object stores, files and images

The spec states the contract as reference (`docs/spec/conversation.md`,
Transit and durable object stores). The deployment's buckets are in
`mvp/docs/deployment.md`.

## The two stores

- **Transit and durable.** Transit carries a request's files from tower to
  the agent, and its objects expire. Durable holds the bytes of what the
  agent committed.
- **Only the servicer writes to durable, when it commits.** An attachment is
  part of a request, like the say itself; it becomes part of the
  conversation only when the agent puts it there.
- **One durable bucket per deployment, kept forever,** created by
  `stream-init.sh` with no expiry, not by towerd. Stream-init is idempotent
  and sets retention on every run, so a wrong expiry is corrected on the
  next `docker compose up`.
- **Object names are `<conversationId>/<opaqueId>`.** The participant names
  them `<conversation id>/<message id>.<n>`.
- **Each object's metadata holds the id of the message that references it,
  and its media type.** The store's own SHA-256 digest covers the bytes.
- **A file is stored before the message that references it is published;**
  a message never points at nothing.
- **The spec doesn't name the bucket.** A reference is complete on its own,
  bucket and id, like a URI; the bucket only needs retention. The deployment
  names it.
- **Every image the agent commits goes to durable, always;** nothing is
  measured to decide whether an image could ride inside the message.
- **A file that can't be stored is the implementation's to handle;** the
  spec lists no outcomes. For a say whose file can't be stored, provisional:
  aborting the query.
- **A missing durable object is the agent's to handle.** Claude Code will
  likely have it in its transcript; if not, a synthetic message is generated
  when restoring. Tower shows a missing file the same way whichever agent
  serves the conversation.
- A block with no `bucket` does not resolve (there is no fallback to the
  configured transit bucket).
- Bridge commits transit references, so it doesn't comply with this. That is
  accepted.

Transit is for getting attachments to the agent, never for keeping them on
the bus: a conversation that kept transit references would lose its files
when they expire. Only the servicer writes to durable because anything else would let
anyone inject something into a conversation. Stream-init creates the bucket,
not towerd, so the agent doesn't depend on towerd. Objects are named under
their conversation because a conversation is what gets deleted, not
individual files.

## Images

- **Sending images from tower is MVP.** Seeing images Claude Code reads from
  disk is not needed.
- How it works, per the spec: the browser uploads to towerd
  (`POST /attachment`); the say carries references into transit; the
  servicer fetches them, passes the bytes to the model, and stores the file in
  durable before committing; the committed message references durable; a
  block that doesn't resolve is rejected `attachment_unavailable`.
- Today a say carrying attachments is rejected `unsupported`
  (`src/ServedConversation.ts`, marked as work left). The publisher already
  stores every image Claude Code commits in durable.
- **Towerd can't serve durable objects yet,** so a committed image shows
  "preview expired". Towerd opens only its transit bucket, and a durable id
  (which contains a `/`) misses its `/attachment/{id}` route. Three things
  are undecided: how the browser names a durable object, which buckets towerd
  may read, and how towerd learns the durable bucket's name. An image sent
  from tower would be committed as a durable reference, so it would show the
  same way until this is fixed (inferred). `mvp/docs/tower-ws-spec.md`,
  Attachments, still has wording from before the durable store
  ([towerd durable fetch](../participant-findings/towerd-durable-fetch.md)).
- Anthropic's Files API for images is a later concern.

Sending images is in the MVP because it is something Claude Code's terminal
can do that tower can't.

## Open

- Undecided: whether existing transit references in history are migrated.
  Not migrated for now.
- What scenario 8a is for, now that a committed block names the durable store
  while 8a's still names transit.
- Whether conformance compares bucket names literally, when the deployment
  names the buckets and the fixtures use example names.
- What a servicer puts in the model's request for a committed block that
  doesn't resolve (the spec has no rule for it).
- The maximum object size; how a reader fetches the bytes; an orphan object
  (stored, never referenced, for example by an oversize message that was
  dropped); a revision keeping an existing file; a normative schema for a
  committed reference block.
- Checking that the durable bucket exists at startup. Today a missing bucket
  goes unnoticed until the first file. A failed store is retried, so a
  missing bucket would hold that conversation's deliveries (inferred from the
  retry, not tried).
