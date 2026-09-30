import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dependsOn } from '@shellicar/core-di';
import { ParticipantConfig } from './ParticipantConfig.js';
import { StartupError } from './startup.js';

/** In the config dir, beside Claude Code's own files, which it leaves alone. */
export const LOCK_FILE = 'tower-participant.lock';

const SQLITE_BUSY = 5;

function isBusy(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'errcode' in err && err.errcode === SQLITE_BUSY;
}

/**
 * One participant per config dir. Claude Code's records live in the config
 * dir, so it is exactly what two processes must not share.
 *
 * The lock is an exclusive transaction on a small sqlite database in the
 * config dir, opened at start and never finished. sqlite holds it as an
 * operating-system file lock, which the kernel releases when the holder
 * exits, however it exits.
 *
 * Nothing else in this process may open the lock file: POSIX drops every lock
 * a process holds on a file when any descriptor it has for that file closes.
 */
export class ParticipantLock {
  @dependsOn(ParticipantConfig) private readonly config!: ParticipantConfig;

  /** Kept for the life of the process: the lock lasts as long as the connection does. */
  private held: DatabaseSync | undefined;

  /** @throws StartupError while another participant holds this config dir. */
  public acquire(): void {
    if (this.held !== undefined) {
      return;
    }
    // No busy timeout: a held lock is refused at once, never waited for.
    const db = new DatabaseSync(join(this.config.configDir, LOCK_FILE), { timeout: 0 });
    try {
      db.exec('BEGIN EXCLUSIVE');
    } catch (err) {
      db.close();
      if (isBusy(err)) {
        throw new StartupError('configDirLocked', `another participant is running on ${this.config.configDir}`);
      }
      throw err;
    }
    this.held = db;
  }
}
