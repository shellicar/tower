import type { IServiceProvider } from '@shellicar/core-di';
import { Leftovers } from './Leftovers.js';
import { ParticipantLock } from './ParticipantLock.js';
import { StartupError } from './startup.js';

/**
 * What has to hold before this process serves anything: no other participant
 * is running on its config dir, and nothing an earlier one started is still
 * running there.
 *
 * @throws StartupError when another participant holds the config dir, or on a platform without a process table.
 */
export async function beforeServing(provider: IServiceProvider, platform: NodeJS.Platform, log: (line: string) => void): Promise<void> {
  // TODO: undecided: on a platform without a process table (anything but
  // Linux in v0) the participant refuses to start. Starting without the lock
  // and the scan would run it there, with nothing to stop a second
  // participant or an earlier run's leftovers forking a conversation.
  if (platform !== 'linux') {
    throw new StartupError(`the leftover scan reads /proc, which ${platform} doesn't have: v0 runs on Linux only`);
  }
  provider.resolve(ParticipantLock).acquire();
  await provider.resolve(Leftovers).stop(log);
}
