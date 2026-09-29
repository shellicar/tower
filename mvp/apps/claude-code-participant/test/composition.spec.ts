import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { composeConfig, findOnPath } from '../src/composition.js';

const scratch = mkdtempSync(join(tmpdir(), 'participant-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const withTool = join(scratch, 'with');
const withoutTool = join(scratch, 'without');
for (const dir of [withTool, withoutTool]) {
  mkdirSync(dir);
}
writeFileSync(join(withTool, 'setpriv'), '#!/bin/sh\n');
chmodSync(join(withTool, 'setpriv'), 0o755);
writeFileSync(join(withoutTool, 'setpriv'), 'not executable');

describe('findOnPath', () => {
  it('finds an executable on the path', () => {
    expect(findOnPath('setpriv', [withoutTool, withTool].join(delimiter))).toBe(join(withTool, 'setpriv'));
  });

  it('skips a file that is not executable', () => {
    expect(findOnPath('setpriv', withoutTool)).toBeNull();
  });

  it('is null with no path', () => {
    expect(findOnPath('setpriv', undefined)).toBeNull();
  });
});

describe('composeConfig', () => {
  const env = { NATS_URL: 'nats://127.0.0.1:31416', PARTICIPANT_CONFIG_DIR: '/agents/alpha', HOME: '/home/someone', PATH: withTool };

  it('makes a private home in the temp dir', () => {
    expect(composeConfig(env, scratch).privateHome.startsWith(join(scratch, 'tower-participant-home-'))).toBe(true);
  });

  it('makes a fresh private home each time', () => {
    expect(composeConfig(env, scratch).privateHome).not.toBe(composeConfig(env, scratch).privateHome);
  });

  it('uses setpriv from the path', () => {
    expect(composeConfig(env, scratch).setpriv).toBe(join(withTool, 'setpriv'));
  });

  it('points the shell prefix at an executable script', () => {
    expect(statSync(composeConfig(env, scratch).shellPrefix).mode & 0o111).not.toBe(0);
  });
});

describe('the real-home shell prefix', () => {
  const prefix = fileURLToPath(new URL('../bin/real-home-shell.sh', import.meta.url));

  it('runs the command with the real home', () => {
    const result = spawnSync(prefix, ['printf %s "$HOME"'], { env: { PATH: '/usr/bin:/bin', HOME: '/private/home', TOWER_REAL_HOME: '/real/home' }, encoding: 'utf8' });
    expect(result.stdout).toBe('/real/home');
  });
});
