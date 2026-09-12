# 01: Spike, the demo

**What to build:** a throwaway app that makes the model real enough to judge by using it,
at the scale you actually work at, and that ends by recording the shape the client needs
handed to it.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The rail, the space strip and a panel row render against a fixture taken from a
      snapshot of the live database, at full scale rather than with a handful of rows.
- [ ] The model is a plain class with no framework, no transport and no storage:
      operations in, queries out.
- [ ] Placing, unplacing, minimising, restoring, selecting a space and changing the rail's
      scope all work for real against that class.
- [ ] Exclusivity holds: placing a conversation somewhere removes it from where it was.
- [ ] The arrangement has been used enough to say whether it reads at full scale.
- [ ] The shape the model needs handed to it is written into the browser contract as the
      layout frame and the write message.
- [ ] The class is left in a state the implementation can adopt.
