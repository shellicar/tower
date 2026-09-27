#!/bin/sh
# Proof 26's CLAUDE_CODE_SHELL_PREFIX. Claude Code runs each shell command it
# spawns (Bash tool calls, hooks, status line, stdio MCP server start-up) as
# `<this file> '<command line>'` (env-vars docs). This runs that command line
# with HOME set back to the real home, which the proof passes in
# P26_REAL_HOME. The first line of the log records that the prefix ran and
# with which HOME; the command line itself is not recorded.
if [ -n "$P26_PREFIX_LOG" ]; then
  echo "prefix ran: HOME was $HOME, now $P26_REAL_HOME" >> "$P26_PREFIX_LOG"
fi
HOME="$P26_REAL_HOME" exec bash -c "$1"
