// Proof 20: copying the conversation from the request body (approach A), on
// every model, with the main conversation's requests found by their history,
// retries and aborts made on purpose, and resumes from what A published.
// Code: semantic/live20.mts (runs), semantic/select.mts (the selector),
// semantic/by-body.mts (A), semantic/form.mts (load()), semantic/faults.mts
// (the tunnel and the OTEL receiver), semantic/report20.mts (reports).
//
// From mvp/claude-code-harness/:
//   node proofs/body-copy.mts seed <model> <main|limit>
//   PROOF20_FIRST_DELAY_MS=20000 node proofs/body-copy.mts resume <model> <full|A|A-silent|A-silent-sc> <sessionId>
//   node proofs/body-copy.mts --seed-report <seed run dir>
//   node proofs/body-copy.mts --resume-report <full resume run dir> <other resume run dir>...
//   node proofs/body-copy.mts --history <seed run dir> <resume run dir>...

import { resume, SOURCES, type Source, seed } from './semantic/live20.mts';
import { historyReport, resumeReport, seedReport } from './semantic/report20.mts';

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'seed' && rest.length === 2) {
  await seed(rest[0] as string, rest[1] as string);
} else if (mode === 'resume' && rest.length === 3 && (SOURCES as readonly string[]).includes(rest[1] as string)) {
  await resume(rest[0] as string, rest[1] as Source, rest[2] as string);
} else if (mode === '--seed-report' && rest[0]) {
  process.stdout.write(seedReport(rest[0]));
} else if (mode === '--history' && rest.length >= 2) {
  process.stdout.write(historyReport(rest[0] as string, rest.slice(1)));
} else if (mode === '--resume-report' && rest.length >= 2) {
  process.stdout.write(resumeReport(rest));
} else {
  process.stderr.write('usage: see the header of proofs/body-copy.mts\n');
  process.exitCode = 2;
}
