import { accessSync, constants, mkdtempSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ParticipantConfig } from './ParticipantConfig.js';
import { readStartup } from './startup.js';

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

/**
 * Prepares the process's fixed state from its environment, once, at start.
 */
export function composeConfig(env: NodeJS.ProcessEnv, tempDir: string): ParticipantConfig {
  const startup = readStartup(env);
  // setpriv is used when it's there and skipped silently when it isn't.
  const setpriv = findOnPath('setpriv', env.PATH);
  // In the system temp dir, so nothing needs cleaning up.
  const privateHome = mkdtempSync(join(tempDir, 'tower-participant-home-'));
  const shellPrefix = fileURLToPath(new URL('../bin/real-home-shell.sh', import.meta.url));
  return new ParticipantConfig(startup, privateHome, setpriv, shellPrefix);
}
