# Resuming from the published record

## Where it stands

- **Not MVP.** Today a conversation resumes from Claude Code's own record on
  the machine that served it: the session store's `load()` returns null.
  Resuming from the bus (on another machine, say) comes later.
- **Publishing is a separate feature from resuming.** What is published has
  to be there when resume is built, so the publish rule (everything the model
  sees, [purpose.md](purpose.md)) applies now even though resume waits.
- **The goal is that a conversation resumed from the bus is the same
  conversation,** not a translated or migrated one. The bus is the
  conversation; anything else is migration. The goal may have to be relaxed to
  achieve something workable.
- **Resuming from Claude Code's transcript file is not the route.** Putting a
  transcript into an object store and resuming from that is a migration
  operation, available if ever needed.
- **Claude Code builds the request.** The store records the messages; loading
  from the store reads what was published, and Claude Code works out the
  rest.

The transcript file is an undocumented format, and Claude Code offers the
session store as its supported route.

## The test that counts

**When resuming, a resume from the published store and a resume from Claude
Code's own record must send the same request to the API: the same cache
prefix.** Both are compared after resuming. Comparing a request before a
resume with one after it is a different test, and not this one.

The proofs under Related proofs mostly compare the resumed request against
the live one, so their passes don't show this test is met. Each findings file
states which comparison it made.

**Undecided: how strict "the same" is.** Two readings: the requests are
identical (what is sent to the API is the same); or the conversation is the
same as resuming from the local transcript, with some differences not
holding up the MVP.

## What is known

- **A resume through a session store whose `load()` returns entries runs in
  a temporary config dir** the SDK makes (`<tmpdir>/claude-resume-<uuid>`).
  Claude Code then renders that path into generated blocks (the sandbox
  block, the safeguards block, and after `/compact` the memory directory in
  the system prompt). So no store resume can be byte-identical to a local
  one, and two store resumes can't match each other, by the SDK's
  construction. The participant controls the config dir, cwd and home, but no
  SDK option sets that temp dir. The participant's private home is random per
  process too, so even two local resumes differ in it.
- **The resume prototype** (branch `proof/resume-from-published`, unmerged)
  found that six of seven conversation shapes matched once four values were
  normalised away (device id, home path, prompt id, config dir path), and
  `/compact` didn't. Under "identical" no shape passes
  ([resume prototype](../participant-findings/resume-prototype.md)).
- **What a resume needs that isn't published today:** among others
  `message.id`, `message.model` (without it thinking is dropped silently),
  `requestId`, the typed attachment entries and their `rendered` blocks, the
  whole raw `system` entry, `origin`, and every non-message entry
  ([resume requirements](../participant-findings/resume-requirements.md),
  [minimum entries](../participant-findings/minimum-entries.md),
  [proof 14](../participant-findings/proof-14-pure-resume.md)).
- **Nothing pins publishing for resume.** `load()` returning null is pinned by
  a test; no test shows that what is published is enough to resume, so
  nothing stops a change to the publisher from breaking it.

## Related proofs

Proofs that resumed from published or reduced records:
[proof 8](../participant-findings/proof-08-resume-store.md),
[proof 9](../participant-findings/proof-09-resume-spec.md),
[proof 13](../participant-findings/proof-13-resume-cwd.md),
[proof 16](../participant-findings/proof-16-semantic-form.md),
[proof 20](../participant-findings/proof-20-body-copy.md),
[proof 24](../participant-findings/proof-24-next-query.md),
[the reconcile](../participant-findings/reconcile-tower-holding.md),
[the integration attempts](../participant-findings/integration-attempts.md),
[trailing thinking](../participant-findings/trailing-thinking.md).

## Open

- How strict "the same" is (above).
- Whose paths the published conversation holds, and whether a resume must
  run in a temporary config dir.
- How the missing data is carried (see [publishing.md](publishing.md),
  Extras).
- A test that pins what is published against what a resume needs.
