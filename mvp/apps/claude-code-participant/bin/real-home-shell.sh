#!/bin/sh
# Claude Code's CLAUDE_CODE_SHELL_PREFIX. Claude Code runs each shell command
# it starts (Bash tool calls, hooks, stdio MCP server start-up) as
# `<this file> '<command line>'`. The participant gives Claude Code a private
# HOME for its own machinery; this runs the command with the real HOME, which
# the participant passes in TOWER_REAL_HOME.
HOME="$TOWER_REAL_HOME" exec bash -c "$1"
