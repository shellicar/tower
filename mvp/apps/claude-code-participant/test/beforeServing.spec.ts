import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { beforeServing } from '../src/beforeServing.js';
import { LOCK_FILE } from '../src/ParticipantLock.js';
import { StartupError } from '../src/startup.js';
import { testConfig, testServices } from './support.js';

const scratch = mkdtempSync(join(tmpdir(), 'participant-before-serving-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function setUp() {
  const configDir = mkdtempSync(join(scratch, 'config-'));
  const services = testServices(testConfig({ configDir }));
  return { ...services, configDir, tag: `TOWER_PARTICIPANT=${configDir}` };
}

const quiet = () => {};

describe('beforeServing', () => {
  it('refuses to start on a platform without a process table', async () => {
    const { provider } = setUp();
    await expect(beforeServing(provider, 'darwin', quiet)).rejects.toThrow(StartupError);
  });

  it('refuses to start while another participant holds the config dir', async () => {
    const { provider, configDir, processTable } = setUp();
    writeFileSync(join(configDir, LOCK_FILE), JSON.stringify({ pid: 200, startTime: '2000' }));
    processTable.add(200, 'untagged');
    await expect(beforeServing(provider, 'linux', quiet)).rejects.toThrow('another participant (pid 200) is running on');
  });

  it('stops nothing when another participant holds the config dir', async () => {
    const { provider, configDir, processTable, tag } = setUp();
    writeFileSync(join(configDir, LOCK_FILE), JSON.stringify({ pid: 200, startTime: '2000' }));
    processTable.add(200, 'untagged');
    processTable.add(201, tag);
    await beforeServing(provider, 'linux', quiet).catch(() => {});
    expect(processTable.signals).toEqual([]);
  });

  it("stops an earlier run's leftovers once it holds the lock", async () => {
    const { provider, processTable, tag } = setUp();
    processTable.add(201, tag);
    await beforeServing(provider, 'linux', quiet);
    expect(processTable.processes).toEqual([]);
  });
});
