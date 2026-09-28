import { tmpdir } from 'node:os';
import { ControlLines, runControlLines } from './ControlLines.js';
import { composeConfig } from './composition.js';
import { participantServices } from './container.js';
import { StartupError } from './startup.js';

let config: ReturnType<typeof composeConfig>;
try {
  config = composeConfig(process.env, tmpdir());
} catch (err) {
  if (err instanceof StartupError) {
    console.error(`participant: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

const provider = participantServices(config).buildProvider();
// Stdin closing is one of shutdown's triggers, and shutdown isn't built yet:
// for now the loop ends and, with nothing else holding it open, so does the
// process.
await runControlLines(process.stdin, process.stdout, provider.resolve(ControlLines));
