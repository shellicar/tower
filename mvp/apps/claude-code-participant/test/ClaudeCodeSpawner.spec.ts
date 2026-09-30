import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeSpawner, PARTICIPANT_TAG, REAL_HOME_VARIABLE } from '../src/ClaudeCodeSpawner.js';
import { testConfig, testServices } from './support.js';

const SDK_SPAWN: SpawnOptions = {
  command: '/sdk/claude',
  args: ['--output-format', 'stream-json'],
  cwd: '/work/project',
  env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/agents/alpha/config', HOME: '/home/someone' },
  signal: new AbortController().signal,
};

function spawned(setpriv: string | null = '/usr/bin/setpriv') {
  const services = testServices(testConfig({ setpriv }));
  services.provider.resolve(ClaudeCodeSpawner).spawn(SDK_SPAWN);
  const spawn = services.processes.spawns[0];
  if (spawn === undefined) {
    throw new Error('nothing was spawned');
  }
  return spawn;
}

describe('ClaudeCodeSpawner', () => {
  describe('with setpriv', () => {
    it('runs Claude Code under setpriv', () => {
      expect(spawned().command).toBe('/usr/bin/setpriv');
    });

    it('asks for SIGINT when the participant dies', () => {
      expect(spawned().args).toEqual(['--pdeathsig', 'SIGINT', '--', '/sdk/claude', '--output-format', 'stream-json']);
    });
  });

  describe('without setpriv', () => {
    it('runs Claude Code directly', () => {
      expect(spawned(null).command).toBe('/sdk/claude');
    });

    it('passes the arguments unchanged', () => {
      expect(spawned(null).args).toEqual(['--output-format', 'stream-json']);
    });
  });

  describe('process group', () => {
    it('is detached into its own group', () => {
      expect(spawned().options.detached).toBe(true);
    });

    it('hides its console on Windows', () => {
      expect(spawned().options.windowsHide).toBe(true);
    });
  });

  describe('environment', () => {
    it('tags Claude Code with the config dir', () => {
      expect(spawned().options.env[PARTICIPANT_TAG]).toBe('/agents/alpha/config');
    });

    it('gives Claude Code the private home', () => {
      expect(spawned().options.env.HOME).toBe('/tmp/tower-participant-home-abc123');
    });

    it('points the login at the real ~/.claude', () => {
      expect(spawned().options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/home/someone/.claude');
    });

    it('wraps commands in the real-home shell prefix', () => {
      expect(spawned().options.env.CLAUDE_CODE_SHELL_PREFIX).toBe('/opt/participant/bin/real-home-shell.sh');
    });

    it('hands the prefix the real home', () => {
      expect(spawned().options.env[REAL_HOME_VARIABLE]).toBe('/home/someone');
    });

    it('never changes the config dir the SDK chose', () => {
      expect(spawned().options.env.CLAUDE_CONFIG_DIR).toBe('/agents/alpha/config');
    });

    it('keeps the rest of the SDK environment', () => {
      expect(spawned().options.env.PATH).toBe('/usr/bin');
    });
  });

  describe('the SDK spawn options', () => {
    it('keeps the cwd', () => {
      expect(spawned().options.cwd).toBe('/work/project');
    });

    it('forwards the abort signal', () => {
      expect(spawned().options.signal).toBe(SDK_SPAWN.signal);
    });

    it('pipes stdin and stdout for the SDK', () => {
      expect(spawned().options.stdio).toEqual(['pipe', 'pipe', 'inherit']);
    });
  });
});
