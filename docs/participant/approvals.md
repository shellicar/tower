# Approvals (MVP)

This file covers what is decided for approvals and where they stand. The
`permissionPrompts` setting is in [configuration.md](configuration.md);
tower's approval contract is `docs/spec/approval.md`.

## Decided

- **Approvals are part of the MVP.** They are not the top priority.
- **Each ask only has to work in one place:** answers on the bus and in a
  terminal aren't reconciled.

Even in auto mode, Claude Code escalates repeated denials to the user, so
something has to answer them.

## Where it stands

Not built. Claude Code runs with `permissionPrompts: 'none'`, so nothing
answers a permission prompt: whatever the mode, rules and hooks don't allow is
denied.

Tower already has the approval concern (`docs/spec/approval.md`: raised,
settled, heartbeat, the approvals view, `answer`). For Claude Code, asks come
through the SDK's `canUseTool`, not through a tool layer as in bridge.

Whatever answers approvals can also add directories live through
`canUseTool`'s `updatedPermissions`, and a live permission change replaces
the whole permissions object rather than merging
([defaults survey](../participant-findings/defaults-survey.md)).

## Open

Undecided: the whole design.
