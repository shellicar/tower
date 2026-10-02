#!/bin/sh
# Runs the proof under `just broker-run`; the cd is in a subshell so the
# recipe's teardown keeps its own working directory.
set -eu
(
  cd /home/stephen/repos/@shellicar/tower/.claude/worktrees/agent-a2b22c06e16cbb503/mvp/apps/claude-code-participant
  exec node --import tsx proof/run.ts
)
