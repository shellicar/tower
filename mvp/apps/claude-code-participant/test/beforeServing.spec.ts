import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { beforeServing } from '../src/beforeServing.js';
import { ParticipantLock } from '../src/ParticipantLock.js';
import { ServingGate } from '../src/ServingGate.js';
import { StartupError } from '../src/startup.js';
import { startupExitOf, testConfig, testServices } from './support.js';

const scratch = mkdtempSync(join(tmpdir(), 'participant-before-serving-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function setUp() {
  const configDir = mkdtempSync(join(scratch, 'config-'));
  const services = testServices(testConfig({ configDir }), { gateShut: true });
  const shutdown = new AbortController();
  const run = (platform: NodeJS.Platform = 'linux') => beforeServing(services.provider, platform, () => {}, shutdown.signal);
  /** Another participant on the same config dir, holding its lock. */
  const holdElsewhere = () => testServices(testConfig({ configDir })).provider.resolve(ParticipantLock).acquire();
  /** Whether the serving gate has opened, once everything already queued has run. */
  const gateOpen = () =>
    Promise.race([
      services.provider
        .resolve(ServingGate)
        .wait()
        .then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
  return { ...services, configDir, tag: `TOWER_PARTICIPANT=${configDir}`, shutdown, run, holdElsewhere, gateOpen };
}

describe('beforeServing', () => {
  it('refuses to start on a platform without a process table', () => {
    const { run } = setUp();
    expect(() => run('win32')).toThrow(StartupError);
  });

  it('exits as an unsupported platform', () => {
    const { run } = setUp();
    expect(startupExitOf(() => run('win32'))).toBe('unsupportedPlatform');
  });

  it('says the platform is not supported', () => {
    const { run } = setUp();
    expect(() => run('win32')).toThrow('platform not supported');
  });

  it('refuses to start when the process list cannot be read', () => {
    const { run, processTable } = setUp();
    processTable.checkFailure = new Error('ps could not be run', { cause: new Error('spawnSync /bin/ps EPERM') });
    expect(() => run('darwin')).toThrow(StartupError);
  });

  it('exits as no process list when the process list cannot be read', () => {
    const { run, processTable } = setUp();
    processTable.checkFailure = new Error('ps could not be run');
    expect(startupExitOf(() => run('darwin'))).toBe('noProcessList');
  });

  it('names the underlying cause when the process list cannot be read', () => {
    const { run, processTable } = setUp();
    processTable.checkFailure = new Error('ps could not be run', { cause: new Error('spawnSync /bin/ps EPERM') });
    expect(() => run('darwin')).toThrow('spawnSync /bin/ps EPERM');
  });

  it('keeps the serving gate shut when the process list cannot be read', async () => {
    const { run, processTable, gateOpen } = setUp();
    processTable.checkFailure = new Error('ps could not be run');
    try {
      run('darwin');
    } catch {
      // refused
    }
    expect(await gateOpen()).toBe(false);
  });

  describe('when the process list stops being readable during the scan', () => {
    function unreadableMidScan() {
      const services = setUp();
      services.processTable.add(201, services.tag);
      services.processTable.unreadable = true;
      return services;
    }

    it('fails the start as no process list', async () => {
      const { run } = unreadableMidScan();
      const failure = await run('darwin').then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure instanceof StartupError ? failure.exit : failure).toBe('noProcessList');
    });

    it('names the underlying cause', async () => {
      const { run } = unreadableMidScan();
      await expect(run('darwin')).rejects.toThrow('spawnSync /bin/ps EPERM');
    });

    it('keeps the serving gate shut', async () => {
      const { run, gateOpen } = unreadableMidScan();
      await run('darwin').catch(() => {});
      expect(await gateOpen()).toBe(false);
    });
  });

  describe('when shutdown begins during the scan and the process list then cannot be read', () => {
    function shutDownThenUnreadable() {
      const services = setUp();
      services.processTable.add(201, services.tag, []);
      services.timer.onSleep = (now) => {
        if (now === 1_000) {
          services.shutdown.abort();
          services.processTable.unreadable = true;
        }
      };
      return services;
    }

    it('ends the scan as interrupted rather than failing the start', async () => {
      const { run } = shutDownThenUnreadable();
      expect((await run('darwin')).interrupted).toBe(true);
    });

    it('keeps the serving gate shut', async () => {
      const { run, gateOpen } = shutDownThenUnreadable();
      await run('darwin');
      expect(await gateOpen()).toBe(false);
    });
  });

  it('starts on macOS', async () => {
    const { run, gateOpen } = setUp();
    await run('darwin');
    expect(await gateOpen()).toBe(true);
  });

  it('refuses to start while another participant holds the config dir', () => {
    const { run, holdElsewhere } = setUp();
    holdElsewhere();
    expect(() => run()).toThrow('another participant is running on');
  });

  it('stops nothing when another participant holds the config dir', () => {
    const { run, holdElsewhere, processTable, tag } = setUp();
    holdElsewhere();
    processTable.add(201, tag);
    try {
      run();
    } catch {
      // refused
    }
    expect(processTable.signals).toEqual([]);
  });

  it("stops an earlier run's leftovers once it holds the lock", async () => {
    const { run, processTable, tag } = setUp();
    processTable.add(201, tag);
    await run();
    expect(processTable.processes).toEqual([]);
  });

  it('keeps the serving gate shut while the scan runs', async () => {
    const { run, processTable, tag, timer, provider } = setUp();
    processTable.add(201, tag, ['SIGTERM']);
    let opened = false;
    void provider
      .resolve(ServingGate)
      .wait()
      .then(() => {
        opened = true;
      });
    let openDuringScan: boolean | undefined;
    timer.onSleep = (now) => {
      if (now === 1_000) {
        openDuringScan = opened;
      }
    };
    await run();
    expect(openDuringScan).toBe(false);
  });

  it('opens the serving gate once the scan finishes', async () => {
    const { run, processTable, tag, gateOpen } = setUp();
    processTable.add(201, tag);
    await run();
    expect(await gateOpen()).toBe(true);
  });

  it('keeps the serving gate shut when shutdown stopped the scan', async () => {
    const { run, processTable, tag, shutdown, gateOpen } = setUp();
    processTable.add(201, tag, []);
    shutdown.abort();
    await run();
    expect(await gateOpen()).toBe(false);
  });
});
