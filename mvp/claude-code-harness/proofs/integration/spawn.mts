// Integration proof: how the participant starts each Claude Code, from
// spawnClaudeCodeProcess (proof 25's spawnWith, proofs/orphan-tag.mts, which
// can't be imported: it runs on import).
//
// Join 4 (setpriv vs the capture wrapper): the real binary is spawned
// directly from the hook, so the tree is participant -> claude and the
// parent-death signal lands on Claude Code; stdio is captured in the hook,
// into the harness's capture dir layout (<run>/claude/<n>/), exit.json
// included, so the harness's run.done still sees the binary exit.
//
// The environment, on this Claude Code only (settled, design.md):
//   TOWER_AGENT=<agent>                      the tag (proof 25)
//   HOME=<private temp HOME>                 per participant process (proof 26)
//   CLAUDE_SECURESTORAGE_CONFIG_DIR=<abs real ~/.claude>
//                                            the login, pointed back; set here
//                                            because the harness (and the
//                                            SDK's store-resume path) set
//                                            their own value (join 5)
//   CLAUDE_CODE_SHELL_PREFIX=home-shell-prefix.sh, P26_REAL_HOME=<real home>
//                                            commands get the real HOME
// CLAUDE_CONFIG_DIR is never changed here (join 5: the SDK warns mirroring
// breaks). The declared skills are linked into whatever it names first.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { LineRecorder } from '../../src/record.mts';
import { CONFIG_DIRS_ROOT, iso, procStat, REAL_CLAUDE_DIR, REAL_HOME, SHELL_PREFIX } from './lib.mts';
import type { Skills } from './skills.mts';

export const TAG_KEY = 'TOWER_AGENT';

// setpriv when available, silently without it (design.md, Orphans).
export const SETPRIV: string | null = (() => {
  const r = spawnSync('sh', ['-c', 'command -v setpriv'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
})();

export interface SpawnRecord {
  at: string;
  conv: string;
  pid: number;
  starttime: string;
  launcher: string | null;
  realBinary: string;
  configDir: string;
  agentDir: boolean;
  captureDir: string;
  envNames: string[];
  exited?: { at: string; code: number | null; signal: NodeJS.Signals | null };
}

export interface SpawnContext {
  agent: string;
  privateHome: string;
  prefixLog?: string;
  skills: Skills;
  // Called with each spawn (for the run record, the driver's safety list and
  // the durable list of resume dirs).
  onSpawn: (r: SpawnRecord) => void;
  onExit: (r: SpawnRecord) => void;
  log: (s: string) => void;
}

function claimSpawnDir(root: string): string {
  mkdirSync(root, { recursive: true });
  for (let n = 1; ; n += 1) {
    const dir = join(root, String(n));
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }
}

export function spawnHook(ctx: SpawnContext, conv: string): (o: SpawnOptions) => SpawnedProcess {
  return (o: SpawnOptions): SpawnedProcess => {
    const captureRoot = String(o.env.HARNESS_CAPTURE_DIR);
    const real = String(o.env.HARNESS_REAL_CLAUDE);
    const env: Record<string, string | undefined> = { ...o.env };
    delete env.HARNESS_CAPTURE_DIR;
    delete env.HARNESS_REAL_CLAUDE;
    env[TAG_KEY] = ctx.agent;
    env.HOME = ctx.privateHome;
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR = REAL_CLAUDE_DIR;
    env.CLAUDE_CODE_SHELL_PREFIX = SHELL_PREFIX;
    env.P26_REAL_HOME = REAL_HOME;
    // Test-only evidence: the prefix script writes one line per command it
    // runs (no command text), so a check can tell a command ran.
    if (ctx.prefixLog) {
      env.P26_PREFIX_LOG = ctx.prefixLog;
    }
    const configDir = String(env.CLAUDE_CONFIG_DIR);
    const agentDir = dirname(configDir) === CONFIG_DIRS_ROOT && basename(configDir) === ctx.agent;
    // skills/ must exist before Claude Code starts (a new one isn't watched).
    ctx.skills.linkInto(configDir, `spawn ${conv}`);
    const dir = claimSpawnDir(captureRoot);
    const command = SETPRIV ?? real;
    const args = SETPRIV ? ['--pdeathsig', 'SIGINT', '--', real, ...o.args] : o.args;
    const child: ChildProcess = spawn(command, args, { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: o.signal, windowsHide: true });
    const pid = child.pid as number;
    const st = procStat(pid);
    const record: SpawnRecord = {
      at: iso(),
      conv,
      pid,
      starttime: st?.starttime ?? '?',
      launcher: SETPRIV ? `${SETPRIV} --pdeathsig SIGINT --` : null,
      realBinary: real,
      configDir,
      agentDir,
      captureDir: dir,
      envNames: Object.keys(env).sort(),
    };
    // Env values are not recorded (inherited values can hold secrets); the
    // ones this hook sets are paths, recorded by name and path.
    writeFileSync(
      join(dir, 'argv.json'),
      `${JSON.stringify({ ...record, argv: o.args, cwd: o.cwd, set: { HOME: env.HOME, CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: env.CLAUDE_SECURESTORAGE_CONFIG_DIR, CLAUDE_CODE_SHELL_PREFIX: env.CLAUDE_CODE_SHELL_PREFIX, [TAG_KEY]: env[TAG_KEY] } }, null, 2)}\n`,
    );
    const stdinRec = new LineRecorder(createWriteStream(join(dir, 'stdin.txt')));
    const stdoutRec = new LineRecorder(createWriteStream(join(dir, 'stdout.txt')));
    const stderrRec = new LineRecorder(createWriteStream(join(dir, 'stderr.txt')));
    for (const [stream, rec] of [
      [child.stdout, stdoutRec],
      [child.stderr, stderrRec],
    ] as const) {
      if (!stream) {
        continue;
      }
      const emit = stream.emit.bind(stream);
      stream.emit = ((event: string, ...a: unknown[]) => {
        if (event === 'data') {
          rec.push(a[0] as Buffer);
        }
        return emit(event, ...a);
      }) as typeof stream.emit;
    }
    if (child.stdin) {
      const write = child.stdin.write.bind(child.stdin) as (...a: unknown[]) => boolean;
      child.stdin.write = ((chunk: unknown, ...a: unknown[]) => {
        stdinRec.push(Buffer.from(chunk as string));
        return write(chunk, ...a);
      }) as typeof child.stdin.write;
    }
    child.once('exit', (code, signal) => {
      record.exited = { at: iso(), code, signal };
      ctx.onExit(record);
    });
    child.once('close', async () => {
      await Promise.all([stdinRec.end(), stdoutRec.end(), stderrRec.end()]);
      writeFileSync(join(dir, 'exit.json'), `${JSON.stringify({ exitedAt: record.exited?.at, closedAt: iso(), code: record.exited?.code, signal: record.exited?.signal }, null, 2)}\n`);
    });
    child.on('error', (err) => ctx.log(`spawn ${conv}: ${err.message}`));
    ctx.onSpawn(record);
    return child as unknown as SpawnedProcess;
  };
}
