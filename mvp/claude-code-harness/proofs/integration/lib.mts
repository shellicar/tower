// Integration proof: what every piece shares. Paths, clocks, JSONL, /proc,
// the proof's safety gate for signals, and the redaction used for anything
// copied under runs/.
//
// Clock: every instant this proof records (store appends, request files,
// results, publishes) is Date.now() wall-clock ms, the clock Claude Code
// stamps its entries with, so a recovered entry's own `timestamp` and a live
// append compare on one clock (proof 7: performance.timeOrigin + now() drifts
// 140-170 ms from it on this machine).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../../src/record.mts';

export type Json = Record<string, unknown>;

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = join(HERE, '..', '..');
export const RUNS = join(PACKAGE_ROOT, 'runs');
export const REAL_HOME = homedir();
export const HARNESS_STATE = join(REAL_HOME, '.local', 'state', 'tower-claude-code-harness');
export const CONFIG_DIRS_ROOT = join(HARNESS_STATE, 'config-dirs');
// Everything the participant keeps beyond one process: per agent, the resume
// dirs its Claude Codes were given, and per conversation the recording the
// committer runs over (store appends, request bodies, results, publishes).
//
// TODO: undecided. Where the participant's durable state lives, and above
// all the request-body log (OTEL_LOG_RAW_API_BODIES=file:<dir>), which the
// "run" rule depends on and which recovery needs after a crash: built here,
// under the harness's state dir, one body dir per conversation lineage,
// outside the private temp HOME (which is per process). The alternatives are
// one body dir per agent (Claude Code's index.jsonl carries session_id) or
// one per process under the conversation.
export const INTEGRATION_STATE = join(HARNESS_STATE, 'integration');
// The login, pointed back from a private HOME: an absolute path to the real
// ~/.claude. Built as a string only; this proof never opens, stats or lists
// anything under it.
export const REAL_CLAUDE_DIR = join(REAL_HOME, '.claude');
// Proof 26's shell prefix: runs each command Claude Code spawns with HOME set
// back to the real home (P26_REAL_HOME).
export const SHELL_PREFIX = join(HERE, '..', 'home-shell-prefix.sh');
// The harness's own broker only (mvp/compose.harness.yaml, 31417): never the
// fleet's 4222, and never the bridge test broker's 31416.
export const NATS_TEST_URL = '127.0.0.1:31417';

export const nowMs = (): number => Date.now();
export const iso = (ms: number = Date.now()): string => new Date(ms).toISOString();
export const fileStamp = (): string => iso().replace(/[:.]/g, '');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// What goes under runs/: the harness's token redaction plus reconcile's email
// scrub (the account email rides in reminders).
export const clean = (text: string): string => redact(text).text.replace(EMAIL, '[email redacted]');

export function readJsonl(path: string): Json[] {
  if (!existsSync(path)) {
    return [];
  }
  const out: Json[] = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (l.trim() === '') {
      continue;
    }
    try {
      out.push(JSON.parse(l) as Json);
    } catch {
      // a line still being written
    }
  }
  return out;
}

export function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

// A raw line to the durable state and a cleaned copy to the run dir.
export class Log2 {
  readonly raw: string | undefined;
  readonly out: string | undefined;
  constructor(raw: string | undefined, out: string | undefined) {
    this.raw = raw;
    this.out = out;
    for (const p of [raw, out]) {
      if (p) {
        mkdirSync(dirname(p), { recursive: true });
      }
    }
  }
  write(value: unknown): void {
    const line = JSON.stringify(value);
    if (this.raw) {
      appendFileSync(this.raw, `${line}\n`);
    }
    if (this.out) {
      appendFileSync(this.out, `${clean(line)}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// /proc (Linux only, as proofs 17, 21 and 25).

export interface ProcStat {
  state: string;
  ppid: number;
  starttime: string;
}

export function procStat(pid: number): ProcStat | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0] ?? '?', ppid: Number(f[1]), starttime: f[19] ?? '?' };
  } catch {
    return undefined;
  }
}

export function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

export interface Known {
  pid: number;
  starttime: string;
}

// Proof 25's gone(): exited once every thread has; a zombie thread-group
// leader with other threads still listed is still running.
export function gone(k: Known): boolean {
  const s = procStat(k.pid);
  if (s === undefined || s.starttime !== k.starttime) {
    return true;
  }
  if (s.state === 'Z' || s.state === 'X') {
    try {
      return readdirSync(`/proc/${k.pid}/task`).length <= 1;
    } catch {
      return true;
    }
  }
  return false;
}

// Proof 25's signalChecked(): only while the start time is the recorded one.
export function signalChecked(k: Known, sig: NodeJS.Signals, log: (s: string) => void): boolean {
  const s = procStat(k.pid);
  if (!s || s.starttime !== k.starttime) {
    log(`refused ${sig} to ${k.pid}: start time ${s?.starttime ?? 'none'} is not the recorded ${k.starttime}`);
    return false;
  }
  try {
    process.kill(k.pid, sig);
    return true;
  } catch (err) {
    log(`${sig} to ${k.pid} failed: ${String(err)}`);
    return false;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
