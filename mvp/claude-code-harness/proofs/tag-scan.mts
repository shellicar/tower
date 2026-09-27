// Proof 25: find every process carrying an agent's tag, TOWER_AGENT=<name>,
// by its /proc/<pid>/environ (its environment as it was at exec).
//
// Reads every same-uid process's environment. From one that doesn't carry the
// tag it keeps nothing; from one that does it keeps only CLAUDE_CONFIG_DIR (a
// path), to find that Claude Code's sessions/<pid>.json. Matches the whole
// NUL-delimited entry, so TOWER_AGENT=<name>x doesn't match <name>.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TAG_KEY = 'TOWER_AGENT';

export interface TaggedProc {
  pid: number;
  starttime: string;
  ppid: number;
  state: string;
  cmd: string;
  configDir: string | null;
  // sessions/<pid>.json in the CLAUDE_CONFIG_DIR its environment names.
  pidFile: string | null;
  // The pid file exists and its procStart is this process's start time.
  pidFileLive: boolean;
}

export interface TagScan {
  at: string;
  t: number;
  // /proc/uptime at the scan's start, in clock ticks (1/100 s): a process
  // whose starttime is below this existed when the scan began.
  uptimeTicks: number;
  ms: number;
  scanned: number;
  // Same-uid processes whose environ couldn't be read (anything but gone).
  ownUidUnreadable: { pid: number; cmd: string; code: string; state: string | null }[];
  // Same-uid processes whose environ read empty (a process past releasing its
  // memory on exit reads empty, as does a zombie), with state and parent.
  ownUidEmpty: { pid: number; state: string | null; ppid: number | null }[];
  // Listed by readdir, then gone (ENOENT/ESRCH) before its environ was read:
  // exited and reaped during the scan.
  vanished: number[];
  found: TaggedProc[];
  // Tagged, but the caller's own (a pid in `own` or a descendant of one).
  excluded: TaggedProc[];
}

export function procStat(pid: number): { state: string; ppid: number; starttime: string } | undefined {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { state: f[0] ?? '?', ppid: Number(f[1]), starttime: f[19] ?? '?' };
  } catch {
    return undefined;
  }
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

function realUid(pid: number): number | undefined {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

// The tag, and CLAUDE_CONFIG_DIR only when the tag is there.
function readTag(buf: Buffer, want: Buffer): { tagged: boolean; configDir: string | null } {
  const cfg = Buffer.from('CLAUDE_CONFIG_DIR=');
  let tagged = false;
  let configDir: string | null = null;
  let at = 0;
  while (at < buf.length) {
    let end = buf.indexOf(0, at);
    if (end < 0) {
      end = buf.length;
    }
    const entry = buf.subarray(at, end);
    if (entry.equals(want)) {
      tagged = true;
    } else if (entry.length > cfg.length && entry.subarray(0, cfg.length).equals(cfg)) {
      configDir = entry.subarray(cfg.length).toString('utf8');
    }
    at = end + 1;
  }
  return { tagged, configDir: tagged ? configDir : null };
}

function isOwn(pid: number, own: Set<number>): boolean {
  let p = pid;
  for (let i = 0; i < 64 && p > 1; i += 1) {
    if (own.has(p)) {
      return true;
    }
    const s = procStat(p);
    if (!s) {
      return false;
    }
    p = s.ppid;
  }
  return false;
}

export function scanTag(name: string, own: Set<number> = new Set()): TagScan {
  const uptimeTicks = Math.round(Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 100);
  const t0 = performance.now();
  const at = new Date().toISOString();
  const t = Date.now();
  const want = Buffer.from(`${TAG_KEY}=${name}`);
  const uid = process.getuid?.();
  const found: TaggedProc[] = [];
  const excluded: TaggedProc[] = [];
  const ownUidUnreadable: TagScan['ownUidUnreadable'] = [];
  const ownUidEmpty: TagScan['ownUidEmpty'] = [];
  const vanished: number[] = [];
  let scanned = 0;
  for (const n of readdirSync('/proc')) {
    if (!/^\d+$/.test(n)) {
      continue;
    }
    const pid = Number(n);
    if (pid === process.pid) {
      continue;
    }
    let buf: Buffer | undefined;
    try {
      buf = readFileSync(`/proc/${pid}/environ`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '?';
      if (code === 'ENOENT' || code === 'ESRCH') {
        vanished.push(pid);
        continue;
      }
      // A thread-group leader past its own exit (a zombie leader, or one
      // releasing its memory) reads EACCES while another thread may still
      // run: read through each other thread before giving up.
      try {
        for (const tid of readdirSync(`/proc/${pid}/task`)) {
          if (tid === String(pid)) {
            continue;
          }
          try {
            const b = readFileSync(`/proc/${pid}/task/${tid}/environ`);
            if (b.length > 0) {
              buf = b;
              break;
            }
          } catch {}
        }
      } catch {}
      if (buf === undefined) {
        if (realUid(pid) === uid) {
          ownUidUnreadable.push({ pid, cmd: cmdline(pid).slice(0, 80), code, state: procStat(pid)?.state ?? null });
        }
        continue;
      }
    }
    // A zombie leader whose other threads still run reads empty; read
    // through one of those threads instead.
    if (buf.length === 0) {
      try {
        const other = readdirSync(`/proc/${pid}/task`).find((x) => x !== String(pid));
        if (other) {
          buf = readFileSync(`/proc/${pid}/task/${other}/environ`);
        }
      } catch {}
    }
    scanned += 1;
    if (buf.length === 0) {
      const st = procStat(pid);
      if (realUid(pid) === uid || st?.state === 'Z') {
        ownUidEmpty.push({ pid, state: st?.state ?? null, ppid: st?.ppid ?? null });
      }
      continue;
    }
    const { tagged, configDir } = readTag(buf, want);
    if (!tagged) {
      continue;
    }
    const st = procStat(pid);
    if (!st) {
      continue;
    }
    let pidFile: string | null = null;
    let pidFileLive = false;
    if (configDir) {
      const f = join(configDir, 'sessions', `${pid}.json`);
      if (existsSync(f)) {
        pidFile = f;
        try {
          const d = JSON.parse(readFileSync(f, 'utf8')) as { procStart?: unknown };
          pidFileLive = String(d.procStart) === st.starttime;
        } catch {}
      }
    }
    const row: TaggedProc = { pid, starttime: st.starttime, ppid: st.ppid, state: st.state, cmd: cmdline(pid).slice(0, 100), configDir, pidFile, pidFileLive };
    (isOwn(pid, own) ? excluded : found).push(row);
  }
  return { at, t, uptimeTicks, ms: Math.round((performance.now() - t0) * 10) / 10, scanned, ownUidUnreadable, ownUidEmpty, vanished, found, excluded };
}
