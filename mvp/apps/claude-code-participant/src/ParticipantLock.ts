import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dependsOn } from '@shellicar/core-di';
import { ParticipantConfig } from './ParticipantConfig.js';
import { IProcessTable, type ProcessIdentity } from './ProcessTable.js';
import { StartupError } from './startup.js';

/** In the config dir, beside Claude Code's own files, which it leaves alone. */
export const LOCK_FILE = 'tower-participant.lock';

function isErrno(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

function parseHolder(text: string): ProcessIdentity | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && 'pid' in value && 'startTime' in value && typeof value.pid === 'number' && typeof value.startTime === 'string') {
      return { pid: value.pid, startTime: value.startTime };
    }
  } catch {
    // not a record this participant wrote
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      return undefined;
    }
    throw err;
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) {
      throw err;
    }
  }
}

/**
 * One participant per config dir. Claude Code's records live in the config
 * dir, so it is exactly what two processes must not share: the lock holds
 * the holder's pid and start time. A holder still running means another
 * participant is serving this config dir; one that isn't means an earlier run
 * ended, and its lock is taken over. The start time is what tells a holder
 * apart from a later process that was given its pid.
 *
 * The lock is never removed: a dead holder's lock is taken over, whichever
 * way that holder ended, so a clean exit needs nothing different.
 */
export class ParticipantLock {
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;
  @dependsOn(IProcessTable) private readonly processes!: IProcessTable;

  /** @throws StartupError while another participant holds this config dir. */
  public acquire(): void {
    const lock = join(this.config.configDir, LOCK_FILE);
    const own = this.processes.own();
    // Every file this process writes carries its own identity in the name,
    // so two participants starting at once never touch each other's.
    const suffix = `${own.pid}-${own.startTime}`;
    const record = `${lock}.${suffix}`;
    const aside = `${lock}.stale-${suffix}`;
    // The record is complete before it becomes the lock (a hard link, which
    // fails if the lock exists), so no reader ever sees a partial one.
    writeFileSync(record, JSON.stringify(own));
    try {
      for (;;) {
        try {
          linkSync(record, lock);
          return;
        } catch (err) {
          if (!isErrno(err, 'EEXIST')) {
            throw err;
          }
        }
        const held = readText(lock);
        if (held === undefined) {
          continue;
        }
        const holder = parseHolder(held);
        if (holder !== undefined && this.processes.isRunning(holder)) {
          throw new StartupError(`another participant (pid ${holder.pid}) is running on ${this.config.configDir}`);
        }
        // A lock nobody holds. Removing it by name could remove a lock
        // another participant took over in the meantime, so it is moved to a
        // name only this process uses and checked there.
        try {
          renameSync(lock, aside);
        } catch (err) {
          if (isErrno(err, 'ENOENT')) {
            continue;
          }
          throw err;
        }
        if (readText(aside) !== held) {
          // Another participant took the lock over between the read and the
          // move: put it back, and the next round finds it running.
          try {
            linkSync(aside, lock);
          } catch (err) {
            if (!isErrno(err, 'EEXIST')) {
              throw err;
            }
          }
        }
        removeIfPresent(aside);
      }
    } finally {
      removeIfPresent(record);
    }
  }
}
