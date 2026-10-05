# The driving kit

Scripts in `mvp/apps/claude-code-participant/scripts/` that drive the
participant from a terminal. How to run them is in CLAUDE.md
(claude-code-participant).

- `start.ts` starts the participant configured and keeps it running. Each
  line typed in its terminal is forwarded to the participant's stdin (control
  lines) and the reply is printed; end of input (Ctrl-D) closes the
  participant's stdin, which starts its shutdown.
- `new-conversation.ts` sends `service` for a new conversation in a given cwd,
  always with a fresh id.
- `say.ts` says into a conversation.
- `login.ts` (`pnpm claude-login`) makes the macOS login once.
- The check scripts (`outbox-check`, `bus-check`, `publisher-check`,
  `shutdown-check`, `live-check`, `author-check`) exercise pieces against the
  test broker.

Each script that reaches the broker needs `NATS_URL` given explicitly (or in
the app's optional `.env`), so it never defaults to the live broker.

## What `start.ts` declares

These are Stephen's, except where marked:

- model `claude-sonnet-5-5`;
- max tokens 120000 (Claude's proposal, from bridge's example, never changed
  by him);
- effort `medium` (the docs say Sonnet 5.5 defaults to high, Claude Code says
  medium);
- thinking `adaptive`, displayed `summarized`;
- permission mode `auto`;
- system prompt: the preset, with nothing appended;
- Claude Code's sandbox on, through `claudeSettings` for now
  (`sandbox.enabled`, `autoAllowBashIfSandboxed`);
- world `claude-code` (more agents in a world later, named like `agent1`);
- config dir `${XDG_DATA_HOME:-~/.local/share}/tower/worlds/<world>`;
- the durable bucket defaults to `durable`, and the macOS login dir to
  `${XDG_DATA_HOME:-~/.local/share}/tower/login`.

A script may default these; the participant itself never does.

## Open

Builder choices nobody ruled on: the participant runs `detached` from the
script (one Ctrl-C is one shutdown stage; Ctrl-Z stops only the script); the
script exits with the participant's code or 128 plus the signal; a refused
line closes stdin and exits 1; a rejected reply exits 0; a say carries
`from: {kind: "human"}`; `service` carries no `from`; a 30 s request timeout.
Every say after the first needs the tip, which the kit doesn't print.
