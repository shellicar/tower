# Frontend client state

What a browser client may hold for itself, and what it must read from the
conversation.

Both frontends have this; it is not a parity gap.

## The rule

Two clients open on the same conversation agree on which actions are valid.
Whatever decides what can be done is read from the conversation, never from
state a client holds about its own request.

A client may still hold that state. `pendingSay` is the say in flight, set
before the request goes out and held until the committed message lands, so the
panel can grey out what was just said and hand the words back if the query dies
first. Two tabs already disagree about it: it is per-tab, nothing rehydrates it,
and a reload loses both the greyed line and the restore. That divergence is
cosmetic. Neither tab is wrong about what can be done.

`liveQuery` is the other kind. It decides whether the composer is enabled, so
two tabs disagreeing about it means they disagree about whether you may speak.
That is the line: a value that only shows something may be local, a value that
decides something may not.

## Where the code breaks the rule

Both frontends gate sending on `liveQuery`, a field on the client's own
per-conversation state. It holds the id of the query this browser tab started
and has not yet seen finish. Nothing else sets it, so it answers "am I waiting
on something I sent" and is then read as though it answered "is this
conversation busy".

The two put the gate in different layers. Svelte decides in the component
(`ConversationPanel.svelte:178`). Leptos decides in the concern
(`concerns/conversation.rs`, `can_send`), deliberately and with its reasoning
written down, and a test pins it. Whoever changes this changes both, and the
Leptos test is asserting the current rule on purpose.

Two wrong answers follow:

- A second tab watching a conversation mid-turn sees it as idle, because it
  did not send the say.
- A reloaded tab sees it as idle for the same reason.

A third case looks worse than it is and is worth recording so nobody rediscovers
it as a bug: when a servicer dies mid-query no closure ever arrives, so the tab
that sent stays gated. The cancel button renders in exactly that state, towerd
answers it `unreachable`, and that clears `liveQuery` and hands the words back.
Reconnecting, or closing and reopening the conversation, clears it too.

## What replaces it

A fold of facts already on the wire. A query is running when the record holds
an accepted query with no closure and the instance serving the conversation is
alive. The rail already derives that liveness from the attachment and pulses
against its own clock.

Open query plus live holder is busy. Open query plus stranded holder is a
servicer that died mid-query, which resolves itself as liveness expires, with
no timer and no special case.

## This is a towerd change, not only a frontend one

A client receives query closures only live, from the moment it starts watching
(`ws.rs`, the `QueryClosed` arm is gated on `watching`). Opening a conversation
returns its messages and a usage frame, and nothing carries a query-open fact at
all. So the fold cannot answer for a query that opened before the client looked,
and towerd has to carry that fact before the frontend can fold it.
