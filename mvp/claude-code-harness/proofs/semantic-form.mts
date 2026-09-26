// Proof 16: what it takes to publish the conversation as the model received
// it (one conv.v2 changes.message per API message, with Claude Code's typed
// attachment objects on the message they belong to), and to resume from it.
// Two ways to get the form, both built:
//   A  from the request body (semantic/by-body.mts)
//   B  by reimplementing Claude Code's fold (semantic/by-fold.mts)
// Shared shape and load(): semantic/form.mts. Live runs: semantic/live.mts.
//
// Modes (from mvp/claude-code-harness/):
//   seed <model> <main|dup|types>
//       One live run; both approaches publish to tower's test broker, each
//       onto its own conversation. Records signals.jsonl (what each approach
//       placed, and when) and timing-A/B.jsonl.
//   resume <model> <full|full-fold-true|full-no-snapshot|A|B> <sessionId>
//       Resume through the session store from Claude Code's full record
//       (optionally with prompt_snapshot's reminderFold flipped, or every
//       prompt_snapshot removed) or from one tower conversation alone.
//       PROOF16_FIRST_DELAY_MS waits before the first prompt (proof 14: the
//       account's connectors join the tool list late).
//   --compare <run dir> <run dir>...
//       The runs' first main-thread requests, piece by piece against the
//       first run's, with cache numbers.
//   --corpus <run dir>...
//       Offline: A and B against every logged request of each run.
//   republish <seed run dir>
//       Build both approaches' forms again from the recorded run (A from the
//       logged bodies, B from the entries), with the no-block attachments,
//       onto fresh tower conversations; the seed record then points there.
//   --live <seed run dir>
//       What each approach published in a seed run against the bodies, and
//       the timing.

import { compare, liveReport } from './semantic/compare.mts';
import { checkRun, report } from './semantic/check.mts';
import { republish, resume, SOURCES, type Source, seed } from './semantic/live.mts';

const [mode, ...rest] = process.argv.slice(2);
const usage = `usage:
  node proofs/semantic-form.mts seed <model> <main|dup|types>
  node proofs/semantic-form.mts resume <model> <${SOURCES.join('|')}> <sessionId>
  node proofs/semantic-form.mts --compare <run dir> <run dir>...
  node proofs/semantic-form.mts --corpus <run dir>...
  node proofs/semantic-form.mts --live <seed run dir>`;

if (mode === '--corpus') {
  for (const dir of rest) {
    process.stdout.write(report(checkRun(dir)));
  }
} else if (mode === '--compare' && rest.length >= 2) {
  process.stdout.write(compare(rest));
} else if (mode === '--live' && rest[0]) {
  process.stdout.write(liveReport(rest[0]));
} else if (mode === 'republish' && rest[0]) {
  await republish(rest[0]);
} else if (mode === 'seed' && rest.length === 2) {
  await seed(rest[0] as string, rest[1] as string);
} else if (mode === 'resume' && rest.length === 3 && (SOURCES as readonly string[]).includes(rest[1] as string)) {
  await resume(rest[0] as string, rest[1] as Source, rest[2] as string);
} else {
  process.stderr.write(`${usage}\n`);
  process.exitCode = 2;
}
