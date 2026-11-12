# What Claude Code sends by default

**Question.** Every field Claude Code sends: its default, where the default
comes from, how to set it, whether it can change live; and whether to require
each one or allow the default.

**Method.** 471 captured requests from the proof worktrees, the 2.1.282
binary, and public docs. Branch `defaults-survey`.

**Versions.** Claude Code 2.1.282 (Agent SDK 0.3.282).

**Found.**
- **model:** an account, org and server chain; Opus 5.5 on subscriptions since
  2.1.280. Set by the SDK `model`, env or settings; live through `setModel`.
- **switching model on a flagged request:** on; re-runs on Opus 5 or 4.8;
  `switchModelsOnFlag`.
- **max tokens:** Sonnet 5 64k then 128k (an account experiment), Opus 5.5
  128k, Fable 5.1 64k, Haiku 4.5 32k; only `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, no
  SDK option.
- **thinking:** adaptive with display `updates` (a beta, undocumented) on 5.x
  models; Haiku a 31,999 budget.
- **effort:** Sonnet 5 high, Opus 5.5 medium, Fable 5.1 high, Haiku none.
- **cache TTL:** main 1 h, subagents 5 m; flips with usage-limit state.
- **system prompt:** none set gives one line; the preset is about 28k chars;
  fixed at start.
- **tools:** the full set plus claude.ai connectors, even with
  `settingSources: []`; fixed at start.
- **advisor:** on for Opus 5.5 and Fable 5.1 through an account flag, model
  Fable 5.1.
- **safeguards:** plan mode sends a classifier context with the cwd, home, OS
  user and git details.
- Also sent, all fine to leave: the attribution header, tool entry fields,
  fast mode, temperature, context management, betas, output format.
- Injected, not configuration: the environment block and a token countdown
  (server-controlled); a side request for the session title on Haiku 4.5.
  Subagents inherit the model with a 5 m cache.
- **Additional working directories, the routes:** SDK
  `additionalDirectories` (at start, documented);
  `settings.permissions.additionalDirectories`;
  `applyFlagSettings({permissions: {additionalDirectories}})` (live next
  turn, replacing the whole permissions object); `canUseTool`'s
  `updatedPermissions`; `/add-dir` isn't available in SDK sessions;
  `register_repo_root` (undocumented).
- Risks: whatever answers approvals can add directories live; live
  permission changes replace rather than merge; plan mode sends identity
  details; a documentation subagent misreported 17 env vars.

**Resume comparison.** Not about resume.

**Used by.** [configuration.md](../participant/configuration.md): the
required fields and what is allowed to default are Stephen's decisions,
made from this survey.
