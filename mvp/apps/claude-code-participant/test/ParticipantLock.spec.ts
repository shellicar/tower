import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { LOCK_FILE, ParticipantLock } from '../src/ParticipantLock.js';
import { StartupError } from '../src/startup.js';
import { startupExitOf, testConfig, testServices } from './support.js';

const scratch = mkdtempSync(join(tmpdir(), 'participant-lock-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dirs = 0;
function freshConfigDir(): string {
  return mkdtempSync(join(scratch, `config-${dirs++}-`));
}

/** A participant's lock on `configDir`, as a separate participant in this process would take it. */
function lockOn(configDir: string): () => void {
  const lock = testServices(testConfig({ configDir })).provider.resolve(ParticipantLock);
  return () => lock.acquire();
}

// Another process holding the lock the same way the participant does.
const HOLDER = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[1], { timeout: 0 });
db.exec('BEGIN EXCLUSIVE');
console.log('held');
setInterval(() => {}, 1000);
`;

let holder: ChildProcess | undefined;

async function holdInAnotherProcess(configDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER, join(configDir, LOCK_FILE)], { stdio: ['ignore', 'pipe', 'inherit'] });
  holder = child;
  const [chunk] = (await once(child.stdout, 'data')) as [Buffer];
  if (chunk.toString().trim() !== 'held') {
    throw new Error('the other process did not take the lock');
  }
  return child;
}

afterEach(async () => {
  if (holder !== undefined && holder.exitCode === null && holder.signalCode === null) {
    holder.kill('SIGKILL');
    await once(holder, 'exit');
  }
  holder = undefined;
});

describe('ParticipantLock', () => {
  it('takes the lock on a config dir nobody holds', () => {
    expect(lockOn(freshConfigDir())).not.toThrow();
  });

  it('refuses while another participant in this process holds it', () => {
    const configDir = freshConfigDir();
    lockOn(configDir)();
    expect(lockOn(configDir)).toThrow(StartupError);
  });

  it('names the config dir when it refuses', () => {
    const configDir = freshConfigDir();
    lockOn(configDir)();
    expect(lockOn(configDir)).toThrow(`another participant is running on ${configDir}`);
  });

  it('exits as the config dir being locked', () => {
    const configDir = freshConfigDir();
    lockOn(configDir)();
    expect(startupExitOf(lockOn(configDir))).toBe('configDirLocked');
  });

  it('refuses while another process holds it', async () => {
    const configDir = freshConfigDir();
    await holdInAnotherProcess(configDir);
    expect(lockOn(configDir)).toThrow(StartupError);
  });

  it('takes the lock once the process holding it has been killed', async () => {
    const configDir = freshConfigDir();
    const child = await holdInAnotherProcess(configDir);
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(lockOn(configDir)).not.toThrow();
  });

  it('takes it again from the same participant without refusing itself', () => {
    const acquire = lockOn(freshConfigDir());
    acquire();
    expect(acquire).not.toThrow();
  });
});
