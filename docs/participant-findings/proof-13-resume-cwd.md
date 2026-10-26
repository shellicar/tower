# Proof 13: resuming after a cwd change

**Question.** How a resume behaves after `set_cwd`, and whether a cwd change
should persist (it isn't strictly part of the conversation, but tool use only
makes sense with it).

**Versions.** Agent SDK 0.3.282, Claude Code 2.1.282.

**Runs.** 15, on Sonnet 5, one sample per condition. Branch
`proof-13-resume-cwd` (83d760b, b4e427e).

**Found.**
- The SDK's `cwd` option decides where a resumed Claude Code runs; the
  recorded cwd only changes what the model is told ("# Environment update ...
  (was B)").
- Resumed from tower's messages only, the model believed it was in B while in
  A (2 of 2).
- A file store keyed by project (from the cwd) splits the conversation at
  `set_cwd`, and a resume silently loads half.
- Folder knowledge comes from the `isMeta` cwd notice and the environment
  attachments; restoring the environment entries fixed it.
- Cache: a tower-only resume differs at `messages[0]`, so only tools and the
  system prompt are reused. Every resume starts a new server-side thread. The
  first request of each process carries only Bash. (Proof 14 later found its
  full-record resume also reused everything only from the second request.)

**Resume comparison.** Mostly the resumed request against the seed's last
request (before against after); it also contrasted full-record and
tower-only resumes, each scored against the seed.
