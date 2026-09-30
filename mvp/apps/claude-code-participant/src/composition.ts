import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParticipantConfig } from './ParticipantConfig.js';
import { readStartup, StartupError } from './startup.js';

// rwx for the owner, nothing for anyone else.
const OWNER_ONLY = 0o700;
// Any access at all beyond the owner. Group access counts: macOS gives every
// local account the same primary group (staff), so group access there is
// everyone's. The config dir holds Claude Code's transcripts, which can hold
// anything the model saw.
const BEYOND_OWNER = 0o077;

/** The first executable called `name` on `pathVariable`, or null. */
export function findOnPath(name: string, pathVariable: string | undefined): string | null {
  for (const dir of (pathVariable ?? '').split(delimiter)) {
    if (dir === '') {
      continue;
    }
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw err;
  }
}

/**
 * The config dir, created owner-only if it isn't there, and checked before
 * anything is written into it: it must be a directory of this user's own,
 * with no access for anyone else. Returns its one canonical spelling.
 */
function prepareConfigDir(given: string, uid: number | undefined): string {
  if (uid === undefined) {
    throw new StartupError(`this platform has no user ids, so the owner of ${given} can't be checked`);
  }
  // Without a trailing slash, lstat reads the entry itself rather than
  // whatever a symlink in its place points at.
  const dir = resolve(given);
  if (lstatIfPresent(dir) === undefined) {
    mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) {
    throw new StartupError(`PARTICIPANT_CONFIG_DIR ${dir} is not a directory`);
  }
  if (stat.uid !== uid) {
    throw new StartupError(`PARTICIPANT_CONFIG_DIR ${dir} is owned by another user`);
  }
  if ((stat.mode & BEYOND_OWNER) !== 0) {
    chmodSync(dir, OWNER_ONLY);
  }
  // One spelling for one directory (a symlinked parent resolved), so a run
  // started with another spelling still finds the leftovers the last run
  // tagged.
  return realpathSync(dir);
}

/**
 * Prepares the process's fixed state from its environment, once, at start.
 */
export function composeConfig(env: NodeJS.ProcessEnv, tempDir: string, uid: number | undefined): ParticipantConfig {
  const startup = readStartup(env);
  const configDir = prepareConfigDir(startup.configDir, uid);
  // setpriv is used when it's there and skipped silently when it isn't.
  const setpriv = findOnPath('setpriv', env.PATH);
  // In the system temp dir, so nothing needs cleaning up.
  const privateHome = mkdtempSync(join(tempDir, 'tower-participant-home-'));
  const shellPrefix = fileURLToPath(new URL('../bin/real-home-shell.sh', import.meta.url));
  return new ParticipantConfig({ ...startup, configDir }, privateHome, setpriv, shellPrefix);
}
