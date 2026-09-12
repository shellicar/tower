# 02: Prefactor, the displayed set

**What to build:** the concerns answer the two questions their components currently answer
for themselves, so that splitting membership from visibility later doesn't leave every
reader ambiguous. Nothing a user can see changes.

**Seams:** the concern around the model. The existing concern test files, constructed with
no DOM, asserting on what the concern reports.

**Frontend:** the Rust frontend only. The Svelte port is ticket 09.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The view concern answers what is displayed in the space in front.
- [ ] It answers where a given conversation lives.
- [ ] No component reads the membership list directly any more.
- [ ] The count of unread per space, currently folded from two concerns inside a
      component, moves out of the component.
- [ ] Behaviour is unchanged and the existing tests pass untouched.
