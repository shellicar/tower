# 07: Spaces nest

**What to build:** a space can hold other spaces, so that organising by client and then by
project, or not, is a choice you make in the data rather than a change to the model.

**Seams:** the model on its own, for nesting to any depth. The daemon over the socket,
for a space's parent being stored.

**Frontend:** the Rust frontend only. The Svelte port is ticket 09.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] A space can hold other spaces, to any depth.
- [ ] The strip shows a space's children as things you can go into.
- [ ] Selecting a space draws the conversations placed in that space, not those placed
      beneath it.
- [ ] A space that has children can still hold conversations of its own.
- [ ] Nothing in the model counts levels or assumes a fixed depth.
