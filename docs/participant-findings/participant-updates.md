# Keeping the participant and Claude Code current

**Question.** How the participant could keep Claude Code current, release
itself, and update itself.

**Method.** Docs and code research; no runs. Code on branch
`feature/research/participant-updates`.

**Versions.** Claude Code 2.1.285 (installed and bundled); Agent SDK pinned
`^0.3.285`, 0.3.287 the latest at the time.

**Found.**
- CI never checks the participant (only cargo and frontend-svelte), and every
  CI trigger is on main, where the participant isn't yet, so an update PR
  would pass unchecked.
- After a restart nothing re-serves.
- Route 1, the installed Claude Code through `pathToClaudeCodeExecutable`:
  documented only as a fallback; the SDK version tracks its bundled Claude
  Code, with no version check; `sessionStore` is alpha (`--session-mirror`,
  `transcript_mirror`), so drift could silently stop entries reaching tower;
  the installed 2.1.285 was byte-identical to the bundled one; updates take
  effect on the next spawn, so versions mix; `login.ts` would still use the
  bundled binary.
- Route 2, updating the SDK: Dependabot would open 0.3.x patch PRs (0.4 is
  blocked by the minor-version ignore and `^0.3.285`); pnpm's 24 h minimum
  age keeps it behind; Renovate or a scheduled workflow are alternatives
  (signed commits; PRs made with `GITHUB_TOKEN` don't trigger checks).
  Releases today build artifacts only, cut by hand. Bundling is held back by
  the 240 MB Claude Code binary.
- Self-updating: side-by-side versions plus a pointer, or pulling in place;
  one config dir allows only stop-then-start (the sqlite lock); `start.ts`
  could become the supervisor; a restart cuts a turn and detaches every
  conversation until re-served.
- Tests run against fakes (fixtures from 2.1.283); nothing catches behaviour
  changes behind unchanged types, env var names, transcript layout or
  settings keys.
- The SDK's manifest tests 2.1.285 only up to 0.3.282. Main was on pnpm
  11.17, the epic on 12.6.

**Resume comparison.** Not applicable.

**Used by.** [building.md](../participant/building.md), Keeping Claude Code
current.
