import { tmpdir } from 'node:os';
import type { IServiceProvider } from '@shellicar/core-di';
import { beforeServing } from './beforeServing.js';
import { composeConfig } from './composition.js';
import { participantServices } from './container.js';
import { EXITS } from './ExitCodes.js';
import { Presence } from './Presence.js';
import { runParticipant } from './run.js';
import { Shutdown } from './Shutdown.js';
import { StartupError } from './startup.js';

/** Ends the process the way a startup error says; anything else is thrown on. */
function exitOnStartupError(err: unknown): never {
  if (err instanceof StartupError) {
    console.error(`participant: ${err.message}`);
    process.exit(EXITS[err.exit].code);
  }
  throw err;
}

let provider: IServiceProvider;
try {
  provider = participantServices(composeConfig(process.env, tmpdir(), process.getuid?.(), process.platform), process.platform).buildProvider();
  // Not awaited: control lines are read and answered while the scan runs;
  // only launching waits for it.
  void beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`), provider.resolve(Shutdown).begun).catch(exitOnStartupError);
} catch (err) {
  exitOnStartupError(err);
}

runParticipant(provider);
// TODO: undecided: what the participant does when NATS can't be reached at
// start. As built, the rejected connect ends the process as a crash.
void provider.resolve(Presence).start();
