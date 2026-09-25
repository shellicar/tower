// Smoke run: one message, "reply pong", into a harness run; prints what came
// back and where the run directory is.
//
//   node proofs/smoke.mts <model>

import { startRun } from '../src/harness.mts';

const model = process.argv[2];
if (!model) {
  process.stderr.write('usage: node proofs/smoke.mts <model>\n');
  process.exit(2);
}

const run = startRun({ name: 'smoke', options: { model } });
process.stdout.write(`run dir: ${run.dir}\n`);

run.send({ type: 'user', message: { role: 'user', content: 'reply pong' }, parent_tool_use_id: null });

for await (const message of run.messages()) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'text') {
        process.stdout.write(`assistant: ${block.text}\n`);
      }
    }
  }
  if (message.type === 'result') {
    process.stdout.write(`result: ${message.subtype}${message.is_error ? ' (error)' : ''}\n`);
    run.end();
  }
}

try {
  await run.done;
  process.stdout.write('done\n');
} catch (err) {
  process.stdout.write(`failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
