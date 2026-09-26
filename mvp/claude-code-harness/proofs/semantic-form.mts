// Proof 16: publish the conversation as the model received it, and resume
// from it. Modes are listed at the bottom; see the README section.
import { checkRun, report } from './semantic/check.mts';

const [mode, ...rest] = process.argv.slice(2);
if (mode === '--corpus') {
  for (const dir of rest) {
    process.stdout.write(report(checkRun(dir)));
  }
} else {
  process.stderr.write('usage: node proofs/semantic-form.mts --corpus <run dir>...\n');
  process.exitCode = 2;
}
