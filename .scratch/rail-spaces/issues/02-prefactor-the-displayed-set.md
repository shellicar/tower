# 02: Prefactor, the displayed set

**What to build:** the concerns answer the two questions their components currently answer
for themselves, so that splitting membership from visibility later doesn't leave every
reader ambiguous. Nothing a user can see changes.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Each frontend's view concern answers what is displayed in the space in front.
- [ ] Each answers where a given conversation lives.
- [ ] No component reads the membership list directly any more.
- [ ] The count of unread per space, currently folded from two concerns inside a
      component, moves out of the component.
- [ ] Behaviour is unchanged and the existing tests pass untouched.
- [ ] Done in both frontends.
