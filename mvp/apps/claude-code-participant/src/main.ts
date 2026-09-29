import { tmpdir } from 'node:os';
import type { IServiceProvider } from '@shellicar/core-di';
import { beforeServing } from './beforeServing.js';
import { ControlLines, runControlLines } from './ControlLines.js';
import { composeConfig } from './composition.js';
import { participantServices } from './container.js';
import { StartupError } from './startup.js';

let provider: IServiceProvider;
try {
  provider = participantServices(composeConfig(process.env, tmpdir(), process.getuid?.())).buildProvider();
  // TODO: undecided: nothing on stdin is read until this finishes, which with
  // a leftover that won't stop takes the SIGINT and SIGTERM waits in full.
  // Reading control lines meanwhile and holding only launches back would
  // answer them sooner, and would let a shutdown line reach the waits.
  await beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`));
} catch (err) {
  if (err instanceof StartupError) {
    console.error(`participant: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

// Stdin closing is one of shutdown's triggers, and shutdown isn't built yet:
// for now the loop ends and, with nothing else holding it open, so does the
// process.
await runControlLines(process.stdin, process.stdout, provider.resolve(ControlLines));
