import { tmpdir } from 'node:os';
import type { IServiceProvider } from '@shellicar/core-di';
import { beforeServing } from './beforeServing.js';
import { ControlLines, runControlLines } from './ControlLines.js';
import { composeConfig } from './composition.js';
import { participantServices } from './container.js';
import { SHUTDOWN_SIGNALS, Shutdown } from './Shutdown.js';
import { StartupError } from './startup.js';

const scanStop = new AbortController();
let provider: IServiceProvider;
try {
  provider = participantServices(composeConfig(process.env, tmpdir(), process.getuid?.())).buildProvider();
  // Not awaited: control lines are read and answered while the scan runs;
  // only launching waits for it.
  void beforeServing(provider, process.platform, (line) => console.error(`participant: ${line}`), scanStop.signal);
} catch (err) {
  if (err instanceof StartupError) {
    console.error(`participant: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

// Once the terminal has gone (SIGHUP when it closes) or the parent reading
// stdout has, every write fails; an unhandled write error would crash the
// process in the middle of shutting down.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

const shutdown = provider.resolve(Shutdown);
const trigger = (cause: string) => {
  scanStop.abort();
  shutdown.trigger(cause);
};
for (const signal of SHUTDOWN_SIGNALS) {
  process.on(signal, () => trigger(signal));
}
// Not awaited: a graceful shutdown ends the process while stdin is still
// open, and a top-level await left pending would make Node exit with 13.
void runControlLines(process.stdin, process.stdout, provider.resolve(ControlLines)).then(() => trigger('stdin closed'));
