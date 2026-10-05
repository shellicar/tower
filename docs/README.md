# Tower's documentation: start here

Tower is the one place to see and drive Stephen's fleet of AI conversations:
a NATS bus with a spec as the only coupling (`docs/spec/`), `towerd` and two
browser frontends (`mvp/`), and agents that serve conversations on the bus.
The work in progress is the **Claude Code participant**
(`mvp/apps/claude-code-participant`, branch `epic/claude-code-participant`).

## The participant in brief

- **What it is for:** Claude Code joins the bus as one more participant
  through the Agent SDK. Claude Code is the harness, tower the interface, the
  bus the seam: Claude Code's features without rebuilding them, so the effort
  goes into presentation.
- **The publish rule:** everything the model sees must be published. That is
  the minimum, because a conversation that wasn't published can't be
  reproduced. Beyond it nothing is decided, except that what the user needs to
  see is published too.
- **Where it is:** v0 is reached (driving a conversation from tower). The goal
  now is the MVP: Stephen using it every day instead of the terminal, with no
  scripts outside tower.

## Constraints

- No ambient configuration: everything that changes the outcome is declared,
  nothing is defaulted, nothing comes from the user's own Claude Code setup.
- Trial runs use the test broker (31416), never the live one (4222).
- Linux and macOS; Windows later.
- Fix only what the participant needs; park the rest.
- Stephen makes every design decision. What is open in these docs is open:
  don't build it as if decided.

## Where each area stands

| Area | Stands | File |
|---|---|---|
| Purpose, goals, the publish rule | Decided; model-seen kinds still unpublished | [purpose](participant/purpose.md) |
| Scope: v0, the MVP, the order of work | MVP list set; 5 of 16 items built, one of them partly | [scope](participant/scope.md) |
| How it runs Claude Code | Built | [running](participant/running.md) |
| Configuration and the login | Built; some send-it-only rules open | [configuration](participant/configuration.md) |
| Presence and the requests | Built; `chdir`, model on `service`, the premise not | [presence](participant/presence.md) |
| Serving from tower | MVP, not built | [serving-from-tower](participant/serving-from-tower.md) |
| What is published | Built, short of the rule | [publishing](participant/publishing.md) |
| Delivery to the stream | Built; over 1 MB is MVP, not built | [delivery](participant/delivery.md) |
| Object stores, files, images | Durable store built; sending images MVP | [object-stores](participant/object-stores.md) |
| Shutdown, leftovers, platforms | Built; Claude Code exiting on its own is MVP | [shutdown](participant/shutdown.md) |
| Subagents | Cancel and shutdown built; metrics and stop MVP | [subagents](participant/subagents.md) |
| Skills | MVP, not built; route open | [skills](participant/skills.md) |
| Approvals | MVP, not built; design open | [approvals](participant/approvals.md) |
| Errors and logging | Decided in direction, not designed | [errors](participant/errors.md) |
| Resuming from the bus | Not MVP; the test that counts is set | [resume](participant/resume.md) |
| Building, tooling, dependencies | Built; Dependabot owed | [building](participant/building.md) |
| Spec and frontend changes | Done and owed lists | [spec-and-frontend](participant/spec-and-frontend.md) |
| The driving scripts | Built | [kit](participant/kit.md) |

Every proof and investigation behind these is in
[participant-findings](participant-findings/README.md), with its method,
versions, runs and what it found.

## The biggest open questions

- Whether publishing everything the model sees is itself an MVP item, and
  how the unpublished kinds are carried.
- How strict "the same request" is for a resume from the bus.
- The skills route, the approvals design, the error message on the wire.
- Rules that rest only on a brief being sent: one key per control line, the
  reply to a blank line, `claudeSettings` checked only on the keys acted on,
  no migration of transit history, "tower is the authority".

## The rest of the documentation

- `docs/spec/`: the wire contract, reference only (`docs/spec/README.md`).
- `mvp/docs/`: towerd's design and its browser contract, bridge's stdio spec,
  deployment.
- `docs/design/`: live design work beyond the participant (`landscape.md`,
  `lookout.md`). `docs/design/claude-code-participant.md` now only points
  here.
- `docs/planning/`: the earlier design corpus; `docs/roadmap.md`,
  `docs/glossary.md`.

Each of these files describes its area as it is now, with the reason for
each thing. When work changes an area, the file for that area changes with
it.
