# 06: The rail's scope

**What to build:** the rail can narrow to one space, or to everything living nowhere, so
that unfiled work becomes a queue you can work down rather than a state you notice.

**Seams:** the model on its own. The rail's scope and where a conversation resolves to are
both inside it.

**Frontend:** the Rust frontend only. The Svelte port is ticket 09.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] The rail can show every conversation, only those placed in the space in front, or
      only those placed nowhere.
- [ ] Under the current space's scope, each row shows whether its conversation is drawn or
      minimised, and can be restored from there.
- [ ] A search by conversation id overrides the scope, the same way it already overrides
      every other filter.
- [ ] The scope travels with the reader rather than being held per space, so walking into
      a space never silently changes what the rail is showing. It stays with the client
      rather than being part of the shared arrangement.
