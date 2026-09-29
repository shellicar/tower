import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCK_FILE, ParticipantLock } from '../src/ParticipantLock.js';
import { StartupError } from '../src/startup.js';
import { testConfig, testServices } from './support.js';

const scratch = mkdtempSync(join(tmpdir(), 'participant-lock-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dirs = 0;
/** A fresh config dir, with the lock file already holding `held` when given. */
function setUp(held?: string) {
  const configDir = mkdtempSync(join(scratch, `config-${dirs++}-`));
  if (held !== undefined) {
    writeFileSync(join(configDir, LOCK_FILE), held);
  }
  const services = testServices(testConfig({ configDir }));
  const lockText = () => readFileSync(join(configDir, LOCK_FILE), 'utf8');
  return { ...services, configDir, lockText, acquire: () => services.provider.resolve(ParticipantLock).acquire() };
}

const OWN = JSON.stringify({ pid: 100, startTime: '500' });

/** Runs an acquire expected to refuse, for a test that checks what the refusal left behind. */
function refused(acquire: () => void): void {
  try {
    acquire();
  } catch {
    return;
  }
  throw new Error('it did not refuse');
}

describe('ParticipantLock', () => {
  it('takes a lock nobody holds', () => {
    const { acquire, lockText } = setUp();
    acquire();
    expect(lockText()).toBe(OWN);
  });

  it('refuses while another participant runs on the config dir', () => {
    const { acquire, processTable } = setUp(JSON.stringify({ pid: 200, startTime: '2000' }));
    processTable.add(200, 'untagged');
    expect(acquire).toThrow(StartupError);
  });

  it('names the running holder when it refuses', () => {
    const { acquire, processTable } = setUp(JSON.stringify({ pid: 200, startTime: '2000' }));
    processTable.add(200, 'untagged');
    expect(acquire).toThrow('another participant (pid 200) is running on');
  });

  it('leaves a running holder its lock', () => {
    const held = JSON.stringify({ pid: 200, startTime: '2000' });
    const { acquire, processTable, lockText } = setUp(held);
    processTable.add(200, 'untagged');
    refused(acquire);
    expect(lockText()).toBe(held);
  });

  it('takes over the lock of a holder that has ended', () => {
    const { acquire, lockText } = setUp(JSON.stringify({ pid: 200, startTime: '2000' }));
    acquire();
    expect(lockText()).toBe(OWN);
  });

  it('takes over when the holder pid now belongs to a later process', () => {
    const { acquire, processTable, lockText } = setUp(JSON.stringify({ pid: 200, startTime: '1999' }));
    processTable.add(200, 'untagged');
    acquire();
    expect(lockText()).toBe(OWN);
  });

  it('takes over a lock it cannot read a holder from', () => {
    const { acquire, lockText } = setUp('not a lock');
    acquire();
    expect(lockText()).toBe(OWN);
  });

  it('leaves nothing but the lock behind', () => {
    const { acquire, configDir } = setUp(JSON.stringify({ pid: 200, startTime: '2000' }));
    acquire();
    expect(readdirSync(configDir)).toEqual([LOCK_FILE]);
  });

  describe('when another participant takes over the same dead lock first', () => {
    // The other participant replaces the lock between this one reading the
    // dead holder and moving it aside.
    function raced() {
      const setup = setUp(JSON.stringify({ pid: 200, startTime: '2000' }));
      const other = JSON.stringify({ pid: 300, startTime: '3000' });
      setup.processTable.onIsRunning = (process) => {
        if (process.pid === 200) {
          writeFileSync(join(setup.configDir, LOCK_FILE), other);
          setup.processTable.add(300, 'untagged');
        }
      };
      return { ...setup, other };
    }

    it('refuses to start', () => {
      const { acquire } = raced();
      expect(acquire).toThrow('another participant (pid 300) is running on');
    });

    it('leaves the other participant its lock', () => {
      const { acquire, lockText, other } = raced();
      refused(acquire);
      expect(lockText()).toBe(other);
    });
  });
});
