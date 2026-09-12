# 04: Clicking a row goes to where it lives

**What to build:** the payoff. See a conversation in the rail, click it, and land where it
lives. Filing becomes its own deliberate gesture rather than a side effect of looking.

**Seams:** the model on its own, for where a conversation resolves to. The concern around
it, for an operation producing the right outbound message.

**Frontend:** the Rust frontend only. The Svelte port is ticket 09.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] A primary click on a rail row selects the space that conversation lives in and
      brings its panel into view.
- [ ] A primary click changes nothing else. It is safe to do without thinking.
- [ ] A conversation living nowhere offers no navigation at all.
- [ ] A secondary click places the conversation in the space in front. It never removes:
      already there it does nothing, anywhere else it moves here.
- [ ] Placing it moves it out of whatever space it was in, and the row shows that
      immediately.
- [ ] The browser's own menu stays reachable behind a modifier.
