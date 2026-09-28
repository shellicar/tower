import type { IServiceProvider } from '@shellicar/core-di';
import { ControlLines, runControlLines } from './ControlLines.js';
import { SHUTDOWN_SIGNALS, Shutdown } from './Shutdown.js';

/**
 * Serves the process: answers control lines on stdin until it closes, and
 * hands every shutdown trigger (the signals, and stdin closing) to the one
 * shutdown path.
 */
export function runParticipant(provider: IServiceProvider, scanStop: AbortController): void {
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
  // Not awaited by anyone: a graceful shutdown ends the process while stdin
  // is still open, and a top-level await left pending would make Node exit
  // with 13.
  void runControlLines(process.stdin, process.stdout, provider.resolve(ControlLines)).then(() => trigger('stdin closed'));
}
