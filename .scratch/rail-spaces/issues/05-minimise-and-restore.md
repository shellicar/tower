# 05: Minimise and restore

**What to build:** a way to clear a conversation off the screen without taking it out of
its space, so a space can hold more than fits.

**Seams:** the model on its own, for minimise. The concern around it, for minimising
something stopping it being subscribed.

**Frontend:** the Rust frontend only. The Svelte port is ticket 09.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] The panel carries both controls: `–` minimises, and `×` takes the conversation out
      of its space.
- [ ] A minimised conversation keeps its space.
- [ ] Restoring brings it back onto the screen, drawn last among the others rather than
      returned to where it sat.
- [ ] A space showing nothing is an ordinary state, not an error or an empty-looking
      failure.
- [ ] A minimised conversation's content is no longer subscribed, so nothing streams for
      something nobody is drawing.
