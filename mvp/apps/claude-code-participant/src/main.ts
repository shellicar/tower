import { tmpdir } from 'node:os';
import type { IServiceProvider } from '@shellicar/core-di';
import { beforeServing } from './beforeServing.js';
import { ControlLines, runControlLines } from './ControlLines.js';
import { composeConfig } from './composition.js';
import { participantServices } from './container.js';
import { StartupError } from './startup.js';

const shutdown = new AbortController();
let provider: IServiceProvider;
try {
  provider = participantServices(composeConfig(process.env, tmpdir(), process.getuid?.())).buildProvider();
  // Not awaited: control lines are read and answered while the scan runs;
  // only launching waits for it.
  void beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`), shutdown.signal);
} catch (err) {
  if (err instanceof StartupError) {
    console.error(`participant: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

await runControlLines(process.stdin, process.stdout, provider.resolve(ControlLines));
shutdown.abort();
