import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A process as the OS knows it. The start time tells it apart from a later
 * process given the same pid, which after a crash is a real possibility.
 */
export type ProcessIdentity = {
  pid: number;
  /** Opaque: compared for equality, never interpreted. */
  startTime: string;
};

export type TaggedProcess = ProcessIdentity & {
  /** Its full command line, for what the participant reports. */
  commandLine: string;
};

/**
 * The processes running on this machine: the edge between the participant
 * and the OS's process list. An abstract class because each OS reads its
 * process list its own way; v0 has Linux only.
 */
export abstract class IProcessTable {
  /** This process. */
  public abstract own(): ProcessIdentity;
  /** Whether the process is still there: the same pid with the same start time, and at least one of its threads not yet exited. */
  public abstract isRunning(process: ProcessIdentity): boolean;
  /** Every running process whose environment holds `entry` exactly, other than this process and its ancestors. */
  public abstract tagged(entry: string): TaggedProcess[];
  /** Sends `signal` only while the process still has the same start time. Whether it was sent. */
  public abstract signal(process: ProcessIdentity, signal: NodeJS.Signals): boolean;
}

type Kill = (pid: number, signal: NodeJS.Signals) => void;

type Stat = { state: string; ppid: number; startTime: string };

/** A thread that has exited but not yet been reaped (Z), or is being torn down (X, x). */
function hasExited(state: string): boolean {
  return state === 'Z' || state === 'X' || state === 'x';
}

function parseStat(text: string): Stat | undefined {
  // The command name is in parentheses and may itself hold spaces and ')':
  // the fields are what follows the last ')', starting at field 3 (state),
  // so field 4 (ppid) is index 1 and field 22 (starttime) is index 19.
  const close = text.lastIndexOf(')');
  if (close < 0) {
    return undefined;
  }
  const fields = text.slice(close + 2).split(' ');
  const [state, ppid] = fields;
  const startTime = fields[19];
  if (state === undefined || ppid === undefined || startTime === undefined || startTime === '') {
    return undefined;
  }
  return { state, ppid: Number(ppid), startTime };
}

/** Walking up the parents stops here, so a broken chain can't loop. */
const MAX_ANCESTORS = 64;

/**
 * The process list read from `/proc`. Every read tolerates the process
 * vanishing underneath it: a process that goes mid-scan is simply not found.
 */
export class LinuxProcessTable implements IProcessTable {
  private readonly root: string;
  private readonly kill: Kill;
  private readonly ownPid: number;

  public constructor(root: string, kill: Kill, ownPid: number) {
    this.root = root;
    this.kill = kill;
    this.ownPid = ownPid;
  }

  public own(): ProcessIdentity {
    const stat = this.stat(join(this.root, String(this.ownPid), 'stat'));
    if (stat === undefined) {
      throw new Error(`cannot read this process's own entry under ${this.root}`);
    }
    return { pid: this.ownPid, startTime: stat.startTime };
  }

  public isRunning(process: ProcessIdentity): boolean {
    const stat = this.stat(join(this.root, String(process.pid), 'stat'));
    return stat !== undefined && stat.startTime === process.startTime && this.anyThreadRunning(process.pid, stat);
  }

  public tagged(entry: string): TaggedProcess[] {
    const excluded = this.selfAndAncestors();
    const found: TaggedProcess[] = [];
    for (const name of this.list(this.root)) {
      if (!/^\d+$/.test(name)) {
        continue;
      }
      const pid = Number(name);
      if (excluded.has(pid)) {
        continue;
      }
      const stat = this.stat(join(this.root, name, 'stat'));
      if (stat === undefined || !this.anyThreadRunning(pid, stat) || !this.environment(pid).includes(entry)) {
        continue;
      }
      found.push({ pid, startTime: stat.startTime, commandLine: this.commandLine(pid) });
    }
    return found;
  }

  public signal(process: ProcessIdentity, signal: NodeJS.Signals): boolean {
    const stat = this.stat(join(this.root, String(process.pid), 'stat'));
    if (stat === undefined || stat.startTime !== process.startTime) {
      return false;
    }
    try {
      this.kill(process.pid, signal);
      return true;
    } catch (err) {
      // Gone between the check and the signal.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        return false;
      }
      throw err;
    }
  }

  /**
   * A process whose main thread has exited can still have other threads
   * running (observed for about 11 ms while a process exits), so it counts
   * as gone only once every thread has.
   */
  private anyThreadRunning(pid: number, stat: Stat): boolean {
    if (!hasExited(stat.state)) {
      return true;
    }
    const tasks = join(this.root, String(pid), 'task');
    return this.list(tasks).some((tid) => {
      const task = this.stat(join(tasks, tid, 'stat'));
      return task !== undefined && !hasExited(task.state);
    });
  }

  /**
   * In a process's last moments its main thread's environment can read as
   * empty or refuse with EACCES while another thread's still reads, so the
   * other threads are tried before giving up.
   */
  private environment(pid: number): string[] {
    const own = this.entries(join(this.root, String(pid), 'environ'));
    if (own.length > 0) {
      return own;
    }
    const tasks = join(this.root, String(pid), 'task');
    for (const tid of this.list(tasks)) {
      const entries = this.entries(join(tasks, tid, 'environ'));
      if (entries.length > 0) {
        return entries;
      }
    }
    return [];
  }

  /** Read in full: a copy cut short once hid the bundled Claude Code's path. */
  private commandLine(pid: number): string {
    return this.entries(join(this.root, String(pid), 'cmdline')).join(' ');
  }

  /** A process started from a tagged shell carries the tag itself; it and what started it are never leftovers. */
  private selfAndAncestors(): Set<number> {
    const pids = new Set<number>();
    let pid = this.ownPid;
    while (pid > 0 && !pids.has(pid) && pids.size < MAX_ANCESTORS) {
      pids.add(pid);
      const stat = this.stat(join(this.root, String(pid), 'stat'));
      if (stat === undefined) {
        break;
      }
      pid = stat.ppid;
    }
    return pids;
  }

  private stat(path: string): Stat | undefined {
    const text = this.read(path);
    return text === undefined ? undefined : parseStat(text);
  }

  private entries(path: string): string[] {
    return (this.read(path) ?? '').split('\0').filter((entry) => entry !== '');
  }

  private read(path: string): string | undefined {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  }

  private list(path: string): string[] {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  }
}
