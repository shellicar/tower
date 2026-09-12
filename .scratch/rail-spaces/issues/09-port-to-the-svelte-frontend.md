# 09: Port the feature to the Svelte frontend

**What to build:** the whole feature, once, in the Svelte frontend, copied from a working
Rust implementation rather than built alongside it. Doing both frontends per ticket would
mean every correction landing twice, and the hand-mirrored types are safest copied from a
shape two compiled consumers have already agreed on.

**Seams:** the same scopes the ported tickets name, run once more for this frontend. The
model on its own, and the concern around it. The daemon over the socket is not repeated:
it is not per frontend.

**Frontend:** the Svelte frontend only. Everything it ports already works in Rust.

**Blocked by:** 08 (everything before it is being ported, so the last of it must land
first).

**Status:** ready-for-agent

- [ ] The view concern answers what is displayed in the space in front, and where a given
      conversation lives. No component reads the membership list directly.
- [ ] Each rail row shows the space its conversation lives in, and a conversation living
      nowhere shows nothing in that slot.
- [ ] A primary click goes to where a conversation lives and changes nothing else. A
      secondary click places it in the space in front and never removes.
- [ ] Minimise and restore work, restoring draws last, and a minimised conversation is no
      longer subscribed.
- [ ] The rail's scope narrows to the space in front or to the unplaced, travels with the
      reader, and is overridden by an id search.
- [ ] Spaces nest to any depth, and a space can be moved among its siblings.
- [ ] Both frontends now do the same thing, so nothing merges with one behind the other.
