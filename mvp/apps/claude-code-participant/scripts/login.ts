// Logs the participant's Claude Code in, once per machine, on macOS. It runs
// the SDK's own Claude Code binary as `auth login` with the environment the
// participant gives Claude Code there: a private HOME, the security shim
// first on PATH, TOWER_REAL_HOME, and CLAUDE_SECURESTORAGE_CONFIG_DIR set to
// the login dir. Claude Code then writes its own Keychain entry, named by the
// login dir, through /usr/bin/security; the entry the user's own Claude Code
// uses (`Claude Code-credentials`) is a different one. Claude Code's prompts
// and output come through as they are, and the script exits with its exit
// code.
//
//   pnpm claude-login
//
// which runs `node --env-file-if-exists=.env --import tsx scripts/login.ts`.
// The login dir is PARTICIPANT_LOGIN_DIR, from the environment or the
// optional .env in the app directory, as start.ts reads it; by default
// ${XDG_DATA_HOME:-$HOME/.local/share}/tower/login (a relative XDG_DATA_HOME
// counts as unset). It must be absolute, and is created owner-only if it
// isn't there.

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_HOME_VARIABLE } from '../src/ClaudeCodeSpawner.js';
import { prepareOwnDir, SECURITY_SHIM_DIR } from '../src/composition.js';

if (process.platform !== 'darwin') {
  console.error(`login: this is for macOS; on ${process.platform} the participant uses the login in ~/.claude`);
  process.exit(2);
}

function dataHome(env: NodeJS.ProcessEnv): string {
  const xdgDataHome = env.XDG_DATA_HOME;
  return xdgDataHome !== undefined && isAbsolute(xdgDataHome) ? xdgDataHome : join(homedir(), '.local', 'share');
}

const givenLoginDir = process.env.PARTICIPANT_LOGIN_DIR || join(dataHome(process.env), 'tower', 'login');
if (!isAbsolute(givenLoginDir)) {
  console.error('login: PARTICIPANT_LOGIN_DIR must be an absolute path');
  process.exit(2);
}
// The same preparation the participant gives it, so both spell it the same
// way: the Keychain entry is named by that spelling.
const loginDir = prepareOwnDir('PARTICIPANT_LOGIN_DIR', givenLoginDir, process.getuid?.());
const realHome = homedir();
const privateHome = mkdtempSync(join(tmpdir(), 'tower-participant-login-home-'));

const sdk = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
const claude = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);

// Without CLAUDE_CONFIG_DIR, Claude Code's own config goes to the private
// home, not a config dir this shell names.
const { CLAUDE_CONFIG_DIR: _, ...inherited } = process.env;
const env: NodeJS.ProcessEnv = {
  ...inherited,
  HOME: privateHome,
  PATH: `${SECURITY_SHIM_DIR}${delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
  [REAL_HOME_VARIABLE]: realHome,
  CLAUDE_SECURESTORAGE_CONFIG_DIR: loginDir,
};

console.log(`login: ${claude} auth login`);
console.log(`login: login dir ${loginDir}, private home ${privateHome}`);
const result = spawnSync(claude, ['auth', 'login'], { cwd: privateHome, env, stdio: 'inherit' });
if (result.error !== undefined) {
  console.error(`login: Claude Code could not be started: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
