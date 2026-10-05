# How the participant is built

## The build

- **Fresh, not from the proof code:** correctness over speed. The proofs are
  reference; what they found is in [the findings](../participant-findings/).
- **Where it lives:** `mvp/apps/claude-code-participant`. Inside `mvp/`,
  projects group by language: Rust in `crates/`, TypeScript apps in `apps/`,
  TypeScript libraries in `packages/`, so each workspace entry is a glob.
  Nothing else has moved yet.
- **`@shellicar/core-di`,** its preview release, for dependency injection. Easy
  to remove later if it proves overkill; harder to add afterwards.
- **Abstract classes (`abstract class IThing`) where something crosses a
  boundary,** and only there: the store (it writes to NATS), anything that
  reads or writes a file, and Claude Code only if testing needs it. The
  session store hands entries to an abstract publisher. The process list is
  read behind one too, per platform.
- **Runs through `tsx`:** core-di uses TC39 decorators, which Node can't run
  from type-stripped `.mts`. No build step.
- **TypeScript 7** (the native compiler), accepted as long as it doesn't cause
  problems.
- **Tests on vitest 4,** which runs core-di's decorators; vitest 5 waits until
  it is checked with core-di.
- **Checks:** type checking, Biome and knip, from the start
  (`pnpm --dir mvp/apps/claude-code-participant lint`, `type-check`, `knip`,
  `test`).

## Tooling decisions

- **Biome is the linter and the formatter.** Its rules are `claude-cli`'s
  config plus `noUnusedFunctionParameters`, `noUnusedPrivateClassMembers` and
  `noUndeclaredDependencies`; `noExplicitAny` stays a warning, because `any`
  is needed as a generic constraint. Line width 320: some lines should be
  long and some short, and a wide limit stops the formatter wrapping
  everything that doesn't need it
  ([lint and format comparison](../participant-findings/lint-compare.md)).
  This replaces the older line that Biome was being compared against Oxlint
  and Oxfmt.
- **The official NATS client,** `@nats-io/transport-node` 3.4.0 and its
  `@nats-io/*` companions, never the deprecated `nats` package; issues get
  addressed as they come. The object store is written through `@nats-io/obj`.
- **zod** for control-line validation (the version the SDK already uses).
- **pnpm 12,** tried here as a test bed. Dependencies change only through pnpm
  commands (`pnpm install`, `pnpm add`); `packageManager` is set directly.
  `package.json` dependency lists are never edited by hand.
- **No exceptions for packages' build scripts** in the workspace's hardening;
  where something breaks, note it and find out what the script does.
- **Node 26,** pinned by major only in `.node-version` (which replaced
  `.nvmrc`); CI follows `.node-version`.
- **Agent SDK `^0.3.285`.**
- **A new dependency is a decision** (CLAUDE.md, Dependencies).

## Keeping Claude Code current (after the MVP)

Wanted: a participant that updates itself, since Stephen is the main user and
manual releases were painful for claude-sdk-cli. Two routes to investigate:
using the installed Claude Code, or updating the SDK automatically (a release
on a version bump or nightly, the SDK bumped in its own PR, the running
participant detecting the update), the second only with tests covering the
behaviour. CI doesn't check the participant today, and it would need to before
any of this ([participant updates](../participant-findings/participant-updates.md)).

## Conventions

- **The agents' own sandbox** (signing, docker, refusals) is described in
  [agent sandbox](../participant-findings/agent-sandbox.md) and CLAUDE.md.
- **Research code goes to the remote as `feature/research/...`;** it is code,
  not docs.
- **Fix only what the participant needs;** note and park the rest.

## Open

- **Dependabot, owed before the epic reaches main.** pnpm 12's two-document
  lockfile blinds GitHub's dependency graph and would close existing alerts
  unfixed. Options: accept it, set `pmOnFail: ignore`, or stay on pnpm 11.
- CI running the participant's checks.
