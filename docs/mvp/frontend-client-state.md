# Frontend client state

What a browser client may hold for itself, and what it must read from the
conversation. Written 2 August 2026 from a live failure: a composer that
stayed disabled with no way to send.

Both frontends have this; it is not a parity gap.

## The rule

A client tracks its own request until that request is answered, and relies on
it no further.

The window between hitting send and receiving the servicer's accept is
legitimately client-only, because nothing on the wire knows the say exists
yet. That is what `lastSay` is, and it is cleared on accept.

Everything after the accept is a fact about the conversation, and the client
reads it from the conversation.

## Where the code breaks the rule

`ConversationPanel` decides whether you can send by reading `liveQuery`, a
field on the client's own per-conversation state. It holds the id of the query
this browser tab started and has not yet seen finish. Nothing else sets it,
and it is set by the accept, which is the moment it should have been let go.

Three wrong answers follow:

- A second tab watching a conversation mid-turn sees it as idle, because it
  did not send the say.
- A reloaded tab sees it as idle for the same reason.
- The tab that did send stays blocked forever when the servicer dies before
  the query closes, because the closure that would clear it is never
  published. Observed on 2 August: a bridge was interrupted mid-query and its
  composer could not be used again until the page was reloaded.

## What replaces it

A fold of facts already on the wire. A query is running when the record holds
an accepted query with no closure and the instance serving the conversation is
alive. The rail already derives that liveness from the attachment and pulses
against its own clock.

Open query plus live holder is busy. Open query plus stranded holder is a
servicer that died mid-query, which resolves itself as liveness expires, with
no timer and no special case.

## To confirm before building it

Whether a client receives query closures in the history it gets when a
conversation is opened, or only live from that moment. If only live, the fold
cannot answer for a query that opened before the client looked, and that is a
towerd change rather than a frontend one.
