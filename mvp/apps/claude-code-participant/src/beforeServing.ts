import type { IServiceProvider } from '@shellicar/core-di';
import { describeError } from './describeError.js';
import { type LeftoverStop, Leftovers } from './Leftovers.js';
import { ParticipantLock } from './ParticipantLock.js';
import { IProcessTable, ProcessListUnreadable } from './ProcessTable.js';
import { ServingGate } from './ServingGate.js';
import { StartupError } from './startup.js';

/**
 * What has to hold before this process serves anything: no other participant
 * is running on its config dir, and nothing an earlier one started is still
 * running there.
 *
 * The lock is taken before this returns; the scan runs on, and opens the
 * serving gate when it finishes, unless shutdown stopped it first. Nothing
 * else waits for it. Until the gate opens, a process list that can't be read
 * fails the start; the returned promise then rejects with a StartupError and
 * the gate stays shut.
 *
 * @throws StartupError when another participant holds the config dir, on a platform without a process table, or when the process list can't be read.
 */
export function beforeServing(provider: IServiceProvider, platform: NodeJS.Platform, log: (line: string) => void, shutdown: AbortSignal): Promise<LeftoverStop> {
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new StartupError('unsupportedPlatform', 'platform not supported');
  }
  provider.resolve(ParticipantLock).acquire();
  try {
    provider.resolve(IProcessTable).check();
  } catch (err) {
    throw noProcessList(err);
  }
  return scanThenServe(provider, log, shutdown);
}

function noProcessList(err: unknown): StartupError {
  return new StartupError('noProcessList', `the process list could not be read, so an earlier run's leftovers can't be found: ${describeError(err)}`);
}

/** @throws StartupError, as a rejection, when the process list can't be read during the scan. */
async function scanThenServe(provider: IServiceProvider, log: (line: string) => void, shutdown: AbortSignal): Promise<LeftoverStop> {
  let stopped: LeftoverStop;
  try {
    stopped = await provider.resolve(Leftovers).stop(log, shutdown);
  } catch (err) {
    throw err instanceof ProcessListUnreadable ? noProcessList(err) : err;
  }
  if (!stopped.interrupted) {
    provider.resolve(ServingGate).open();
  }
  return stopped;
}
