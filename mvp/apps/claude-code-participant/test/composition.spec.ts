import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { composeConfig, findOnPath } from '../src/composition.js';
import { StartupError } from '../src/startup.js';
import { startupExitOf } from './support.js';

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
  const uid = process.getuid?.();
  const configDir = join(scratch, 'agents', 'alpha');
  const env = { NATS_URL: 'nats://127.0.0.1:31416', PARTICIPANT_CONFIG_DIR: configDir, HOME: '/home/someone', PATH: withTool };
  let dirs = 0;
  /** A config dir path under the scratch dir that nothing has used yet. */
  const unused = () => join(scratch, 'config-dirs', `dir-${dirs++}`);
  const compose = (dir: string, asUid: number | undefined = uid) => composeConfig({ ...env, PARTICIPANT_CONFIG_DIR: dir }, scratch, asUid);
  const permissions = (dir: string) => statSync(dir).mode & 0o777;

  describe('the config dir', () => {
    it('is created when it does not exist yet', () => {
      const dir = unused();
      compose(dir);
      expect(statSync(dir).isDirectory()).toBe(true);
    });

    it('is created for its owner only', () => {
      const dir = unused();
      compose(dir);
      expect(permissions(dir)).toBe(0o700);
    });

    it('is tightened when others can reach it', () => {
      const dir = unused();
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      compose(dir);
      expect(permissions(dir)).toBe(0o700);
    });

    it('is tightened when only its group can reach it', () => {
      const dir = unused();
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o750);
      compose(dir);
      expect(permissions(dir)).toBe(0o700);
    });

    it('is refused when a symlink stands in its place', () => {
      const target = unused();
      const link = unused();
      mkdirSync(target, { recursive: true, mode: 0o700 });
      symlinkSync(target, link);
      expect(() => compose(link)).toThrow(`PARTICIPANT_CONFIG_DIR ${link} is not a directory`);
    });

    it('is refused when a symlink stands in its place, given with a trailing slash', () => {
      const target = unused();
      const link = unused();
      mkdirSync(target, { recursive: true, mode: 0o700 });
      symlinkSync(target, link);
      expect(() => compose(`${link}/`)).toThrow(StartupError);
    });

    it('is refused when a file stands in its place', () => {
      const file = unused();
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '');
      expect(() => compose(file)).toThrow(`PARTICIPANT_CONFIG_DIR ${file} is not a directory`);
    });

    it('is refused when another user owns it', () => {
      const dir = unused();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      expect(() => compose(dir, (uid ?? 0) + 1)).toThrow(`PARTICIPANT_CONFIG_DIR ${dir} is owned by another user`);
    });

    it('leaves the permissions of a dir another user owns alone', () => {
      const dir = unused();
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o755);
      try {
        compose(dir, (uid ?? 0) + 1);
      } catch {
        // refused
      }
      expect(permissions(dir)).toBe(0o755);
    });

    it('is refused on a platform without user ids', () => {
      expect(() => composeConfig({ ...env, PARTICIPANT_CONFIG_DIR: unused() }, scratch, undefined)).toThrow(StartupError);
    });

    it('exits as an unsupported platform when there are no user ids', () => {
      expect(startupExitOf(() => composeConfig({ ...env, PARTICIPANT_CONFIG_DIR: unused() }, scratch, undefined))).toBe('unsupportedPlatform');
    });

    it('exits as a bad environment value when a file stands in its place', () => {
      const file = unused();
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, '');
      expect(startupExitOf(() => compose(file))).toBe('badEnvironment');
    });

    it('exits as a bad environment value when another user owns it', () => {
      const dir = unused();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      expect(startupExitOf(() => compose(dir, (uid ?? 0) + 1))).toBe('badEnvironment');
    });

    it('is spelled without a trailing slash', () => {
      const dir = unused();
      expect(compose(`${dir}/`).configDir).toBe(realpathSync(dir));
    });

    it('is spelled through a symlinked parent as the real path', () => {
      const parent = unused();
      const linkedParent = unused();
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      symlinkSync(parent, linkedParent);
      expect(compose(join(linkedParent, 'alpha')).configDir).toBe(join(realpathSync(parent), 'alpha'));
    });
  });

  it('makes a private home in the temp dir', () => {
    expect(composeConfig(env, scratch, uid).privateHome.startsWith(join(scratch, 'tower-participant-home-'))).toBe(true);
  });

  it('makes a fresh private home each time', () => {
    expect(composeConfig(env, scratch, uid).privateHome).not.toBe(composeConfig(env, scratch, uid).privateHome);
  });

  it('uses setpriv from the path', () => {
    expect(composeConfig(env, scratch, uid).setpriv).toBe(join(withTool, 'setpriv'));
  });

  it('points the shell prefix at an executable script', () => {
    expect(statSync(composeConfig(env, scratch, uid).shellPrefix).mode & 0o111).not.toBe(0);
  });
});

describe('the real-home shell prefix', () => {
  const prefix = fileURLToPath(new URL('../bin/real-home-shell.sh', import.meta.url));

  it('runs the command with the real home', () => {
    const result = spawnSync(prefix, ['printf %s "$HOME"'], { env: { PATH: '/usr/bin:/bin', HOME: '/private/home', TOWER_REAL_HOME: '/real/home' }, encoding: 'utf8' });
    expect(result.stdout).toBe('/real/home');
  });
});
