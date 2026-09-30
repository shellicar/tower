import type { Readable, Writable } from 'node:stream';
import type { IServiceProvider } from '@shellicar/core-di';
import { ControlLines, runControlLines } from './ControlLines.js';
import { ASKING_SIGNALS, DRIVER_GONE_SIGNALS, describeError, Shutdown } from './Shutdown.js';

/** What of its own process the participant serves through: `process` itself, or a test's stand-in. */
export type ServedProcess = {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  on(signal: NodeJS.Signals, listener: () => void): unknown;
};

/**
 * Serves the process: answers control lines on stdin until it closes, and
 * hands every shutdown trigger (the signals, and stdin ending) to the one
 * shutdown path.
 */
export function runParticipant(provider: IServiceProvider, served: ServedProcess = process): void {
  // Once the terminal has gone (SIGHUP when it closes) or the parent reading
  // stdout has, every write fails; an unhandled write error would crash the
  // process in the middle of shutting down.
  served.stdout.on('error', () => {});
  served.stderr.on('error', () => {});

  const shutdown = provider.resolve(Shutdown);
  for (const signal of ASKING_SIGNALS) {
    served.on(signal, () => shutdown.ask(signal));
  }
  for (const signal of DRIVER_GONE_SIGNALS) {
    served.on(signal, () => shutdown.driverGone(signal));
  }
  // Not awaited by anyone: a graceful shutdown ends the process while stdin
  // is still open, and a top-level await left pending would make Node exit
  // with 13. Stdin failing (EIO from a terminal that has gone, say) means the
  // same as it closing.
  void runControlLines(served.stdin, served.stdout, provider.resolve(ControlLines)).then(
    () => shutdown.driverGone('stdin closed'),
    (err: unknown) => shutdown.driverGone(`stdin failed: ${describeError(err)}`),
  );
}
