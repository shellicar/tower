import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { MacProcessTable, ProcessListUnreadable, realPs } from '../src/ProcessTable.js';

type FakeProcess = {
  pid: number;
  ppid?: number;
  state?: string;
  /** As `ps -o lstart` prints it in the C locale. */
  lstart?: string;
  command?: string;
  /** Left out of `ps -E` for an Apple platform binary. */
  environ?: string[];
};

const TAG = 'TOWER_PARTICIPANT=/agents/alpha/config';
const OWN_PID = 100;

function psLine(p: FakeProcess, withEnvironment: boolean): string {
  const command = [p.command ?? 'proc', ...(withEnvironment ? (p.environ ?? []) : [])].join(' ');
  return `${String(p.pid).padStart(5)} ${String(p.ppid ?? 1).padStart(5)} ${(p.state ?? 'S').padEnd(4)} ${p.lstart ?? 'Wed Oct  1 12:47:03 2026'}    ${command}`;
}

/** A ps answer that exits 0, unless a status is given. */
const answer = (stdout: string, status: number | null = 0) => ({ stdout, status });

/**
 * `ps` over these processes (and this process, pid 100, unless listed),
 * answering the two forms the table asks for. A `-p` read naming a pid that
 * isn't running exits 1, with the rows of those that are.
 */
function fakePs(processes: FakeProcess[]) {
  const all = processes.some((p) => p.pid === OWN_PID) ? processes : [...processes, { pid: OWN_PID, ppid: 1 }];
  const calls: string[][] = [];
  const ps = (args: string[]) => {
    calls.push(args);
    const listed = args.indexOf('-p');
    const pids = listed < 0 ? undefined : (args[listed + 1] ?? '').split(',').map(Number);
    const shown = pids === undefined ? all : all.filter((p) => pids.includes(p.pid));
    const stdout = shown
      .map(
        (p) =>
          `${psLine(
            p,
            args.some((arg) => arg.startsWith('-') && arg.includes('E')),
          )}\n`,
      )
      .join('');
    return answer(stdout, pids !== undefined && shown.length < pids.length ? 1 : 0);
  };
  return { ps, calls };
}

function macTable(processes: FakeProcess[], kill: (pid: number, signal: NodeJS.Signals) => void = () => {}) {
  const { ps, calls } = fakePs(processes);
  const signals: { pid: number; signal: NodeJS.Signals }[] = [];
  const table = new MacProcessTable(
    ps,
    (pid, signal) => {
      kill(pid, signal);
      signals.push({ pid, signal });
    },
    OWN_PID,
  );
  return { table, signals, calls };
}

function taggedPids(processes: FakeProcess[]): number[] {
  return macTable(processes)
    .table.tagged(TAG)
    .map((p) => p.pid);
}

describe('MacProcessTable', () => {
  describe('tagged', () => {
    it('finds a process carrying the tag', () => {
      expect(taggedPids([{ pid: 200, environ: ['PATH=/usr/bin', TAG] }])).toEqual([200]);
    });

    it('finds a process whose tag is the last word of the line', () => {
      expect(taggedPids([{ pid: 200, environ: [TAG] }])).toEqual([200]);
    });

    it('skips a process without it', () => {
      expect(taggedPids([{ pid: 200, environ: ['PATH=/usr/bin'] }])).toEqual([]);
    });

    it('matches the whole entry, not a config dir that starts the same', () => {
      expect(taggedPids([{ pid: 200, environ: [`${TAG}-beta`] }])).toEqual([]);
    });

    it('matches the whole entry, not a longer variable that ends the same', () => {
      expect(taggedPids([{ pid: 200, environ: [`X${TAG}`] }])).toEqual([]);
    });

    it('skips a process that names the tag only in its arguments', () => {
      expect(taggedPids([{ pid: 200, command: `grep ${TAG}`, environ: [] }])).toEqual([]);
    });

    it('finds a process that names the tag in its arguments and carries it', () => {
      expect(taggedPids([{ pid: 200, command: `grep ${TAG}`, environ: [TAG] }])).toEqual([200]);
    });

    it('matches on the whole line when the process went between the two reads', () => {
      const withEnvironment = `  200     1 S    Wed Oct  1 12:47:03 2026     proc ${TAG}\n`;
      const table = new MacProcessTable(
        (args) => (args.includes('-axwwE') ? answer(withEnvironment) : answer('', 1)),
        () => {},
        OWN_PID,
      );
      expect(table.tagged(TAG)).toEqual([{ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026', commandLine: '' }]);
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

    describe('with its own descendants', () => {
      function withOwn(processes: FakeProcess[]): number[] {
        return macTable(processes)
          .table.tagged(TAG, { withOwnDescendants: true })
          .map((p) => p.pid);
      }

      it('finds a process this one started', () => {
        expect(withOwn([{ pid: 300, ppid: OWN_PID, environ: [TAG] }])).toEqual([300]);
      });

      it('finds a process started by one this one started', () => {
        expect(
          withOwn([
            { pid: 300, ppid: OWN_PID, environ: [] },
            { pid: 301, ppid: 300, environ: [TAG] },
          ]),
        ).toEqual([301]);
      });

      it('still skips this process', () => {
        expect(withOwn([{ pid: OWN_PID, ppid: 1, environ: [TAG] }])).toEqual([]);
      });

      it('still skips what started this process', () => {
        expect(
          withOwn([
            { pid: OWN_PID, ppid: 50, environ: [TAG] },
            { pid: 50, ppid: 1, environ: [TAG] },
          ]),
        ).toEqual([]);
      });
    });

    it('finds a leftover whose parents lead to launchd', () => {
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

    it('reads the start time as one word per field', () => {
      expect(macTable([{ pid: 200, lstart: 'Wed Oct  1 12:47:03 2026', environ: [TAG] }]).table.tagged(TAG)[0]?.startTime).toBe('Wed Oct 1 12:47:03 2026');
    });

    it('reads the command line without the environment', () => {
      expect(macTable([{ pid: 200, command: '/opt/sdk/claude --output-format stream-json', environ: ['PATH=/usr/bin', TAG] }]).table.tagged(TAG)[0]?.commandLine).toBe('/opt/sdk/claude --output-format stream-json');
    });

    it('asks for every process with its environment, then the matches without', () => {
      const { table, calls } = macTable([{ pid: 200, environ: [TAG] }]);
      table.tagged(TAG);
      expect(calls).toEqual([
        ['-axwwE', '-o', 'pid=,ppid=,stat=,lstart=,command='],
        ['-ww', '-o', 'pid=,ppid=,stat=,lstart=,command=', '-p', '200'],
      ]);
    });

    it('asks only once when nothing matches', () => {
      const { table, calls } = macTable([{ pid: 200, environ: [] }]);
      table.tagged(TAG);
      expect(calls).toHaveLength(1);
    });

    it('reads a line ps printed', () => {
      const withEnvironment = '  812     1 S    Wed Oct  1 09:05:44 2026     /opt/sdk/claude --resume abc PATH=/usr/bin TOWER_PARTICIPANT=/agents/alpha/config\n';
      const plain = '  812     1 S    Wed Oct  1 09:05:44 2026     /opt/sdk/claude --resume abc\n';
      const table = new MacProcessTable(
        (args) => answer(args.includes('-axwwE') ? withEnvironment : plain),
        () => {},
        OWN_PID,
      );
      expect(table.tagged(TAG).map((p) => [p.pid, p.startTime])).toEqual([[812, 'Wed Oct 1 09:05:44 2026']]);
    });
  });

  describe('when ps cannot be run', () => {
    const cannotRun = () => {
      throw new Error('spawnSync /bin/ps EPERM');
    };
    const table = () => new MacProcessTable(cannotRun, () => {}, OWN_PID);

    it('fails the launch check', () => {
      expect(() => table().check()).toThrow('ps could not be run');
    });

    it('finds nothing afterwards, without throwing', () => {
      expect(table().tagged(TAG)).toEqual([]);
    });

    it('signals nothing afterwards, without throwing', () => {
      expect(table().signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT')).toBe(false);
    });

    it('fails a strict search', () => {
      expect(() => table().tagged(TAG, { strict: true })).toThrow(ProcessListUnreadable);
    });

    it('fails a strict signal', () => {
      expect(() => table().signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT', { strict: true })).toThrow(ProcessListUnreadable);
    });

    it('keeps the cause of a strict failure', () => {
      let failure: unknown;
      try {
        table().tagged(TAG, { strict: true });
      } catch (err) {
        failure = err;
      }
      expect(failure instanceof Error && failure.cause instanceof Error ? failure.cause.message : failure).toBe('spawnSync /bin/ps EPERM');
    });
  });

  describe('when the full listing exits non-zero', () => {
    const tagged = `  200     1 S    Wed Oct  1 12:47:03 2026     proc ${TAG}\n`;
    const table = () =>
      new MacProcessTable(
        (args) => (args.includes('-axwwE') ? answer(tagged, 1) : answer(tagged)),
        () => {},
        OWN_PID,
      );

    it('fails the launch check', () => {
      expect(() => table().check()).toThrow('ps exited with 1 listing every process');
    });

    it('fails the launch check when a signal ended it', () => {
      expect(() =>
        new MacProcessTable(
          () => answer('', null),
          () => {},
          OWN_PID,
        ).check(),
      ).toThrow('ps exited with a signal listing every process');
    });

    it('finds nothing afterwards, without throwing', () => {
      expect(table().tagged(TAG)).toEqual([]);
    });

    it('fails a strict search', () => {
      expect(() => table().tagged(TAG, { strict: true })).toThrow(ProcessListUnreadable);
    });
  });

  it('passes the launch check when ps runs', () => {
    expect(() => macTable([]).table.check()).not.toThrow();
  });

  describe('a read of named pids that exits non-zero', () => {
    it('reads as the process having gone, without failing', () => {
      const table = new MacProcessTable(
        () => answer('', 1),
        () => {},
        OWN_PID,
      );
      expect(table.signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT')).toBe(false);
    });

    it('reads as the process having gone in a strict signal too', () => {
      const table = new MacProcessTable(
        () => answer('', 1),
        () => {},
        OWN_PID,
      );
      expect(table.signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT', { strict: true })).toBe(false);
    });

    it('still gives the rows of the named pids that are running', () => {
      const running: FakeProcess = { pid: 200, command: 'proc', environ: [TAG] };
      const going: FakeProcess = { pid: 201, command: 'proc', environ: [TAG] };
      // 201 goes between the two reads, so the -p read names it and exits 1.
      const ps = (args: string[]) => (args.includes('-p') ? answer(`${psLine(running, false)}\n`, 1) : answer(`${psLine(running, true)}\n${psLine(going, true)}\n`));
      const table = new MacProcessTable(ps, () => {}, OWN_PID);
      expect(table.tagged(TAG).map((p) => [p.pid, p.commandLine])).toEqual([
        [200, 'proc'],
        [201, ''],
      ]);
    });
  });

  describe('signal', () => {
    it('signals a process whose start time still matches', () => {
      const { table, signals } = macTable([{ pid: 200, lstart: 'Wed Oct  1 12:47:03 2026' }]);
      table.signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT');
      expect(signals).toEqual([{ pid: 200, signal: 'SIGINT' }]);
    });

    it('never signals a later process given the same pid', () => {
      const { table, signals } = macTable([{ pid: 200, lstart: 'Wed Oct  1 12:50:00 2026' }]);
      table.signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT');
      expect(signals).toEqual([]);
    });

    it('says it was not sent when the process has gone', () => {
      const { table } = macTable([]);
      expect(table.signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT')).toBe(false);
    });

    it('says it was not sent when the process went before the signal', () => {
      const { table } = macTable([{ pid: 200 }], () => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });
      expect(table.signal({ pid: 200, startTime: 'Wed Oct 1 12:47:03 2026' }, 'SIGINT')).toBe(false);
    });
  });
});

describe.skipIf(process.platform !== 'darwin')('MacProcessTable on the real ps', () => {
  // The processes these tests start are this process's children, which a
  // table reading as this process skips; this table reads as no process at
  // all (pid 0 is never a process's own). Each is node, not sleep: macOS
  // hides the environment of its own binaries from ps.
  const table = new MacProcessTable(realPs, process.kill, 0);
  const configDir = `/tmp/participant-ps-test-${process.pid}`;
  const tag = `TOWER_PARTICIPANT=${configDir}`;
  let child: ChildProcess | undefined;

  function startTagged(): ChildProcess {
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env: { PATH: process.env.PATH, TOWER_PARTICIPANT: configDir }, stdio: 'ignore' });
    return child;
  }

  afterEach(async () => {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    child = undefined;
  });

  it('reads a start time that matches when the process started', async () => {
    const started = startTagged();
    await once(started, 'spawn');
    const startedAt = Date.parse(table.tagged(tag)[0]?.startTime ?? '');
    expect(Math.abs(startedAt - Date.now())).toBeLessThan(5_000);
  });

  it('finds a tagged process', async () => {
    const started = startTagged();
    await once(started, 'spawn');
    expect(table.tagged(tag).map((p) => p.pid)).toEqual([started.pid]);
  });

  it('reads its command line without the environment', async () => {
    const started = startTagged();
    await once(started, 'spawn');
    expect(table.tagged(tag)[0]?.commandLine).toBe(`${process.execPath} -e setTimeout(() => {}, 30000)`);
  });

  it('passes the launch check', () => {
    expect(() => table.check()).not.toThrow();
  });

  it('gives the running pid when a read names it beside one that has gone', async () => {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(gone, 'exit');
    const started = startTagged();
    await once(started, 'spawn');
    const { stdout } = realPs(['-ww', '-o', 'pid=', '-p', `${started.pid},${gone.pid}`]);
    expect(stdout.trim().split(/\s+/).map(Number)).toEqual([started.pid]);
  });

  it('skips a tagged process this one started', async () => {
    const started = startTagged();
    await once(started, 'spawn');
    expect(new MacProcessTable(realPs, process.kill, process.pid).tagged(tag)).toEqual([]);
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
