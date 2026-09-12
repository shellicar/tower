# 03: A conversation has a place, and the rail shows it

**What to build:** conversations live in spaces, one space each, and every row in the rail
says where its conversation lives or that it lives nowhere.

**Blocked by:** 01 (the frame shape comes from the spike), 02 (the concerns must answer
the displayed-set question first).

**Status:** ready-for-agent

- [ ] The daemon stores spaces, each with a name, a parent and a position among its
      siblings, and placements keyed by layout and conversation.
- [ ] Placing a conversation in a space removes whatever placement it had. This is a
      constraint the store enforces, not a rule the clients agree to keep.
- [ ] Deleting a space leaves the conversations that were in it placed nowhere.
- [ ] No space is created by default, a space may hold nothing, and having no spaces at
      all is a legal state.
- [ ] The layout frame and the write message carry spaces and placements in the shape the
      contract specifies.
- [ ] Each rail row shows the space its conversation lives in.
- [ ] A conversation living nowhere is marked so that it stands out rather than simply
      lacking a chip.
- [ ] Placing a conversation is reachable from outside the browser.
