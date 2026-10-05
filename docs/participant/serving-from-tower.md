# Serving from tower (MVP)

Starting a new conversation and continuing an existing one from tower's UI.
Not built. Today towerd sends only `say`, `cancel` and approval answers,
never `service`; the browser has no command to start a conversation; the
driving script `new-conversation.ts` always mints a fresh id, and no script
re-serves an existing one. It touches the spec, towerd, both frontends and
the participant.

This file covers what is decided for serving from tower, re-serving after a
restart, and stopping serving one conversation. How the participant answers
`service` today is in [presence.md](presence.md).

## Decided

- **Starting a new conversation is servicing.** Towerd sends `service` with a
  fresh conversation id and a cwd; the first message is an ordinary `say`.
- **Towerd mints the id,** not the browser.
- **What tower offers to serve on comes from the agents that are alive.**
  Tower only needs to know which agents are (potentially) ready.
- **Continuing a conversation re-serves it in the world that served it
  last.** Moving a conversation to another world is a separate operation;
  the spec's `service` to another world is how that operation would be
  carried out.
- **Towerd keeps which world (and directory) served a conversation after it
  detaches.** Where it keeps it is a value inside this design, free to
  change.

If nothing is ready, nothing would receive the request either, so the
agents that are alive are all tower needs to offer.

## Re-serving after a restart (MVP)

After a participant restart nothing is served again. Wanted: an
"auto-service" option that re-serves automatically. A `service` to the same
world for a conversation whose holder went silent takes it over (the spec's
premise for `service`); the participant doesn't implement the premise yet.

Open: who sends the `service` (the participant, from a list it keeps, or
tower on seeing `ready`); whether conversations `detached` at a clean
shutdown count; one setting or one per conversation.

## Stopping serving one conversation (MVP)

Wanted: unservicing a conversation (the terminal equivalent is ending the
session, or `/clear`). The spec has no request to stop serving one
conversation; `drain` stops a whole instance. Not designed. Archive is
related, and whether archive is MVP is open.

## Open

- How the UI groups the choice of where to serve (by world is a candidate).
- Whether tower suggests directories a world used before, beside a typed
  path (a candidate).
