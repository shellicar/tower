// Proof 24: which model names setModel() accepts (for an API-error ending
// that only step 1 hits). No prompt is sent.
import { startRun } from '../../src/harness.mts';
const names = process.argv.slice(2);
const run = startRun({ name: 'p24-setmodel', options: { model: 'claude-haiku-4-5', settings: { disableClaudeAiConnectors: true } } });
const models = await run.query.supportedModels();
console.log('supported', models.map((m) => m.value).join(' '));
for (const n of names) {
  try {
    await run.query.setModel(n);
    console.log('accepted', n);
  } catch (err) {
    console.log('refused', n, String(err).slice(0, 120));
  }
}
run.end();
try { await run.done; } catch (err) { console.log('done error', String(err).slice(0, 200)); }
