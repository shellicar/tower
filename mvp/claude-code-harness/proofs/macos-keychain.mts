// macOS Keychain check: with a private HOME, does Claude Code 2.1.282 (the
// SDK's bundled binary) still find Stephen's login, which Keychain entry does
// it read, and does it make a second copy of the login? For a Mac; Stephen,
// 28 Sep: "we dont have to prove it works yet, but as long as its easy for me
// to do/test when we get there".
//
// What the macOS build's code says (research-macos-keychain; quotes in the
// task report):
// - Credentials are read from the Keychain first, then from the file
//   <dir>/.credentials.json if the Keychain has nothing or can't be read.
// - The Keychain entry is `security find-generic-password -a <account> -s
//   <service>`: account = $USER (else the passwd name); service =
//   "Claude Code-credentials", plus "-<first 8 hex of sha256(value)>" unless
//   CLAUDE_SECURESTORAGE_CONFIG_DIR is "" (or it is unset and
//   CLAUDE_CONFIG_DIR is unset or ""). The hashed value is
//   CLAUDE_SECURESTORAGE_CONFIG_DIR if set, else CLAUDE_CONFIG_DIR.
// - <dir> (the file fallback, the refresh lock and the write lock) is
//   CLAUDE_SECURESTORAGE_CONFIG_DIR if non-empty, homedir()/.claude if "",
//   and if unset CLAUDE_CONFIG_DIR or homedir()/.claude.
// - `security` is found on PATH and inherits Claude Code's environment,
//   HOME included.
//
// What it does, in order:
// 0. Without Claude Code: under the real HOME and a private HOME, asks
//    `security` for the default keychain, the user keychain search list,
//    whether the default keychain is locked, and whether each candidate
//    Keychain entry exists (exit code only; stdout thrown away; never -w or
//    -g, so no password is ever asked for or printed).
// 1. Each case: a fresh private HOME (and, where the case sets it, a private
//    CLAUDE_CONFIG_DIR inside it), CLAUDE_SECURESTORAGE_CONFIG_DIR unset, ""
//    or the absolute real ~/.claude, then `claude auth status`. auth status
//    only reads the credential store (it never refreshes or writes, by code).
//    A `security` shim first on PATH logs each call Claude Code makes (the
//    subcommand, -a, -s, the HOME it ran with, the exit code) and runs
//    /usr/bin/security with the same stdin/stdout, so it never sees a
//    password. It logs nothing else from the arguments.
// 2. CHECK lines: no Keychain write by any case, no .credentials.json
//    appeared anywhere checked, and the hashed entries that were absent at
//    the start are still absent.
//
// It never runs login, logout or setup-token, never opens a
// .credentials.json (existence is checked with lstat), and prints only
// loggedIn, authMethod, apiProvider and configDirectory from auth status
// (not the email or organisation). Everything it creates is under the
// system temp dir and removed at the end.
//
//   node proofs/macos-keychain.mts            # on the Mac
//   node proofs/macos-keychain.mts --dry-run  # any platform: names only
//   node proofs/macos-keychain.mts --with-real-home-baseline
//     # also runs auth status once with the real HOME (Claude Code's own
//     # housekeeping then runs in the real home, as it does for Stephen's own
//     # Claude Code)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRY_RUN = process.argv.includes('--dry-run');
const REAL_HOME_BASELINE = process.argv.includes('--with-real-home-baseline');
const SECURITY = '/usr/bin/security';
const AUTH_STATUS_TIMEOUT_MS = 60_000;
const SECURITY_TIMEOUT_MS = 15_000;

// OAUTH_FILE_SUFFIX is "" for the production OAuth config; USE_LOCAL_OAUTH,
// USE_STAGING_OAUTH and CLAUDE_CODE_OAUTH_CLIENT_ID change it, so they are
// stripped from every case below.
const BASE_SERVICE = 'Claude Code-credentials';

// Auth sources that outrank the stored login (authentication.md,
// "Authentication precedence"), bare mode (never reads the Keychain), OAuth
// config switches that change the service name, and a parent Claude Code
// session's variables (the harness's list). Stripped from every case so the
// stored login is what auth status reports on.
const STRIP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GATEWAY',
  'USE_LOCAL_OAUTH',
  'USE_STAGING_OAUTH',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_INVOKED_SKILLS',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
];

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

let failures = 0;
const check = (what: string, ok: boolean): void => {
  say(`CHECK ${ok ? 'PASS' : 'FAIL'}: ${what}`);
  if (!ok) {
    failures += 1;
  }
};

type Env = Record<string, string | undefined>;

// ZA() in the macOS build: $USER, else the passwd name; anything outside
// [a-zA-Z0-9._-] becomes "claude-code-user".
function account(env: Env): string {
  let name: string;
  try {
    name = env.USER || userInfo().username;
  } catch {
    name = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'claude-code-user';
}

// QL("-credentials") in the macOS build. The hash input is the raw string,
// NFC-normalised, not a resolved path: a trailing slash is a different entry.
function service(env: Env, home: string): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const unhashed = secure !== undefined ? !secure : !env.CLAUDE_CONFIG_DIR;
  const hashed = secure !== undefined ? secure.normalize('NFC') : configDir(env, home);
  return unhashed ? BASE_SERVICE : `${BASE_SERVICE}-${createHash('sha256').update(hashed).digest('hex').substring(0, 8)}`;
}

// we() in the macOS build: CLAUDE_CONFIG_DIR ?? homedir()/.claude.
function configDir(env: Env, home: string): string {
  return (env.CLAUDE_CONFIG_DIR ?? join(home, '.claude')).normalize('NFC');
}

// hw() in the macOS build: the file fallback's directory, and where the
// refresh lock and the write lock live.
function storeDir(env: Env, home: string): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) {
    return (secure || join(home, '.claude')).normalize('NFC');
  }
  return configDir(env, home);
}

function realBinary(): string {
  const sdk = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
}

// lstat only: a .credentials.json is never opened.
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const REAL_HOME = process.env.HOME || userInfo().homedir;
const REAL_CLAUDE = join(REAL_HOME, '.claude');

interface Case {
  label: string;
  // CLAUDE_CONFIG_DIR: a private one inside the private HOME, or unset.
  configDir: boolean;
  // CLAUDE_SECURESTORAGE_CONFIG_DIR: unset, "", or the absolute real ~/.claude.
  secure: 'unset' | 'empty' | 'absolute';
  // The shim runs /usr/bin/security with the real HOME instead of the
  // private one: shows whether HOME alone decides what security finds.
  shimRealHome?: boolean;
  realHome?: boolean;
}

const CASES: Case[] = [
  ...(REAL_HOME_BASELINE ? [{ label: 'baseline: real HOME, both unset', configDir: false, secure: 'unset', realHome: true } satisfies Case] : []),
  { label: 'A: private HOME, CLAUDE_CONFIG_DIR set, secure unset', configDir: true, secure: 'unset' },
  { label: 'B: private HOME, CLAUDE_CONFIG_DIR set, secure ""', configDir: true, secure: 'empty' },
  { label: 'C: private HOME, CLAUDE_CONFIG_DIR set, secure absolute', configDir: true, secure: 'absolute' },
  { label: 'D: private HOME, CLAUDE_CONFIG_DIR unset, secure unset', configDir: false, secure: 'unset' },
  { label: 'E: private HOME, CLAUDE_CONFIG_DIR unset, secure ""', configDir: false, secure: 'empty' },
  { label: 'F: private HOME, CLAUDE_CONFIG_DIR unset, secure absolute', configDir: false, secure: 'absolute' },
  { label: 'G: as B, but security itself runs with the real HOME', configDir: true, secure: 'empty', shimRealHome: true },
];

function baseEnv(): Env {
  const env: Env = { ...process.env };
  for (const name of STRIP) {
    delete env[name];
  }
  return env;
}

function caseEnv(c: Case, home: string): Env {
  const env = baseEnv();
  env.HOME = home;
  if (c.configDir) {
    env.CLAUDE_CONFIG_DIR = join(home, 'config');
  }
  if (c.secure === 'empty') {
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '';
  } else if (c.secure === 'absolute') {
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = REAL_CLAUDE;
  }
  return env;
}

// A private HOME as the participant would make one: an empty directory. The
// placeholder path is used for --dry-run, where nothing is created.
function privateHome(): string {
  return DRY_RUN ? join(tmpdir(), 'tower-keychain-XXXXXX') : mkdtempSync(join(tmpdir(), 'tower-keychain-'));
}

// The shim. POSIX sh. It logs the subcommand, the values of -a and -s, the
// HOME security runs with, and the exit code; nothing else from the
// arguments (an add-generic-password -X value is the login itself). Stdin
// and stdout go straight to /usr/bin/security, so the shim never sees a
// password.
const SHIM = `#!/bin/sh
log="$TOWER_KEYCHAIN_SHIM_LOG"
sub="$1"; acct=""; svc=""; prev=""
for a in "$@"; do
  case "$prev" in
    -a) acct="$a" ;;
    -s) svc="$a" ;;
  esac
  prev="$a"
done
if [ "$sub" = "-i" ]; then acct="(stdin not read)"; fi
home="$HOME"
if [ -n "$TOWER_KEYCHAIN_SHIM_REAL_HOME" ]; then home="$TOWER_KEYCHAIN_SHIM_REAL_HOME"; fi
printf 'start\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$$" "$home" "$sub" "$acct" "$svc" >> "$log"
HOME="$home" ${SECURITY} "$@"
rc=$?
printf 'end\\t%s\\t%s\\n' "$$" "$rc" >> "$log"
exit $rc
`;

interface ShimCall {
  home: string;
  sub: string;
  account: string;
  service: string;
  rc: string;
}

function readShimLog(path: string): ShimCall[] {
  if (!existsSync(path)) {
    return [];
  }
  const starts = new Map<string, ShimCall>();
  const calls: ShimCall[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'start') {
      const call = { home: f[2] ?? '', sub: f[3] ?? '', account: f[4] ?? '', service: f[5] ?? '', rc: '(no exit: still running or killed)' };
      starts.set(f[1] ?? '', call);
      calls.push(call);
    } else if (f[0] === 'end') {
      const call = starts.get(f[1] ?? '');
      if (call) {
        call.rc = f[2] ?? '';
      }
    }
  }
  return calls;
}

const READ_ONLY_SUBCOMMANDS = new Set(['find-generic-password', 'show-keychain-info', 'default-keychain', 'list-keychains']);

// 0 found, 44 not found, 36 locked / interaction not allowed, 37 no default
// keychain, 50 no such keychain (low byte of the OSStatus; the device-key
// code in the same build reads 37 and 50 as "no login keychain").
function rcMeaning(rc: number | null): string {
  switch (rc) {
    case 0:
      return 'found';
    case 44:
      return 'not found';
    case 36:
      return 'locked / interaction not allowed';
    case 37:
      return 'no default keychain';
    case 50:
      return 'no such keychain';
    case null:
      return 'timed out or killed (a Keychain dialog?)';
    default:
      return 'other';
  }
}

// Step 0 helper: one security call, stdout discarded unless `show` (only
// for default-keychain and list-keychains, which print keychain paths).
function security(home: string, args: string[], show: boolean): { rc: number | null; out: string } {
  const r = spawnSync(SECURITY, args, { env: { ...baseEnv(), HOME: home }, stdio: ['ignore', show ? 'pipe' : 'ignore', 'ignore'], encoding: 'utf8', timeout: SECURITY_TIMEOUT_MS });
  return { rc: r.status, out: show ? (r.stdout ?? '').trim().replace(/\s+/g, ' ') : '' };
}

function main(): void {
  if (process.platform !== 'darwin' && !DRY_RUN) {
    say(`This check is for macOS; this is ${process.platform}. Use --dry-run to see the names it would use.`);
    process.exit(2);
  }

  const acct = account(process.env);
  const ownService = service(process.env, REAL_HOME);
  const absService = service({ CLAUDE_SECURESTORAGE_CONFIG_DIR: REAL_CLAUDE }, REAL_HOME);
  say(`platform: ${process.platform}-${process.arch}${DRY_RUN ? ' (dry run: nothing is run or checked)' : ''}`);
  say(`binary: ${DRY_RUN ? '(not resolved in a dry run)' : realBinary()}`);
  say(`real HOME: ${REAL_HOME}`);
  say(`Keychain account (-a): ${acct}${process.env.USER ? '' : ' (USER unset: passwd name)'}`);
  say(`your own shell's CLAUDE_CONFIG_DIR: ${process.env.CLAUDE_CONFIG_DIR ?? '(unset)'}; CLAUDE_SECURESTORAGE_CONFIG_DIR: ${process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? '(unset)'}`);
  say(`entry your own Claude Code uses from this shell: "${ownService}", file fallback dir ${storeDir(process.env, REAL_HOME)}`);
  say(`entry for CLAUDE_SECURESTORAGE_CONFIG_DIR=${REAL_CLAUDE}: "${absService}"`);
  say('');

  const services = [...new Set([BASE_SERVICE, ownService, absService])];
  const tempRoots: string[] = [];
  const startAbsent = new Map<string, boolean>();

  try {
    // Step 0.
    const probeHome = privateHome();
    tempRoots.push(probeHome);
    for (const [which, home] of [
      ['real HOME', REAL_HOME],
      ['private HOME', probeHome],
    ] as const) {
      say(`== step 0, no Claude Code, ${which} (${home}) ==`);
      if (DRY_RUN) {
        say(`  would run: security default-keychain; security list-keychains -d user; security show-keychain-info; security find-generic-password -a ${acct} -s <each of ${JSON.stringify(services)}>`);
        continue;
      }
      const dk = security(home, ['default-keychain'], true);
      say(`  default-keychain: rc ${dk.rc} ${dk.out}`);
      const lk = security(home, ['list-keychains', '-d', 'user'], true);
      say(`  list-keychains -d user: rc ${lk.rc} ${lk.out}`);
      const info = security(home, ['show-keychain-info'], false);
      say(`  show-keychain-info: rc ${info.rc} (${rcMeaning(info.rc)})`);
      for (const svc of services) {
        const r = security(home, ['find-generic-password', '-a', acct, '-s', svc], false);
        say(`  entry "${svc}": rc ${r.rc} (${rcMeaning(r.rc)})`);
        if (which === 'real HOME') {
          startAbsent.set(svc, r.rc === 44);
        }
      }
    }
    say(`  ${REAL_CLAUDE}/.credentials.json exists: ${DRY_RUN ? '(not checked)' : exists(join(REAL_CLAUDE, '.credentials.json'))}`);
    say('');

    const realFileAtStart = DRY_RUN ? false : exists(join(REAL_CLAUDE, '.credentials.json'));
    let writes = 0;
    let newFiles = 0;

    // Step 1.
    const shimDir = DRY_RUN ? join(tmpdir(), 'tower-keychain-shim-XXXXXX') : mkdtempSync(join(tmpdir(), 'tower-keychain-shim-'));
    tempRoots.push(shimDir);
    if (!DRY_RUN) {
      writeFileSync(join(shimDir, 'security'), SHIM);
      chmodSync(join(shimDir, 'security'), 0o755);
    }

    for (const c of CASES) {
      const home = c.realHome ? REAL_HOME : privateHome();
      if (!c.realHome) {
        tempRoots.push(home);
      }
      const env = caseEnv(c, home);
      if (c.configDir && !DRY_RUN) {
        mkdirSync(env.CLAUDE_CONFIG_DIR as string);
      }
      const svc = service(env, home);
      const dir = storeDir(env, home);
      say(`== ${c.label} ==`);
      say(`  HOME=${home}`);
      say(`  CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR ?? '(unset)'}`);
      say(`  CLAUDE_SECURESTORAGE_CONFIG_DIR=${env.CLAUDE_SECURESTORAGE_CONFIG_DIR === undefined ? '(unset)' : JSON.stringify(env.CLAUDE_SECURESTORAGE_CONFIG_DIR)}`);
      say(`  by the code: entry -a ${account(env)} -s "${svc}"; file fallback, refresh lock and write lock in ${dir}`);
      if (DRY_RUN) {
        say('');
        continue;
      }

      const watched = [...new Set([join(dir, '.credentials.json'), join(home, '.claude', '.credentials.json'), join(REAL_CLAUDE, '.credentials.json'), ...(env.CLAUDE_CONFIG_DIR ? [join(env.CLAUDE_CONFIG_DIR, '.credentials.json')] : [])])];
      const before = new Map(watched.map((p) => [p, exists(p)]));

      const log = join(shimDir, `${CASES.indexOf(c)}.log`);
      env.PATH = `${shimDir}:${env.PATH ?? '/usr/bin:/bin'}`;
      env.TOWER_KEYCHAIN_SHIM_LOG = log;
      if (c.shimRealHome) {
        env.TOWER_KEYCHAIN_SHIM_REAL_HOME = REAL_HOME;
      }
      const r = spawnSync(realBinary(), ['auth', 'status'], { env, cwd: home, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: AUTH_STATUS_TIMEOUT_MS });
      let status: Record<string, unknown> = {};
      try {
        status = JSON.parse(r.stdout ?? '');
      } catch {
        // Not JSON: reported below as unparsed.
      }
      const shown = ['loggedIn', 'authMethod', 'apiProvider', 'configDirectory'].map((k) => `${k}=${JSON.stringify(status[k])}`).join(' ');
      say(`  auth status: exit ${r.status}${r.status === null ? ` (${r.signal ?? 'timeout'}: a Keychain dialog may be waiting)` : ''}; ${Object.keys(status).length ? shown : 'stdout not JSON'}`);
      const stderr = (r.stderr ?? '').trim();
      if (stderr) {
        say(`  auth status stderr: ${stderr.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-[REDACTED]').split('\n').slice(0, 5).join(' | ')}`);
      }

      const calls = readShimLog(log);
      if (calls.length === 0) {
        say('  security calls: none');
      }
      for (const call of calls) {
        const rcNum = /^\d+$/.test(call.rc) ? Number(call.rc) : null;
        say(`  security ${call.sub} -a ${call.account} -s "${call.service}" (HOME ${call.home}): rc ${call.rc} (${rcMeaning(rcNum)})`);
        if (!READ_ONLY_SUBCOMMANDS.has(call.sub)) {
          writes += 1;
        }
      }
      const caseWrites = calls.filter((call) => !READ_ONLY_SUBCOMMANDS.has(call.sub));
      check(`${c.label}: no Keychain write (add, delete, -i)`, caseWrites.length === 0);

      for (const p of watched) {
        const now = exists(p);
        say(`  ${p}: ${before.get(p) ? 'existed' : 'absent'} before, ${now ? 'exists' : 'absent'} after`);
        if (now && !before.get(p)) {
          newFiles += 1;
        }
      }
      check(`${c.label}: no .credentials.json appeared`, watched.every((p) => !exists(p) || before.get(p)));
      say('');
    }

    if (DRY_RUN) {
      return;
    }

    // Step 2.
    say('== end ==');
    for (const svc of services) {
      if (startAbsent.get(svc)) {
        const r = security(REAL_HOME, ['find-generic-password', '-a', acct, '-s', svc], false);
        check(`entry "${svc}", absent at the start, is still absent (rc ${r.rc})`, r.rc === 44);
      }
    }
    check(`${REAL_CLAUDE}/.credentials.json ${realFileAtStart ? 'still exists' : 'still absent'}`, exists(join(REAL_CLAUDE, '.credentials.json')) === realFileAtStart);
    say(`Keychain writes seen: ${writes}; new .credentials.json files: ${newFiles}`);
  } finally {
    for (const root of tempRoots) {
      if (!DRY_RUN && root.startsWith(tmpdir()) && existsSync(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }
  say(failures === 0 ? 'ALL CHECKS PASS' : `${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
