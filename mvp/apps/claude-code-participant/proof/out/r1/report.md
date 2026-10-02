# Resume comparison, run r1

Reference: the `local` method (Claude Code reads its own record). Each other method is compared with it, request for request.

## text

- `local`: same (the reference)
- `local2`: differs
    - safeguards.0.classifier_context.git_state.root: null vs "/home/stephen/repos/@shellicar/tower/.claude/worktrees/agent-a2b22c06e16cbb503"
    - safeguards.0.classifier_context.git_state.branch: null vs "proof/resume-from-published"
    - safeguards.0.classifier_context.git_state.default_branch: null vs "main"
    - safeguards.0.classifier_context.git_state.status: null vs {"clean":false,"counts":{"staged":0,"modified":9,"untracked":null,"untracked_normal":3},"porcelain":null,"truncated":false}
- `raw`: differs
    - safeguards.0.classifier_context.git_state.root: null vs "/home/stephen/repos/@shellicar/tower/.claude/worktrees/agent-a2b22c06e16cbb503"
    - safeguards.0.classifier_context.git_state.branch: null vs "proof/resume-from-published"
    - safeguards.0.classifier_context.git_state.default_branch: null vs "main"
    - safeguards.0.classifier_context.git_state.status: null vs {"clean":false,"counts":{"staged":0,"modified":9,"untracked":null,"untracked_normal":3},"porcelain":null,"truncated":false}
- `raw@`: differs
    - safeguards.0.classifier_context.git_state.root: null vs "/home/stephen/repos/@shellicar/tower/.claude/worktrees/agent-a2b22c06e16cbb503"
    - safeguards.0.classifier_context.git_state.branch: null vs "proof/resume-from-published"
    - safeguards.0.classifier_context.git_state.default_branch: null vs "main"
    - safeguards.0.classifier_context.git_state.status: null vs {"clean":false,"counts":{"staged":0,"modified":9,"untracked":null,"untracked_normal":3},"porcelain":null,"truncated":false}

