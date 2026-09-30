import { tmpdir } from 'node:os';
import type { IServiceProvider } from '@shellicar/core-di';
import { beforeServing } from './beforeServing.js';
import { composeConfig } from './composition.js';
import { participantServices } from './container.js';
import { EXITS } from './ExitCodes.js';
import { runParticipant } from './run.js';
import { Shutdown } from './Shutdown.js';
import { StartupError } from './startup.js';

let provider: IServiceProvider;
try {
  provider = participantServices(composeConfig(process.env, tmpdir(), process.getuid?.())).buildProvider();
  // Not awaited: control lines are read and answered while the scan runs;
  // only launching waits for it.
  void beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`), provider.resolve(Shutdown).begun);
} catch (err) {
  if (err instanceof StartupError) {
    console.error(`participant: ${err.message}`);
    process.exit(EXITS[err.exit].code);
  }
  throw err;
}

runParticipant(provider);
