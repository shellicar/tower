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
- `preview-conversation.ts` publishes a finished Claude Code session into the
  preview environment as the participant would have published it (see
  below).
- The check scripts (`outbox-check`, `bus-check`, `publisher-check`,
  `shutdown-check`, `live-check`, `author-check`) exercise pieces against the
  test broker.

Each script that reaches the broker needs `NATS_URL` given explicitly (or in
the app's optional `.env`), so it never defaults to the live broker.

## What `start.ts` declares

- model `claude-sonnet-5-5`;
- max tokens 120000 (provisional);
- effort `medium` (the docs say Sonnet 5.5 defaults to high, Claude Code says
  medium);
- thinking `adaptive`, displayed `summarized`;
- permission mode `auto`;
- system prompt: the preset, with nothing appended;
- Claude Code's sandbox on, through `claudeSettings`
  (`sandbox.enabled`, `autoAllowBashIfSandboxed`);
- world `claude-code` (more agents in a world later, named like `agent1`);
- config dir `${XDG_DATA_HOME:-~/.local/share}/tower/worlds/<world>`;
- the durable bucket defaults to `durable`, and the macOS login dir to
  `${XDG_DATA_HOME:-~/.local/share}/tower/login`.

A script may default these; the participant itself never does.

## Publishing a past session into preview

With the preview broker up and towerd running against it (the steps are in
[deployment.md](../../mvp/docs/deployment.md), Preview environment), from
`mvp/apps/claude-code-participant`:

```sh
NATS_URL=nats://127.0.0.1:31417 node --env-file-if-exists=.env --import tsx scripts/preview-conversation.ts <session id>
```

The session id is the name of the transcript file under
`${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project>/`, without `.jsonl`.
`NATS_URL` must be exactly `nats://127.0.0.1:31417`: unset or anything else,
the script exits 2 without publishing.

It reads the transcript through the Agent SDK's `importSessionToStore` and
hands each entry to the participant's publisher (`ConversationChanges`), so
what reaches the stream is what the participant's publishing path produces,
under a new conversation id it prints. Each run is a new conversation. It
prints how many messages the stream took, and each place where the messages'
`ts` order and their publish order disagree. Files go to the `durable`
bucket. The outbox is a temporary directory, removed once everything is
delivered; when something isn't, the script names the directory and exits 1.

How it differs from serving live, each undecided and built this way for now:

- every entry the participant classifies as a prompt opens a query of its own
  and carries `from: {kind: "human"}`; live, a query opens with a say, and
  only its first prompt carries the say's `from`;
- no query closure is published, because a transcript doesn't say how a
  query ended;
- no `attached` or `detached` is published, and the messages name an instance
  id minted for the run;
- a session id found in more than one project directory is refused.

The stream drops a message whose id it has stored within its duplicate
window (two minutes unless the stream says otherwise), and a message's id is
its entry's uuid, so a second run of the same session inside that window
publishes nothing new.

Run on Linux (WSL2) only so far. On macOS, check that an unset `NATS_URL` is
refused and that one run against the preview broker shows in tower.

## Open

Undecided, each built one way for now: the participant runs `detached` from
the script (one Ctrl-C is one shutdown stage; Ctrl-Z stops only the script);
the script exits with the participant's code or 128 plus the signal; a
refused line closes stdin and exits 1; a rejected reply exits 0; a say
carries `from: {kind: "human"}`; `service` carries no `from`; a 30 s request
timeout.

Every say after the first needs the tip, which the kit doesn't print.
