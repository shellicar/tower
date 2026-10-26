import { describe, expect, it } from 'vitest';
import { Leftovers } from '../src/Leftovers.js';
import { ProcessListUnreadable } from '../src/ProcessTable.js';
import { testServices } from './support.js';

const TAG = 'TOWER_PARTICIPANT=/agents/alpha/config';

function setUp() {
  const services = testServices();
  const lines: string[] = [];
  const shutdown = new AbortController();
  const stop = () => services.provider.resolve(Leftovers).stop((line) => lines.push(line), shutdown.signal);
  return { ...services, lines, stop, shutdown };
}

describe('Leftovers', () => {
  it('signals nothing when nothing is tagged', async () => {
    const { stop, processTable } = setUp();
    processTable.add(200, 'TOWER_PARTICIPANT=/agents/beta/config');
    await stop();
    expect(processTable.signals).toEqual([]);
  });

  it('reports nothing when nothing is tagged', async () => {
    const { stop, lines } = setUp();
    await stop();
    expect(lines).toEqual([]);
  });

  it('sends SIGINT to every process tagged with the config dir', async () => {
    const { stop, processTable } = setUp();
    processTable.add(200, TAG);
    processTable.add(201, TAG);
    await stop();
    expect(processTable.signals).toEqual([
      { pid: 200, signal: 'SIGINT' },
      { pid: 201, signal: 'SIGINT' },
    ]);
  });

  it('goes no further once they have all stopped', async () => {
    const { stop, processTable } = setUp();
    processTable.add(200, TAG, ['SIGINT']);
    await stop();
    expect(processTable.signals.map((s) => s.signal)).toEqual(['SIGINT']);
  });

  it('sends SIGTERM to what is still there after the SIGINT wait', async () => {
    const { stop, processTable } = setUp();
    processTable.add(200, TAG, ['SIGINT']);
    processTable.add(201, TAG, ['SIGTERM']);
    await stop();
    expect(processTable.signals).toEqual([
      { pid: 200, signal: 'SIGINT' },
      { pid: 201, signal: 'SIGINT' },
      { pid: 201, signal: 'SIGTERM' },
    ]);
  });

  it('waits 5 s after SIGINT before SIGTERM', async () => {
    const { stop, processTable, timer } = setUp();
    processTable.add(200, TAG, ['SIGTERM']);
    let sigtermAt: number | undefined;
    const signal = processTable.signal.bind(processTable);
    processTable.signal = (process, sent) => {
      if (sent === 'SIGTERM') {
        sigtermAt = timer.now();
      }
      return signal(process, sent);
    };
    await stop();
    expect(sigtermAt).toBe(5_000);
  });

  it('sends SIGKILL 5 s after SIGTERM', async () => {
    const { stop, processTable, timer } = setUp();
    processTable.add(200, TAG, ['SIGKILL']);
    let sigkillAt: number | undefined;
    const signal = processTable.signal.bind(processTable);
    processTable.signal = (process, sent) => {
      if (sent === 'SIGKILL') {
        sigkillAt = timer.now();
      }
      return signal(process, sent);
    };
    await stop();
    expect(sigkillAt).toBe(10_000);
  });

  it('stops waiting as soon as everything has gone', async () => {
    const { stop, processTable, timer } = setUp();
    processTable.add(200, TAG, []);
    timer.onSleep = (now) => {
      if (now >= 1_000) {
        processTable.processes = [];
      }
    };
    await stop();
    expect(timer.now()).toBe(1_000);
  });

  it('signals a process that appeared during an earlier wait', async () => {
    const { stop, processTable, timer } = setUp();
    processTable.add(200, TAG, ['SIGKILL']);
    timer.onSleep = (now) => {
      if (now === 50) {
        processTable.add(300, TAG);
      }
    };
    await stop();
    expect(processTable.signals.filter((s) => s.pid === 300)).toEqual([{ pid: 300, signal: 'SIGTERM' }]);
  });

  it('returns what is still there after SIGKILL, so the participant serves anyway', async () => {
    const { stop, processTable } = setUp();
    processTable.add(200, TAG, []);
    expect((await stop()).remaining.map((p) => p.pid)).toEqual([200]);
  });

  it('reports what is still there after SIGKILL', async () => {
    const { stop, processTable, lines } = setUp();
    processTable.add(200, TAG, []);
    await stop();
    expect(lines.at(-1)).toBe('leftovers: still there after SIGKILL, serving anyway: 200 (cmd-200)');
  });

  it('reports what it found', async () => {
    const { stop, processTable, lines } = setUp();
    processTable.add(200, TAG);
    await stop();
    expect(lines[0]).toBe('leftovers: 1 process(es) left running on /agents/alpha/config: 200 (cmd-200)');
  });

  describe('when shutdown begins during the scan', () => {
    function shutDownAt(ms: number) {
      const setup = setUp();
      setup.processTable.add(200, TAG, []);
      setup.timer.onSleep = (now) => {
        if (now === ms) {
          setup.shutdown.abort();
        }
      };
      return setup;
    }

    it('stops waiting at once', async () => {
      const { stop, timer } = shutDownAt(1_000);
      await stop();
      expect(timer.now()).toBe(1_000);
    });

    it('sends no further signal', async () => {
      const { stop, processTable } = shutDownAt(1_000);
      await stop();
      expect(processTable.signals.map((s) => s.signal)).toEqual(['SIGINT']);
    });

    it('says the scan was interrupted', async () => {
      const { stop } = shutDownAt(1_000);
      expect((await stop()).interrupted).toBe(true);
    });

    it('reports what it left', async () => {
      const { stop, lines } = shutDownAt(1_000);
      await stop();
      expect(lines.at(-1)).toBe('leftovers: scan stopped for shutdown, leaving 200 (cmd-200)');
    });

    it('ends as interrupted, without failing, when the process list then cannot be read', async () => {
      const setup = setUp();
      setup.processTable.add(200, TAG, []);
      setup.timer.onSleep = (now) => {
        if (now === 1_000) {
          setup.shutdown.abort();
          setup.processTable.unreadable = true;
        }
      };
      expect(await setup.stop()).toEqual({ interrupted: true, remaining: [] });
    });

    it('ends as interrupted when shutdown begins during a read that then fails', async () => {
      const setup = setUp();
      setup.processTable.add(200, TAG, []);
      const tagged = setup.processTable.tagged.bind(setup.processTable);
      setup.processTable.tagged = (entry, options) => {
        if (setup.timer.now() >= 1_000 && !setup.shutdown.signal.aborted) {
          setup.shutdown.abort();
          throw new ProcessListUnreadable('ps could not be run');
        }
        return tagged(entry, options);
      };
      expect((await setup.stop()).interrupted).toBe(true);
    });
  });

  it('ends as interrupted when shutdown began before the scan, with nothing tagged', async () => {
    const { stop, shutdown } = setUp();
    shutdown.abort();
    expect((await stop()).interrupted).toBe(true);
  });

  it('fails when the process list cannot be read and shutdown has not begun', async () => {
    const { stop, processTable } = setUp();
    processTable.add(200, TAG, []);
    processTable.unreadable = true;
    await expect(stop()).rejects.toThrow(ProcessListUnreadable);
  });

  it('says a finished scan was not interrupted', async () => {
    const { stop, processTable } = setUp();
    processTable.add(200, TAG);
    expect((await stop()).interrupted).toBe(false);
  });
});
