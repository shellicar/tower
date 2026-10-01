import { spawnSync } from 'node:child_process';
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
 * and the OS's process list.
 */
export abstract class IProcessTable {
  /**
   * Every running process whose environment holds `entry` exactly, other than
   * this process and its ancestors, and other than its descendants unless
   * `withOwnDescendants`: what it started is left out of a search for what
   * an earlier run left behind, and belongs in one for what it must stop.
   *
   * A process list that can't be read throws when `strict`, and otherwise
   * reads as holding no processes.
   */
  public abstract tagged(entry: string, options?: { withOwnDescendants?: boolean; strict?: boolean }): TaggedProcess[];
  /**
   * Sends `signal` only while the process still has the same start time.
   * Whether it was sent. A process list that can't be read throws when
   * `strict`, and otherwise reads as the process having gone.
   */
  public abstract signal(process: ProcessIdentity, signal: NodeJS.Signals, options?: { strict?: boolean }): boolean;
  /** Throws when the process list can't be read at all. */
  public abstract check(): void;
}

/** Thrown by a strict read of a process list that can't be read. */
export class ProcessListUnreadable extends Error {
  public override name = 'ProcessListUnreadable';
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

  public tagged(entry: string, options: { withOwnDescendants?: boolean } = {}): TaggedProcess[] {
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
      if (stat === undefined || !this.anyThreadRunning(pid, stat) || !this.environment(pid).includes(entry) || (options.withOwnDescendants !== true && this.descendsFromSelf(stat))) {
        continue;
      }
      found.push({ pid, startTime: stat.startTime, commandLine: this.commandLine(pid) });
    }
    return found;
  }

  // Each /proc read tolerates failure on its own, so a strict read is no
  // different and there is nothing to check.
  public check(): void {
    // nothing to check
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

  /**
   * Before this process has started anything, whatever descends from it is
   * its own (a helper its runtime started, say) and inherited the tag from
   * it. A leftover's parents lead to init instead, since the process that
   * started it has gone.
   */
  private descendsFromSelf(stat: Stat): boolean {
    let pid = stat.ppid;
    for (let links = 0; pid > 0 && links < MAX_ANCESTORS; links++) {
      if (pid === this.ownPid) {
        return true;
      }
      const parent = this.stat(join(this.root, String(pid), 'stat'));
      if (parent === undefined) {
        return false;
      }
      pid = parent.ppid;
    }
    return false;
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

/** What ps wrote to stdout, and its exit status (null when a signal ended it). */
type PsOutput = { stdout: string; status: number | null };

/** Runs `ps` with these arguments. Throws when ps can't be run at all. */
type RunPs = (args: string[]) => PsOutput;

/** `/bin/ps` in the C locale, so `lstart` always reads the same way. */
export const realPs: RunPs = (args) => {
  const result = spawnSync('/bin/ps', args, { env: { LC_ALL: 'C' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { stdout: result.stdout, status: result.status };
};

/** Command last: with `-E`, its column runs on into the environment. */
const PS_COLUMNS = 'pid=,ppid=,stat=,lstart=,command=';

/** Every process, each with its environment. */
const FULL_LISTING = ['-axwwE', '-o', PS_COLUMNS];

type PsRow = { pid: number; ppid: number; state: string; startTime: string; command: string };

// pid, ppid, state, then lstart's five words (`Wed Oct  1 12:47:03 2026`),
// then the command, which runs to the end of the line.
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s(.*))?$/;

function parsePs(output: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of output.split('\n')) {
    const match = PS_ROW.exec(line);
    if (match === null) {
      continue;
    }
    const [, pid, ppid, state, lstart, command] = match;
    if (pid === undefined || ppid === undefined || state === undefined || lstart === undefined) {
      continue;
    }
    rows.push({ pid: Number(pid), ppid: Number(ppid), state, startTime: lstart.split(/\s+/).join(' '), command: (command ?? '').trim() });
  }
  return rows;
}

/**
 * Whether `entry` is one whole space-separated word of a `ps -E` line. The
 * command and the environment share the line, space-joined, so a config dir
 * whose path holds a space can match the wrong words.
 */
function holdsEntry(line: string, entry: string): boolean {
  return ` ${line} `.includes(` ${entry} `);
}

/**
 * The process list read from `ps`. macOS leaves the environment of its own
 * platform binaries (`/bin/sh`, `/bin/sleep`) out of `ps -E`, so a tagged one
 * of those is never found.
 */
export class MacProcessTable implements IProcessTable {
  private readonly ps: RunPs;
  private readonly kill: Kill;
  private readonly ownPid: number;

  public constructor(ps: RunPs, kill: Kill, ownPid: number) {
    this.ps = ps;
    this.kill = kill;
    this.ownPid = ownPid;
  }

  /** Runs the full listing once, strictly. */
  public check(): void {
    this.listing(true);
  }

  public tagged(entry: string, options: { withOwnDescendants?: boolean; strict?: boolean } = {}): TaggedProcess[] {
    const strict = options.strict === true;
    const rows = this.listing(strict);
    const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
    const excluded = this.selfAndAncestors(parents);
    const candidates = rows.filter((row) => !excluded.has(row.pid) && !row.state.startsWith('Z') && holdsEntry(row.command, entry) && (options.withOwnDescendants === true || !this.descendsFromSelf(row.ppid, parents)));
    if (candidates.length === 0) {
      return [];
    }
    // Read again without -E: the command line on its own, holding no environment.
    const plain = new Map(
      this.rows(
        candidates.map((row) => row.pid),
        strict,
      ).map((row) => [row.pid, row]),
    );
    const found: TaggedProcess[] = [];
    for (const row of candidates) {
      const again = plain.get(row.pid);
      const commandLine = again !== undefined && again.startTime === row.startTime ? again.command : undefined;
      // Where the -E line starts with the command line, only what follows it
      // is the environment, so a tag named in the arguments alone is no match.
      if (commandLine !== undefined && row.command.startsWith(commandLine) && !holdsEntry(row.command.slice(commandLine.length), entry)) {
        continue;
      }
      // The command line is empty when the process went, or its pid was
      // reused, between the two reads.
      found.push({ pid: row.pid, startTime: row.startTime, commandLine: commandLine ?? '' });
    }
    return found;
  }

  public signal(process: ProcessIdentity, signal: NodeJS.Signals, options: { strict?: boolean } = {}): boolean {
    const [row] = this.rows([process.pid], options.strict === true);
    if (row === undefined || row.startTime !== process.startTime) {
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
   * The rows of these pids that are still running. ps exits non-zero when a
   * named pid has gone, which is its answer, not a failure: its stdout still
   * holds the rows of those that are running.
   */
  private rows(pids: number[], strict: boolean): PsRow[] {
    return parsePs(this.read(['-ww', '-o', PS_COLUMNS, '-p', pids.join(',')], strict)?.stdout ?? '');
  }

  /**
   * Every process, with its environment. A listing that can't be run or
   * exits non-zero throws when `strict`, and otherwise reads as no processes.
   */
  private listing(strict: boolean): PsRow[] {
    const listing = this.read(FULL_LISTING, strict);
    if (listing === undefined) {
      return [];
    }
    if (listing.status !== 0) {
      if (strict) {
        throw new ProcessListUnreadable(`ps exited with ${listing.status ?? 'a signal'} listing every process`);
      }
      return [];
    }
    return parsePs(listing.stdout);
  }

  /** What ps answered. When it can't be run: thrown when `strict`, otherwise undefined. */
  private read(args: string[], strict: boolean): PsOutput | undefined {
    try {
      return this.ps(args);
    } catch (err) {
      if (strict) {
        throw new ProcessListUnreadable('ps could not be run', { cause: err });
      }
      return undefined;
    }
  }

  /** A process started from a tagged shell carries the tag itself; it and what started it are never leftovers. */
  private selfAndAncestors(parents: Map<number, number>): Set<number> {
    const pids = new Set<number>();
    let pid: number | undefined = this.ownPid;
    while (pid !== undefined && pid > 0 && !pids.has(pid) && pids.size < MAX_ANCESTORS) {
      pids.add(pid);
      pid = parents.get(pid);
    }
    return pids;
  }

  /** As on Linux: what descends from this process is its own; a leftover's parents lead to launchd instead. */
  private descendsFromSelf(ppid: number, parents: Map<number, number>): boolean {
    let pid: number | undefined = ppid;
    for (let links = 0; pid !== undefined && pid > 0 && links < MAX_ANCESTORS; links++) {
      if (pid === this.ownPid) {
        return true;
      }
      pid = parents.get(pid);
    }
    return false;
  }
}
