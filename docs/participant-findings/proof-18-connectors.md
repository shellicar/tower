# Proof 18: keeping the account's connectors out

**Question.** What the claude.ai connectors are, how they arrive, and how to
keep them out.

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 108, on Sonnet 5, per-run config dirs. Branch `proof-18-connectors`
(0b644c4 to ea84b54).

**Found.**
- They arrive through the login: `api.anthropic.com/v1/mcp_servers`, through
  `mcp-proxy`. Here: Claude Docs, Gmail, Google Calendar, Google Drive.
- Ways that work: `ENABLE_CLAUDEAI_MCP_SERVERS=false`;
  `settings.disableClaudeAiConnectors: true` (works under `[]`);
  `managedSettings`; `strictMcpConfig`; `deniedMcpServers`;
  `allowedMcpServers: []` (drops your own servers too);
  `CLAUDE_CODE_SAFE_MODE`; `toggleMcpServer` (persists in `.claude.json`).
- Cache: without tool search, connector tools join mid-conversation, so the
  first request after a resume misses the cache; with connectors out it hits.
  With tool search on, no miss either way.
- An unexplained difference in how often the account-email reminder
  appeared (5 of 5 against 21 of 33).

**Resume comparison.** Not a request comparison; it measured the cache on the
first request after a resume, with and without connectors.

**Used by.** [configuration.md](../participant/configuration.md): connectors
off by default, through the setting so `claudeSettings` can turn them back
on.
