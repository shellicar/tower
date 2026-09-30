import type { IServiceProvider } from '@shellicar/core-di';
import { type LeftoverStop, Leftovers } from './Leftovers.js';
import { ParticipantLock } from './ParticipantLock.js';
import { ServingGate } from './ServingGate.js';
import { StartupError } from './startup.js';

/**
 * What has to hold before this process serves anything: no other participant
 * is running on its config dir, and nothing an earlier one started is still
 * running there.
 *
 * The lock is taken before this returns; the scan runs on, and opens the
 * serving gate when it finishes, unless shutdown stopped it first. Nothing
 * else waits for it.
 *
 * @throws StartupError when another participant holds the config dir, or on a platform without a process table.
 */
export function beforeServing(provider: IServiceProvider, platform: NodeJS.Platform, log: (line: string) => void, shutdown: AbortSignal): Promise<LeftoverStop> {
  if (platform !== 'linux') {
    throw new StartupError(`the participant runs only on Linux, and this platform is ${platform}`);
  }
  provider.resolve(ParticipantLock).acquire();
  return provider
    .resolve(Leftovers)
    .stop(log, shutdown)
    .then((stopped) => {
      if (!stopped.interrupted) {
        provider.resolve(ServingGate).open();
      }
      return stopped;
    });
}
