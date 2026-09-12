# 08: Reordering spaces

**What to build:** move a space among its siblings. Today the only way is to close it and
recreate it, and this feature turns that from tedious into destructive, because closing a
space now releases everything in it.

**Seams:** the model on its own, for sibling order. The daemon over the socket, for the
order being part of the stored arrangement.

**Frontend:** the Rust frontend only. The Svelte port is ticket 09.

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] A space can be moved among its siblings without being closed and recreated.
- [ ] Moving is reachable from the keyboard, so moving a space several places is one
      gesture held rather than several clicks chased across a moving target.
- [ ] The order is part of the arrangement, so every client sees the same one.
- [ ] Nothing placed in the space is affected by moving it.
