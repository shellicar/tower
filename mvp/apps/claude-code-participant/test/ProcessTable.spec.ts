import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { LinuxProcessTable } from '../src/ProcessTable.js';

const scratch = mkdtempSync(join(tmpdir(), 'participant-proc-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type FakeThread = { tid: number; state: string; environ?: string[] | 'unreadable' };

type FakeProcess = {
  pid: number;
  comm?: string;
  state?: string;
  ppid?: number;
  startTime?: string;
  /** 'unreadable' makes the read fail, as EACCES does in a process's last moments. */
  environ?: string[] | 'unreadable';
  cmdline?: string[];
  threads?: FakeThread[];
  /** A process that vanished mid-scan: its directory listed, its files gone. */
  vanished?: boolean;
};

const TAG = 'TOWER_PARTICIPANT=/agents/alpha/config';
const OWN_PID = 100;

function statLine(pid: number, comm: string, state: string, ppid: number, startTime: string): string {
  // Fields 3 to 22: state, ppid, pgrp, session, tty, tpgid, flags, four
  // fault counts, four times, priority, nice, threads, itrealvalue, starttime.
  return `${pid} (${comm}) ${state} ${ppid} ${pid} ${pid} 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${startTime} 0 0\n`;
}

function writeEnviron(path: string, environ: string[] | 'unreadable' | undefined): void {
  if (environ === 'unreadable') {
    mkdirSync(path);
    return;
  }
  writeFileSync(path, (environ ?? []).map((entry) => `${entry}\0`).join(''));
}

let tables = 0;
/** A /proc tree holding these processes (and this process, pid 100, unless listed), read by a table that records its signals. */
function procTable(processes: FakeProcess[], kill: (pid: number, signal: NodeJS.Signals) => void = () => {}) {
  const root = join(scratch, `proc-${tables++}`);
  const all = processes.some((p) => p.pid === OWN_PID) ? processes : [...processes, { pid: OWN_PID, ppid: 1, startTime: '500' }];
  for (const p of all) {
    const dir = join(root, String(p.pid));
    mkdirSync(join(dir, 'task'), { recursive: true });
    if (p.vanished) {
      continue;
    }
    writeFileSync(join(dir, 'stat'), statLine(p.pid, p.comm ?? 'proc', p.state ?? 'S', p.ppid ?? 1, p.startTime ?? '1000'));
    writeEnviron(join(dir, 'environ'), p.environ);
    writeFileSync(join(dir, 'cmdline'), (p.cmdline ?? ['proc']).map((arg) => `${arg}\0`).join(''));
    for (const thread of p.threads ?? [{ tid: p.pid, state: p.state ?? 'S', environ: p.environ }]) {
      const taskDir = join(dir, 'task', String(thread.tid));
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, 'stat'), statLine(thread.tid, p.comm ?? 'proc', thread.state, p.ppid ?? 1, p.startTime ?? '1000'));
      writeEnviron(join(taskDir, 'environ'), thread.environ);
    }
  }
  mkdirSync(join(root, 'self'), { recursive: true });
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const table = new LinuxProcessTable(
    root,
    (pid, signal) => {
      kill(pid, signal);
      signals.push({ pid, signal });
    },
    OWN_PID,
  );
  return { table, signals };
}

function taggedPids(processes: FakeProcess[]): number[] {
  return procTable(processes)
    .table.tagged(TAG)
    .map((p) => p.pid);
}

describe('LinuxProcessTable', () => {
  describe('own', () => {
    it('reads its start time from field 22 of its stat', () => {
      expect(procTable([{ pid: OWN_PID, startTime: '424242' }]).table.own()).toEqual({ pid: OWN_PID, startTime: '424242' });
    });
  });

  describe('tagged', () => {
    it('finds a process carrying the tag', () => {
      expect(taggedPids([{ pid: 200, environ: ['PATH=/usr/bin', TAG] }])).toEqual([200]);
    });

    it('skips a process without it', () => {
      expect(taggedPids([{ pid: 200, environ: ['PATH=/usr/bin'] }])).toEqual([]);
    });

    it('matches the whole entry, not a config dir that starts the same', () => {
      expect(taggedPids([{ pid: 200, environ: [`${TAG}-beta`] }])).toEqual([]);
    });

    it('skips this process', () => {
      expect(taggedPids([{ pid: OWN_PID, ppid: 1, environ: [TAG] }])).toEqual([]);
    });

    it('skips what started this process', () => {
      expect(
        taggedPids([
          { pid: OWN_PID, ppid: 50, environ: [TAG] },
          { pid: 50, ppid: 1, environ: [TAG] },
        ]),
      ).toEqual([]);
    });

    it('skips a process this one started', () => {
      expect(taggedPids([{ pid: 300, ppid: OWN_PID, environ: [TAG] }])).toEqual([]);
    });

    it('skips a process started by one this one started', () => {
      expect(
        taggedPids([
          { pid: 300, ppid: OWN_PID, environ: [] },
          { pid: 301, ppid: 300, environ: [TAG] },
        ]),
      ).toEqual([]);
    });

    it('finds a leftover whose parents lead to init', () => {
      expect(
        taggedPids([
          { pid: 400, ppid: 1, environ: [] },
          { pid: 401, ppid: 400, environ: [TAG] },
        ]),
      ).toEqual([401]);
    });

    it('skips a process that has exited but not been reaped', () => {
      expect(taggedPids([{ pid: 200, state: 'Z', environ: [TAG] }])).toEqual([]);
    });

    it('finds a process whose main thread has exited while another still runs', () => {
      expect(
        taggedPids([
          {
            pid: 200,
            state: 'Z',
            environ: [],
            threads: [
              { tid: 200, state: 'Z', environ: [] },
              { tid: 201, state: 'S', environ: [TAG] },
            ],
          },
        ]),
      ).toEqual([200]);
    });

    it("reads another thread's environment when the main thread's is refused", () => {
      expect(
        taggedPids([
          {
            pid: 200,
            environ: 'unreadable',
            threads: [
              { tid: 200, state: 'S', environ: 'unreadable' },
              { tid: 201, state: 'S', environ: [TAG] },
            ],
          },
        ]),
      ).toEqual([200]);
    });

    it('skips a process that vanished mid-scan', () => {
      expect(
        taggedPids([
          { pid: 200, vanished: true },
          { pid: 300, environ: [TAG] },
        ]),
      ).toEqual([300]);
    });

    it('reads the start time past a command name holding spaces and parentheses', () => {
      expect(procTable([{ pid: 200, comm: 'a) b (c', startTime: '777', environ: [TAG] }]).table.tagged(TAG)[0]?.startTime).toBe('777');
    });

    it('reads the command line in full', () => {
      const long = `/home/someone/.local/share/pnpm/store/v11/links/@anthropic-ai/claude-agent-sdk-linux-x64/0.3.283/node_modules/claude`;
      expect(procTable([{ pid: 200, environ: [TAG], cmdline: [long, '--output-format', 'stream-json'] }]).table.tagged(TAG)[0]?.commandLine).toBe(`${long} --output-format stream-json`);
    });
  });

  describe('isRunning', () => {
    it('is true for the same pid and start time', () => {
      expect(procTable([{ pid: 200, startTime: '1000' }]).table.isRunning({ pid: 200, startTime: '1000' })).toBe(true);
    });

    it('is false once the pid belongs to a later process', () => {
      expect(procTable([{ pid: 200, startTime: '2000' }]).table.isRunning({ pid: 200, startTime: '1000' })).toBe(false);
    });

    it('is false once the process is gone', () => {
      expect(procTable([]).table.isRunning({ pid: 200, startTime: '1000' })).toBe(false);
    });

    it('is false once every thread has exited', () => {
      expect(procTable([{ pid: 200, state: 'Z' }]).table.isRunning({ pid: 200, startTime: '1000' })).toBe(false);
    });

    it('is true while a thread still runs after the main thread exited', () => {
      const threads = [
        { tid: 200, state: 'Z' },
        { tid: 201, state: 'R' },
      ];
      expect(procTable([{ pid: 200, state: 'Z', threads }]).table.isRunning({ pid: 200, startTime: '1000' })).toBe(true);
    });
  });

  describe('signal', () => {
    it('signals a process whose start time still matches', () => {
      const { table, signals } = procTable([{ pid: 200, startTime: '1000' }]);
      table.signal({ pid: 200, startTime: '1000' }, 'SIGINT');
      expect(signals).toEqual([{ pid: 200, signal: 'SIGINT' }]);
    });

    it('never signals a later process given the same pid', () => {
      const { table, signals } = procTable([{ pid: 200, startTime: '2000' }]);
      table.signal({ pid: 200, startTime: '1000' }, 'SIGINT');
      expect(signals).toEqual([]);
    });

    it('says it was not sent when the process went before the signal', () => {
      const { table } = procTable([{ pid: 200, startTime: '1000' }], () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });
      expect(table.signal({ pid: 200, startTime: '1000' }, 'SIGINT')).toBe(false);
    });
  });
});

describe.skipIf(process.platform !== 'linux')('LinuxProcessTable on the real /proc', () => {
  // The processes these tests start are this process's children, which a
  // table reading as this process skips; this table reads as no process at
  // all (pid 0 is never a process's own).
  const table = new LinuxProcessTable('/proc', process.kill, 0);
  const tag = `TOWER_PARTICIPANT=${join(scratch, `real-${process.pid}`)}`;
  let child: ChildProcess | undefined;

  function startTagged(): ChildProcess {
    const [name, value] = [tag.slice(0, tag.indexOf('=')), tag.slice(tag.indexOf('=') + 1)];
    child = spawn('sleep', ['30'], { env: { PATH: process.env.PATH, [name]: value }, stdio: 'ignore' });
    return child;
  }

  afterEach(async () => {
    // Only the child this test started, by its handle.
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    child = undefined;
  });

  it('reads a start time that matches when the process started', async () => {
    // Field 22 counts clock ticks since boot (100 a second on Linux), so a
    // process started just now should read within a few seconds of uptime.
    const started = startTagged();
    await once(started, 'spawn');
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const startedAt = Number(table.tagged(tag)[0]?.startTime) / 100;
    expect(Math.abs(startedAt - uptime)).toBeLessThan(5);
  });

  it('finds a tagged process', async () => {
    const started = startTagged();
    await once(started, 'spawn');
    expect(table.tagged(tag).map((p) => p.pid)).toEqual([started.pid]);
  });

  it('skips a tagged process this one started', async () => {
    const started = startTagged();
    await once(started, 'spawn');
    expect(new LinuxProcessTable('/proc', process.kill, process.pid).tagged(tag)).toEqual([]);
  });

  it('stops a tagged process with a signal', async () => {
    const started = startTagged();
    await once(started, 'spawn');
    const [found] = table.tagged(tag);
    if (found === undefined) {
      throw new Error('the tagged process was not found');
    }
    table.signal(found, 'SIGTERM');
    const [, signal] = await once(started, 'exit');
    expect(signal).toBe('SIGTERM');
  });
});
