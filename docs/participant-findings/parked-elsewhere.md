# Problems found outside the participant, parked

Found while building the participant, outside what it needs, so noted and
not fixed.

## Bridge

- A failed publish is swallowed: it is logged while the model already has
  the message (`agent.rs`, around lines 198 to 203).
- Bridge never checks message size. Its ReadFile inlines images and documents
  as base64 (up to 20 MB) into the tool result; a publish over the broker's
  `max_payload` fails in the client, is logged and dropped, while bridge's
  history moves on (`agent.rs` 184 to 205, `readfile.rs` 17). Its Ref tool
  covers only string results over 16 KB.
- Bridge commits transit references rather than storing in the durable
  store, so it doesn't comply with the durable spec (accepted). The spec's
  removed no-bucket fallback was never in bridge's code.

## Towerd and the frontends

- Towerd can't serve durable objects (see
  [towerd durable fetch](towerd-durable-fetch.md)).
- A row's last kind shows "query" for a `query.closed`.
- Unread is minted for any assistant message, synthetic ones included;
  ordering by `ts` has no tie-break (see [extras design](extras-design.md)).
- For a `from` with neither `userId` nor `kind`, Leptos falls back to the
  role while Svelte returns undefined.

## Deployment

- `mvp/docs/deployment.md`'s update trigger doesn't cover the `attach` row
  (widen it, keep it, or reduce it).

## Tooling

- Stephen's request-logging proxy (`mitm-md.mjs`) split multibyte characters
  and caused cut-off 400 responses; fixed locally, not committed.
- pnpm 12: `pnpm --version` writes the lockfile; a pnpm-11 lockfile fails a
  frozen install under 12; the hash in `packageManager` covers only the
  launcher, and CI never checks it; the store path stays `v11`.
- Node 25 and later: Node's own `localStorage` shadows jsdom's under vitest
  4.1.11.
- vitest 4.1 picks its agent reporter by itself under `CLAUDECODE` or
  `AI_AGENT`; pnpm 12 has no `-s`, and only `--loglevel=silent`,
  `--reporter=silent`, the environment variable or `loglevel: silent` in the
  workspace remove its `$` line.
- Machine constraints: SentinelOne (on other machines) kills node when its
  last command-line argument is about 974 characters or more; `ps` and
  `pgrep` have hung on stuck processes; the global gitignore ignores `*.log`;
  pnpm's `minimumReleaseAge` is 1,440 minutes.
